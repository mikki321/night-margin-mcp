import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Decision,
  acquireStateLock,
  nextDecisionIdNumber,
  readDecisions,
  readTargets,
  stateDir,
  writeDecisions,
  writeTargets,
} from "../src/state.js";

/** Tuore tmp-statedir per testi — testit eivät koske ~/.night-marginiin. */
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nm-state-test-"));
  env = { NM_STATE_DIR: dir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const decision = (id: string, status: Decision["status"] = "proposed"): Decision => ({
  id,
  created_at: "2026-07-22T00:00:00.000Z",
  type: "gap_floor",
  property_id: "p1",
  listing_id: 11,
  channel: "hypothetical",
  currency: "EUR",
  dates: ["2026-08-04", "2026-08-05"],
  floor_price: 120,
  wh_recommended_price: 90,
  expected: { protected_nights: 2, floor_vs_rec_delta: 50 },
  status,
});

describe("stateDir", () => {
  it("käyttää NM_STATE_DIR-ympäristömuuttujaa ja luo hakemiston 700-oikeuksin", () => {
    const sub = join(dir, "nested", "state");
    const got = stateDir({ NM_STATE_DIR: sub } as NodeJS.ProcessEnv);
    expect(got).toBe(sub);
    const mode = statSync(sub).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("decisions.json luku ja kirjoitus", () => {
  it("puuttuva tiedosto → tyhjä lista", () => {
    expect(readDecisions(env)).toEqual([]);
  });

  it("roundtrip: kirjoitettu = luettu; tmp-tiedostoja ei jää (atominen rename)", () => {
    const rows = [decision("d1"), decision("d2", "applied")];
    writeDecisions(rows, env);
    expect(readDecisions(env)).toEqual(rows);
    // atomisuus: hakemistossa vain lopullinen tiedosto, ei tmp-jäänteitä
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(dir)).toContain("decisions.json");
  });

  it("uudelleenkirjoitus korvaa sisällön kokonaan", () => {
    writeDecisions([decision("d1")], env);
    writeDecisions([decision("d2")], env);
    expect(readDecisions(env).map((d) => d.id)).toEqual(["d2"]);
  });

  it("korruptoitunut tiedosto → selkeä virhe toimintaohjeella", () => {
    writeFileSync(join(dir, "decisions.json"), "{not json");
    expect(() => readDecisions(env)).toThrow(/decision log.*fix or delete the file/s);
  });

  it("ei-array-sisältö → selkeä virhe", () => {
    writeFileSync(join(dir, "decisions.json"), '{"decisions": []}');
    expect(() => readDecisions(env)).toThrow(/must contain a JSON array/);
  });
});

describe("targets.json luku ja kirjoitus", () => {
  it("roundtrip ja puuttuva tiedosto", () => {
    expect(readTargets(env)).toEqual([]);
    const targets = [
      { property_id: "p1", month: "2026-08", gross_target: 6000, set_at: "2026-07-22T00:00:00.000Z" },
    ];
    writeTargets(targets, env);
    expect(readTargets(env)).toEqual(targets);
    // kirjoitus on ihmisluettavaa JSONia
    expect(readFileSync(join(dir, "targets.json"), "utf8")).toContain('"gross_target": 6000');
  });
});

describe("acquireStateLock — rinnakkaisten sessioiden read-modify-write-suoja (regressio: lost update)", () => {
  /** Lyhyt timeout testissä — tuotannon 5 s odotus ei sovi testiajoon. */
  const fastEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({ NM_STATE_DIR: dir, NM_LOCK_TIMEOUT_MS: "250", ...over }) as NodeJS.ProcessEnv;

  it("lukko pitää: toinen acquire aikakatkeaa selkeällä virheellä kunnes release", async () => {
    const release = await acquireStateLock(fastEnv());
    expect(existsSync(join(dir, ".lock"))).toBe(true);

    await expect(acquireStateLock(fastEnv())).rejects.toThrow(
      /locked by another night-margin session/,
    );

    release();
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    const release2 = await acquireStateLock(fastEnv());
    release2();
  });

  it("release on idempotentti — kahdesti kutsuminen ei kaada", async () => {
    const release = await acquireStateLock(fastEnv());
    release();
    expect(() => release()).not.toThrow();
  });

  it("kaatuneen prosessin vanha lukko siivotaan iän perusteella", async () => {
    const lock = join(dir, ".lock");
    mkdirSync(lock);
    const past = (Date.now() - 60_000) / 1000; // 60 s vanha > stale-raja 100 ms
    utimesSync(lock, past, past);

    const release = await acquireStateLock(fastEnv({ NM_LOCK_STALE_MS: "100" }));
    release();
    expect(existsSync(lock)).toBe(false);
  });
});

describe("nextDecisionIdNumber", () => {
  it("juoksee koko lokin yli (myös applied/reverted) eikä uudelleenkäytä id:itä", () => {
    expect(nextDecisionIdNumber([])).toBe(1);
    expect(nextDecisionIdNumber([decision("d1"), decision("d7", "reverted"), decision("d3")])).toBe(8);
  });

  it("tuntemattomat id-muodot ohitetaan", () => {
    expect(nextDecisionIdNumber([decision("custom-id"), decision("d2")])).toBe(3);
  });
});
