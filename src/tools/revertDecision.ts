import { z } from "zod";
import { datesToRanges } from "../core/decisions.js";
import { acquireStateLock, readDecisions, writeDecisions } from "../state.js";
import {
  CUSTOM_RATE_WEEKDAYS,
  type WhCustomRate,
  WheelhouseClient,
  WheelhouseHttpError,
} from "../wheelhouse/client.js";

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan. */
export const revertDecisionInputSchema = {
  decision_id: z.string().min(1).describe('Decision id to revert, e.g. "d2"'),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to actually delete the written rates — without it you get a preview"),
};

export interface RevertArgs {
  decision_id: string;
  confirm?: boolean;
}

/** Injektoitava client testejä varten — tuotannossa rakennetaan env:stä. */
export interface RevertDeps {
  client?: WheelhouseClient;
}

/**
 * Poimii snapshotin custom rate -rivistä VAIN verifioidut PUT-body-kentät
 * (start_date, end_date, rate_type, currency, viikonpäivät) — palautus tehdään
 * täsmälleen sillä muodolla jonka PUT hyväksyy (esim. expires_at jää pois).
 */
export function restoreBodyFromSnapshot(rate: WhCustomRate): Record<string, unknown> | undefined {
  if (typeof rate.start_date !== "string" || typeof rate.end_date !== "string") return undefined;
  const body: Record<string, unknown> = {};
  for (const field of ["start_date", "end_date", "rate_type", "currency", ...CUSTOM_RATE_WEEKDAYS]) {
    if (rate[field] !== undefined && rate[field] !== null) body[field] = rate[field];
  }
  return body;
}

/** Leikkaavatko [a.start, a.end) ja [b.start, b.end) — end_date on eksklusiivinen. */
function rangesOverlap(
  a: { start_date: string; end_date: string },
  b: { start_date: string; end_date: string },
): boolean {
  return a.start_date < b.end_date && a.end_date > b.start_date;
}

/**
 * Peruu sovelletun päätöksen: DELETE kirjoitetut rangeat ja palauta snapshotin
 * aiemmat custom ratet jos niitä oli kirjoitettujen rangejen kohdalla.
 */
export async function runRevertDecision(
  args: RevertArgs,
  env: NodeJS.ProcessEnv = process.env,
  deps: RevertDeps = {},
): Promise<string> {
  const decisions = readDecisions(env);
  const decision = decisions.find((d) => d.id === args.decision_id);
  if (!decision) {
    throw new Error(
      `Decision "${args.decision_id}" not found in the decision log — run propose_decisions to see current proposals.`,
    );
  }
  if (decision.status === "reverted") {
    return `Decision ${decision.id} was already reverted at ${decision.reverted_at ?? "an earlier time"} — nothing to do.`;
  }

  // Perutaan vain oikeasti kirjoitetut rangeat (osittainen apply mukaan lukien).
  // Fallback vanhoille applied-riveille ilman applied_ranges-kenttää: johdetaan öistä.
  const writtenRanges =
    decision.applied_ranges && decision.applied_ranges.length > 0
      ? decision.applied_ranges
      : decision.status === "applied"
        ? datesToRanges(decision.dates)
        : [];
  if (writtenRanges.length === 0) {
    throw new Error(
      `Decision ${decision.id} has not been applied (status: ${decision.status}) — there is nothing to revert.`,
    );
  }
  const ranges = writtenRanges;
  const priorRates = (decision.snapshot?.prior_custom_rates ?? []).filter(
    (rate): rate is WhCustomRate & { start_date: string; end_date: string } =>
      typeof rate.start_date === "string" &&
      typeof rate.end_date === "string" &&
      ranges.some((r) => rangesOverlap({ start_date: rate.start_date as string, end_date: rate.end_date as string }, r)),
  );

  if (args.confirm !== true) {
    return [
      `## Revert preview — decision ${decision.id} (nothing changed)`,
      `This would DELETE ${ranges.length} custom rate range${ranges.length === 1 ? "" : "s"} from listing ${decision.listing_id} (channel ${decision.channel}):`,
      ranges.map((r) => `- ${r.start_date} → ${r.end_date}`).join("\n"),
      priorRates.length > 0
        ? `It would then restore ${priorRates.length} prior custom rate${priorRates.length === 1 ? "" : "s"} from the snapshot taken before the write.`
        : "No prior custom rates overlapped these dates — after the delete, Wheelhouse recommendations take over again.",
      `To execute: revert_decision {"decision_id": "${decision.id}", "confirm": true}`,
    ].join("\n\n");
  }

  const key = env.WHEELHOUSE_API_KEY?.trim();
  if (!key && !deps.client) {
    throw new Error(
      "Reverting decisions requires WHEELHOUSE_API_KEY — set it in the environment and try again.",
    );
  }
  const client =
    deps.client ?? new WheelhouseClient({ apiKey: key!, baseUrl: env.WHEELHOUSE_API_URL });

  // Lukko koko peruutuspolun ajaksi + tuore tila lukon alla (sama syy kuin applyssä).
  const release = await acquireStateLock(env);
  try {
    const freshDecisions = readDecisions(env);
    const fresh = freshDecisions.find((d) => d.id === args.decision_id);
    if (!fresh) {
      throw new Error(`Decision "${args.decision_id}" disappeared from the decision log — nothing reverted.`);
    }
    if (fresh.status === "reverted") {
      return `Decision ${fresh.id} was already reverted at ${fresh.reverted_at ?? "an earlier time"} — nothing to do.`;
    }

    // 1) DELETE kirjoitetut rangeat. 404 = range jo poissa → lasketaan poistetuksi.
    const deleted: string[] = [];
    for (const range of ranges) {
      try {
        await client.deleteCustomRates(
          fresh.listing_id,
          fresh.channel,
          range.start_date,
          range.end_date,
        );
        deleted.push(`${range.start_date} → ${range.end_date}`);
      } catch (e) {
        if (e instanceof WheelhouseHttpError && e.status === 404) {
          deleted.push(`${range.start_date} → ${range.end_date} (was already gone)`);
          continue;
        }
        throw new Error(
          `Delete failed after ${deleted.length} of ${ranges.length} range${ranges.length === 1 ? "" : "s"}: ${(e as Error).message}. ` +
            (deleted.length > 0 ? `Deleted so far: ${deleted.join(", ")}. ` : "") +
            `Re-run revert_decision {"decision_id": "${fresh.id}", "confirm": true} to finish.`,
        );
      }
    }

    // 2) Palauta snapshotin aiemmat ratet kirjoitettujen rangejen kohdalta.
    const restored: string[] = [];
    const restoreNotes: string[] = [];
    let restoreFailures = 0;
    for (const rate of priorRates) {
      const body = restoreBodyFromSnapshot(rate);
      if (!body) {
        restoreNotes.push("one snapshot entry was missing start/end dates — skipped");
        continue;
      }
      try {
        await client.putCustomRateBody(fresh.listing_id, fresh.channel, body);
        restored.push(`${rate.start_date} → ${rate.end_date}`);
      } catch (e) {
        restoreFailures++;
        restoreNotes.push(
          `failed to restore prior rate ${rate.start_date} → ${rate.end_date} (${(e as Error).message})`,
        );
      }
    }

    // 3) Status + loki. "reverted" VAIN jos kaikki palautukset onnistuivat —
    //    muuten status säilyy ja revertin voi ajaa uudelleen (deletet sietävät
    //    404:n, palautukset ovat idempotentteja upsertteja).
    if (restoreFailures === 0) {
      fresh.status = "reverted";
      fresh.reverted_at = new Date().toISOString();
      writeDecisions(freshDecisions, env);
    }

    return [
      restoreFailures === 0
        ? `## Reverted decision ${fresh.id} — ${fresh.property_id}`
        : `## Partially reverted decision ${fresh.id} — ${fresh.property_id}`,
      `Deleted ${deleted.length} custom rate range${deleted.length === 1 ? "" : "s"} from listing ${fresh.listing_id} (channel ${fresh.channel}):`,
      deleted.map((d) => `- ${d}`).join("\n"),
      restored.length > 0
        ? `Restored ${restored.length} prior custom rate${restored.length === 1 ? "" : "s"} from the snapshot:\n${restored.map((r) => `- ${r}`).join("\n")}`
        : priorRates.length === 0
          ? "No prior custom rates to restore — Wheelhouse recommendations take over these nights again."
          : "No prior custom rates were restored yet.",
      ...(restoreNotes.length > 0 ? [`Notes: ${restoreNotes.join(" · ")}`] : []),
      ...(restoreFailures > 0
        ? [
            `${restoreFailures} prior rate${restoreFailures === 1 ? "" : "s"} could not be restored, so the decision is still marked "${fresh.status}". ` +
              `Re-run revert_decision {"decision_id": "${fresh.id}", "confirm": true} to retry the restore.`,
          ]
        : []),
    ].join("\n\n");
  } finally {
    release();
  }
}
