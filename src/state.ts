/**
 * Paikallinen tila: päätösloki (decisions.json) ja kuukausitavoitteet
 * (targets.json). Hakemisto = env NM_STATE_DIR tai ~/.night-margin —
 * npx-asennus on efemeraalinen, joten stateä EI säilötä pakettihakemistoon
 * (turvasääntö 4). Kirjoitukset ovat atomisia (tmp + rename samassa
 * hakemistossa), jotta keskeytynyt kirjoitus ei koskaan korruptoi lokia.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DecisionStatus = "proposed" | "applied" | "reverted";

/** Rehellinen vaikutusarvio — EI kuvitteellista tuottolupausta. */
export interface DecisionExpected {
  /** Montako yötä ehdotus suojaa alle omakustannehinnan myynniltä. */
  protected_nights: number;
  /** Σ(floor_price − suositus) ehdotuksen öiltä, € — kuinka paljon lattian alla suositukset ovat. */
  floor_vs_rec_delta: number;
}

export interface Decision {
  /** Lyhyt juokseva id: d1, d2, … — ei koskaan uudelleenkäytetä. */
  id: string;
  /** ISO-aikaleima. */
  created_at: string;
  type: "gap_floor";
  property_id: string;
  listing_id: string | number;
  /** Listingin OMA channel-kenttä (EI env-yliajoa) — kirjoitukset VAIN tälle (turvasääntö 5). */
  channel: string;
  /** Kirjoitettavien ratejen valuutta listingistä; puuttuessa "EUR". */
  currency?: string;
  /** Ehdotuksen yöt, YYYY-MM-DD (peräkkäisiä). */
  dates: string[];
  /** Lattiahinta €/yö johon yöt nostetaan (pyöristetty ylös kokonaiseuroon). */
  floor_price: number;
  /** Matalin WH-suositus (tai demo-estimaatti) ehdotuksen öiltä, €. */
  wh_recommended_price: number;
  expected: DecisionExpected;
  status: DecisionStatus;
  applied_at?: string;
  reverted_at?: string;
  /** Wheelhouseen oikeasti kirjoitetut rangeat (apply täyttää; revert käyttää). */
  applied_ranges?: { start_date: string; end_date: string }[];
  /** Aiempi tila ENNEN kirjoitusta (turvasääntö 3) — revert palauttaa tästä. */
  snapshot?: { prior_custom_rates: Record<string, unknown>[] };
}

export interface Target {
  property_id: string;
  /** YYYY-MM */
  month: string;
  /** Kuukauden bruttotavoite, €. */
  gross_target: number;
  set_at: string;
}

const DECISIONS_FILE = "decisions.json";
const TARGETS_FILE = "targets.json";

/** State-hakemisto: env NM_STATE_DIR tai ~/.night-margin. Luodaan tarvittaessa (700). */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.NM_STATE_DIR?.trim() || join(homedir(), ".night-margin");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJsonArray<T>(file: string, what: string): T[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(
      `Failed to read the ${what} (${file}): ${(e as Error).message} — fix or delete the file`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`The ${what} (${file}) must contain a JSON array — fix or delete the file`);
  }
  return parsed as T[];
}

/** Atominen kirjoitus: tmp-tiedosto samaan hakemistoon + rename (POSIX-atominen). */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readDecisions(env: NodeJS.ProcessEnv = process.env): Decision[] {
  return readJsonArray<Decision>(join(stateDir(env), DECISIONS_FILE), "decision log");
}

export function writeDecisions(decisions: Decision[], env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(join(stateDir(env), DECISIONS_FILE), decisions);
}

export function readTargets(env: NodeJS.ProcessEnv = process.env): Target[] {
  return readJsonArray<Target>(join(stateDir(env), TARGETS_FILE), "targets file");
}

export function writeTargets(targets: Target[], env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(join(stateDir(env), TARGETS_FILE), targets);
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Advisory-lukko rinnakkaisia sessioita vastaan (mkdir on atominen). Suojaa
 * apply/revertin read-modify-write-syklit: ilman lukkoa kaksi sessiota voisi
 * hävittää toistensa kirjoitukset tai pahimmillaan ottaa snapshotin toisen
 * session jo kirjoittamista lattiahinnoista. Kaatuneen prosessin lukko
 * siivotaan iän perusteella (stale > 2 min).
 */
export async function acquireStateLock(env: NodeJS.ProcessEnv = process.env): Promise<() => void> {
  const lock = join(stateDir(env), ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return () => {
        try {
          rmdirSync(lock);
        } catch {
          /* jo vapautettu */
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          try {
            rmdirSync(lock);
          } catch {
            /* toinen sessio ehti siivota */
          }
          continue;
        }
      } catch {
        continue; // lukko ehti kadota — yritä heti uudelleen
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The decision log is locked by another night-margin session (${lock}). ` +
            "Wait for it to finish, or delete the .lock directory if no other session is running.",
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/** Seuraava juokseva päätös-id koko lokin yli (myös applied/reverted) — id:tä ei uudelleenkäytetä. */
export function nextDecisionIdNumber(decisions: Decision[]): number {
  let max = 0;
  for (const d of decisions) {
    const m = /^d(\d+)$/.exec(d.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
