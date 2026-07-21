import { z } from "zod";
import { datesToRanges } from "../core/decisions.js";
import { type Decision, readDecisions, writeDecisions } from "../state.js";
import { CUSTOM_RATE_WEEKDAYS, WheelhouseClient } from "../wheelhouse/client.js";

const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan. */
export const applyDecisionInputSchema = {
  decision_id: z.string().min(1).describe('Decision id from propose_decisions, e.g. "d2"'),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to actually write to Wheelhouse — without it you get a dry-run preview"),
  dry_run: z
    .boolean()
    .optional()
    .describe("Preview the exact payload without writing (default: true unless confirm=true)"),
};

export interface ApplyArgs {
  decision_id: string;
  confirm?: boolean;
  dry_run?: boolean;
}

/** Injektoitava client testejä varten — tuotannossa rakennetaan env:stä. */
export interface ApplyDeps {
  client?: WheelhouseClient;
}

/** Verifioitu PUT-body (wh-write-api-spec): fixed + kaikki 7 viikonpäivää samaan hintaan. */
export function buildRatePayload(
  range: { start_date: string; end_date: string },
  price: number,
  currency: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    start_date: range.start_date,
    end_date: range.end_date,
    rate_type: "fixed",
    currency,
  };
  for (const day of CUSTOM_RATE_WEEKDAYS) body[day] = price;
  return body;
}

function findDecision(decisions: Decision[], id: string): Decision {
  const decision = decisions.find((d) => d.id === id);
  if (!decision) {
    const proposed = decisions.filter((d) => d.status === "proposed").map((d) => d.id);
    throw new Error(
      `Decision "${id}" not found in the decision log.` +
        (proposed.length > 0
          ? ` Currently proposed: ${proposed.join(", ")}.`
          : " No proposals exist yet — run propose_decisions first."),
    );
  }
  return decision;
}

/**
 * Soveltaa ehdotetun päätöksen Wheelhouseen. Turvasäännöt:
 * - dry_run on oletuksena TRUE ilman confirmia → näyttää TARKAN payloadin;
 *   esikatselu EI vaadi avainta eikä kirjoita mitään (myös mock-tilassa)
 * - oikea kirjoitus vaatii confirm=true (+ avain, ei-mock-päätös)
 * - aiemmat custom ratet snapshotataan päätöslokiin ENNEN kirjoitusta —
 *   vain kerran per päätös: uusintayritys ei ylikirjoita aitoa aiempaa tilaa
 * - kirjoitukset vain päätökseen tallennetulle kanavalle (listingin oma kanava)
 */
export async function runApplyDecision(
  args: ApplyArgs,
  env: NodeJS.ProcessEnv = process.env,
  deps: ApplyDeps = {},
): Promise<string> {
  const decisions = readDecisions(env);
  const decision = findDecision(decisions, args.decision_id);

  if (decision.status === "applied") {
    return (
      `Decision ${decision.id} was already applied at ${decision.applied_at ?? "an earlier time"} — nothing to do. ` +
      `Undo it with: revert_decision {"decision_id": "${decision.id}", "confirm": true}`
    );
  }
  if (decision.status === "reverted") {
    return (
      `Decision ${decision.id} was applied and then reverted at ${decision.reverted_at ?? "an earlier time"}. ` +
      `Run propose_decisions again for fresh proposals.`
    );
  }

  const currency = decision.currency?.trim() || "EUR";
  const ranges = datesToRanges(decision.dates);
  const payloads = ranges.map((r) => buildRatePayload(r, decision.floor_price, currency));
  const urlPath = `/listings/${decision.listing_id}/custom_rates?channel=${decision.channel}`;
  const isMockDecision = decision.channel === "mock" || decision.listing_id === "mock";

  // Dry run ENNEN avain-/mock-tarkistuksia: esikatselu ei tarvitse avainta
  // eikä kirjoita mitään — demopolku (mock-tila ilman avainta) toimii aina.
  const dryRun = args.dry_run ?? args.confirm !== true;
  if (dryRun || args.confirm !== true) {
    const payloadBlocks = payloads
      .map((p) => `PUT ${urlPath}\n${JSON.stringify(p, null, 2)}`)
      .join("\n\n");
    return [
      `## Dry run — decision ${decision.id} (nothing written)`,
      `Listing ${decision.listing_id} (${decision.property_id}) · channel ${decision.channel}`,
      `This would write ${ranges.length} custom rate range${ranges.length === 1 ? "" : "s"}:\n\n${payloadBlocks}`,
      `Effect: fixes ${decision.dates.length} gap night${decision.dates.length === 1 ? "" : "s"} at ${eur(decision.floor_price)}/night ` +
        `(current recommendation from ${eur(decision.wh_recommended_price)}) — protects them from selling below cost. ` +
        `Prior custom rates are snapshotted first, so this can be undone with revert_decision.`,
      ...(isMockDecision
        ? [
            "Note: this proposal was made from demo data — applying it for real requires WHEELHOUSE_API_KEY " +
              "and a fresh propose_decisions run against your own portfolio.",
          ]
        : []),
      `Nothing has been written. To execute: apply_decision {"decision_id": "${decision.id}", "confirm": true}`,
    ].join("\n\n");
  }

  // Kirjoituspolku (confirm=true): avain ja oikeasta datasta ehdotettu päätös vaaditaan.
  const key = env.WHEELHOUSE_API_KEY?.trim();
  if (!key && !deps.client) {
    throw new Error(
      "Applying decisions requires WHEELHOUSE_API_KEY — set it in the environment and try again. " +
        "Without a key the proposals are demo-only.",
    );
  }
  if (isMockDecision) {
    throw new Error(
      `Decision ${decision.id} was proposed from demo data and cannot be applied to Wheelhouse. ` +
        "Set WHEELHOUSE_API_KEY and run propose_decisions again to get applicable proposals.",
    );
  }

  const client =
    deps.client ?? new WheelhouseClient({ apiKey: key!, baseUrl: env.WHEELHOUSE_API_URL });

  // 1) Snapshot aiemmasta tilasta päätöslokiin ENNEN kirjoitusta (turvasääntö 3) —
  //    VAIN jos snapshotia ei jo ole: uusintayritys osittaisen kirjoitusvirheen
  //    jälkeen ei saa ylikirjoittaa aitoa aiempaa tilaa työkalun omilla
  //    lattiahinnoilla (revert palauttaisi silloin väärän tilan).
  if (!decision.snapshot) {
    const prior = await client.getCustomRates(decision.listing_id, decision.channel);
    decision.snapshot = { prior_custom_rates: prior };
    writeDecisions(decisions, env);
  }

  // 2) Kirjoitukset sarjassa; virhe kesken → kerro mitkä menivät läpi ja miten perutaan.
  const written: { start_date: string; end_date: string }[] = [];
  try {
    for (const range of ranges) {
      await client.putCustomRate(decision.listing_id, decision.channel, {
        start_date: range.start_date,
        end_date: range.end_date,
        price: decision.floor_price,
        currency,
      });
      written.push(range);
    }
  } catch (e) {
    decision.applied_ranges = written;
    writeDecisions(decisions, env);
    const progress =
      written.length > 0
        ? `Ranges already written: ${written.map((r) => `${r.start_date}→${r.end_date}`).join(", ")}. ` +
          `Roll them back with: revert_decision {"decision_id": "${decision.id}", "confirm": true}`
        : "Nothing was written — it is safe to retry apply_decision.";
    throw new Error(
      `Write failed after ${written.length} of ${ranges.length} range${ranges.length === 1 ? "" : "s"}: ${(e as Error).message}. ${progress}`,
    );
  }

  // 3) Verifiointi: GET ja tarkista että kirjoitetut rangeat näkyvät.
  let verifyNote: string;
  try {
    const after = await client.getCustomRates(decision.listing_id, decision.channel);
    const visible = ranges.filter((range) =>
      after.some((cr) => cr.start_date === range.start_date && cr.end_date === range.end_date),
    );
    verifyNote =
      visible.length === ranges.length
        ? `Verified: ${visible.length}/${ranges.length} written range${ranges.length === 1 ? "" : "s"} visible in Wheelhouse.`
        : `Warning: only ${visible.length}/${ranges.length} written ranges are visible in Wheelhouse — check the listing in the Wheelhouse UI.`;
  } catch (e) {
    verifyNote = `Verification read failed (${(e as Error).message}) — the writes themselves succeeded.`;
  }

  // 4) Status + loki.
  decision.status = "applied";
  decision.applied_at = new Date().toISOString();
  decision.applied_ranges = written;
  writeDecisions(decisions, env);

  return [
    `## Applied decision ${decision.id} — ${decision.property_id}`,
    `Wrote ${written.length} custom rate range${written.length === 1 ? "" : "s"} at ${eur(decision.floor_price)}/night (${currency}) to listing ${decision.listing_id} on channel ${decision.channel}:`,
    written.map((r) => `- ${r.start_date} → ${r.end_date}`).join("\n"),
    verifyNote,
    `${decision.dates.length} night${decision.dates.length === 1 ? "" : "s"} now priced at your cost floor instead of below it. ` +
      `Undo anytime with: revert_decision {"decision_id": "${decision.id}", "confirm": true}`,
  ].join("\n\n");
}
