import { z } from "zod";
import { minMargin as minMarginFromEnv } from "../config.js";
import type { GapFloorProposal } from "../core/decisions.js";
import { DEFAULT_RISK_PRESET, type RiskPreset, riskAdjustedMargin } from "../core/risk.js";
import { WheelhouseClient } from "../wheelhouse/client.js";
import {
  gatherGapFloorProposals,
  type ProposeArgs,
  type ProposeDeps,
} from "./proposeDecisions.js";

/**
 * margin_copilot — READ-ONLY päätösavustaja.
 *
 * Ei uutta laskentaa: käyttää täsmälleen samaa dataa kuin propose_decisions
 * (gatherGapFloorProposals), mutta EI tallenna eikä kirjoita mitään. Ryhmittää
 * alle-lattian aukkoyöt kohteittain "rahaliikkeiksi", järjestää ne altistuksen
 * mukaan ja punnitsee jokaiselle vaihtoehdot — yksi merkitty suositelluksi.
 *
 * REHELLISYYSPERIAATE: ainoat €-luvut ovat LASKETTUJA (alle-lattian altistus,
 * lattiatasot), EI arvattuja. Tietoisesti EI "30-day net vs holding" -tyyppisiä
 * deltoja: ne vaatisivat täyttötodennäköisyyden lattiahinnalla, jota datassa ei
 * ole. Myymätön yö ei tuota kummallakaan vaihtoehdolla — sitä ei väitetä
 * voitoksi. Copilot vain suosittelee; jokainen kirjoitus kulkee yhä
 * propose_decisions → apply_decision -polun Preview + confirm -portin kautta.
 */

export const marginCopilotInputSchema = {
  from: z
    .string()
    .optional()
    .describe(
      "Earliest night to scan, YYYY-MM-DD. Optional — defaults to the next 30 days (the horizon Wheelhouse price recommendations cover).",
    ),
  to: z
    .string()
    .optional()
    .describe("Latest night to scan, YYYY-MM-DD. Optional — defaults to the next 30 days."),
  risk: z
    .enum(["conservative", "recommended", "aggressive"])
    .optional()
    .describe(
      "Risk preset for the cost floor (margin multiplier). Defaults to 'recommended'. Same presets as propose_decisions.",
    ),
};

export interface MarginCopilotArgs {
  from?: string;
  to?: string;
  risk?: RiskPreset;
}

export interface MarginCopilotDeps {
  client?: WheelhouseClient;
  now?: Date;
}

const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};

/** Yhden kohteen kaikki alle-lattian jonot yhdeksi rahaliikkeeksi. */
interface Move {
  property_id: string;
  clusters: GapFloorProposal[];
  nights: number;
  exposure: number; // Σ floor_vs_rec_delta
  floor_min: number;
  floor_max: number;
  rec_min: number;
  rec_max: number;
  min_stay: number; // pienin jonon min_stay (1 = ei sääntöä millään jonolla)
  longest_cluster: number; // pisin peräkkäinen jono (min-stay-vivun kelpoisuus)
}

export function buildMoves(proposals: GapFloorProposal[]): Move[] {
  const byProp = new Map<string, GapFloorProposal[]>();
  for (const p of proposals) {
    const arr = byProp.get(p.property_id);
    if (arr) arr.push(p);
    else byProp.set(p.property_id, [p]);
  }

  const moves: Move[] = [];
  for (const [property_id, clusters] of byProp) {
    const nights = clusters.reduce((s, c) => s + c.protected_nights, 0);
    const exposure = clusters.reduce((s, c) => s + c.floor_vs_rec_delta, 0);
    moves.push({
      property_id,
      clusters,
      nights,
      exposure,
      floor_min: Math.min(...clusters.map((c) => c.floor_price)),
      floor_max: Math.max(...clusters.map((c) => c.floor_price)),
      rec_min: Math.min(...clusters.map((c) => c.rec_min)),
      rec_max: Math.max(...clusters.map((c) => c.rec_max)),
      min_stay: Math.min(...clusters.map((c) => c.min_stay)),
      longest_cluster: Math.max(...clusters.map((c) => c.dates.length)),
    });
  }

  // Järjestä altistuksen mukaan laskevasti (suurin rahaliike ensin);
  // tie-break yömäärä, sitten nimi — deterministinen.
  moves.sort((a, b) => {
    if (b.exposure !== a.exposure) return b.exposure - a.exposure;
    if (b.nights !== a.nights) return b.nights - a.nights;
    return a.property_id < b.property_id ? -1 : a.property_id > b.property_id ? 1 : 0;
  });
  return moves;
}

const floorLabel = (m: Move): string =>
  m.floor_min === m.floor_max ? eur(m.floor_min) : `${eur(m.floor_min)}–${eur(m.floor_max)}`;
const recLabel = (m: Move): string =>
  m.rec_min === m.rec_max ? eur(m.rec_min) : `${eur(m.rec_min)}–${eur(m.rec_max)}`;

function renderMove(m: Move, i: number): string {
  const nightWord = m.nights === 1 ? "night" : "nights";
  const lines: string[] = [];
  lines.push(`### ${i + 1}. ${m.property_id} — ${m.nights} upcoming ${nightWord} priced below cost`);
  lines.push(
    `Wheelhouse recommends ${recLabel(m)} on these nights; your cost floor is ${floorLabel(m)}. ` +
      `Below-floor exposure: **${eur(m.exposure)}** — the gap between the price on offer and what those nights cost to produce.`,
  );

  // Vaihtoehdot punnittuna. Vain LASKETUT luvut; ei arvattua nettodeltaa.
  lines.push(``);
  lines.push(
    `- **Hold** — keep the current recommendation. Every night that sells at ${recLabel(m)} loses money against your ${floorLabel(m)} floor; ${eur(m.exposure)} of below-floor exposure stays on the table.`,
  );
  lines.push(
    `- **Guard the floor** _(recommended)_ — stage a floor of ${floorLabel(m)} on these nights. The night clears at the floor or stays open — either way no below-cost sale. Trade-off: nights that would only clear below the floor stay empty (an empty night earns nothing either way).`,
  );
  if (m.min_stay < 2 && m.longest_cluster >= 3) {
    const stay = Math.min(3, m.longest_cluster);
    const lowered = Math.ceil(m.floor_min / stay);
    lines.push(
      `- **Raise the minimum stay** — set a ${stay}-night minimum on these dates: the same turnover spreads over ${stay} nights and the floor falls to about ${eur(lowered)}. Trade-off: you turn away shorter bookings.`,
    );
  }
  lines.push(``);
  lines.push(
    `Stage the recommended move: run \`propose_decisions\` for this window, then \`apply_decision {"decision_id": "…", "confirm": true}\` — the write is previewed first and needs an explicit confirm.`,
  );
  return lines.join("\n");
}

export async function runMarginCopilot(
  args: MarginCopilotArgs,
  env: NodeJS.ProcessEnv = process.env,
  deps: MarginCopilotDeps = {},
): Promise<string> {
  const risk: RiskPreset = args.risk ?? DEFAULT_RISK_PRESET;
  const adjustedMargin = riskAdjustedMargin(minMarginFromEnv(env), risk);

  // Sama datanhaku kuin propose_decisions — mutta EI tallenneta (read-only).
  const proposeArgs: ProposeArgs = { from: args.from, to: args.to, risk };
  const proposeDeps: ProposeDeps = { client: deps.client, now: deps.now };
  const result = await gatherGapFloorProposals(proposeArgs, env, proposeDeps, adjustedMargin);

  const header = `## Margin Copilot`;
  const scope =
    `Reads the same figures as propose_decisions, ranks where money moves the most, and weighs the ` +
    `options for each — one marked recommended. **Nothing here writes prices.** Staging a move routes ` +
    `to propose_decisions → apply_decision, where every write is previewed and needs an explicit confirm.`;

  if (result.blocked === "entirely-past") {
    return [
      header,
      `The window ${result.from} → ${result.to} is entirely in the past — pricing decisions apply to future nights.`,
    ].join("\n\n");
  }
  if (result.blocked === "no-reservations") {
    return [
      header,
      scope,
      `No reservations found in ${result.from} → ${result.to}, so there are no gap nights to weigh. Check the data source and the dates.`,
    ].join("\n\n");
  }

  const moves = buildMoves(result.proposals);
  const windowLine = `Window: ${result.from} → ${result.to}${result.isDefault ? " (next 30 days)" : ""}`;

  if (moves.length === 0) {
    const parts = [header, scope, windowLine];
    parts.push(
      `**No money-moves right now — nothing in this window is priced below your cost floor.** ` +
        `That is the good outcome: every gap night on offer at least covers what it costs to produce.`,
    );
    // Rehellinen horisonttihuomautus (WH-suositukset kattavat ~30 yötä).
    if (result.priceHorizon && result.priceHorizon < result.to) {
      parts.push(
        `Checked through ${result.priceHorizon} — Wheelhouse price recommendations cover a rolling ~30-night horizon, so nights after that had no price to weigh.`,
      );
    }
    return parts.join("\n\n");
  }

  const totalExposure = moves.reduce((s, m) => s + m.exposure, 0);
  const totalNights = moves.reduce((s, m) => s + m.nights, 0);
  const moveWord = moves.length === 1 ? "money-move" : "money-moves";

  const parts = [header, scope, windowLine];
  parts.push(
    `**${moves.length} ${moveWord} · ${eur(totalExposure)} total below-floor exposure across ${totalNights} night${totalNights === 1 ? "" : "s"}, ranked by exposure.** ` +
      `Exposure is the gap between price and cost — not a forecast of lost revenue, since an unsold night earns nothing either way.`,
  );
  parts.push(moves.map((m, i) => renderMove(m, i)).join("\n\n"));
  if (result.priceHorizon && result.priceHorizon < result.to) {
    parts.push(
      `Checked through ${result.priceHorizon} only — Wheelhouse price recommendations cover a rolling ~30-night horizon; nights after that had no price to weigh and are not in this list.`,
    );
  }
  return parts.join("\n\n");
}
