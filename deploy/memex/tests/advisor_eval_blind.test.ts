/**
 * The advisor's eval-blind collector, against a real PGLite brain.
 *
 * The condition it guards is a quiet one: the nightly probe replays an empty
 * eval set, scores 0/0, and records `ok:true`. Forty of those in a row look
 * identical to forty healthy runs. So the assertions here are about telling
 * the two apart — and about the streak counting only the nights since the last
 * run that actually scored something, not every zero row ever written.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { collectEvalBlind } from "../src/core/advisor/collectors.ts";
import { recordQuery } from "../src/core/eval-replay.ts";
import { runDoctor } from "../src/commands/doctor.ts";
import type { AdvisorContext } from "../src/core/advisor/types.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-eval-blind-"));
let storage: Storage;

function ctx(): AdvisorContext {
  return { engine: storage.raw(), version: "1.2.3", now: new Date("2026-08-12T00:00:00.000Z") };
}

/** Append one snapshot row. `total` 0 = the empty-eval-set run. */
async function snapshot(day: string, total: number, scored = total): Promise<void> {
  await storage.raw().query(
    `INSERT INTO eval_snapshots (ran_at, total_queries, scored, mean_rr, hit_rate, detail)
     VALUES ($1::timestamptz, $2, $3, $4, $5, '{"ok":true}'::jsonb)`,
    [`2026-08-${day}T02:30:00.000Z`, total, scored, total === 0 ? 0 : 0.8, total === 0 ? 0 : 0.9],
  );
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.raw().query(`DELETE FROM eval_snapshots`);
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("collectEvalBlind", () => {
  it("stays silent when the probe has never run", async () => {
    expect(await collectEvalBlind.collect(ctx())).toEqual([]);
  });

  it("stays silent when the last probe actually scored queries", async () => {
    await snapshot("10", 0);
    await snapshot("11", 5);
    expect(await collectEvalBlind.collect(ctx())).toEqual([]);
  });

  it("fires when the latest probe replayed an empty eval set", async () => {
    await snapshot("10", 0);
    await snapshot("11", 0);
    await snapshot("12", 0);
    const out = await collectEvalBlind.collect(ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("eval_set_empty");
    expect(out[0]!.severity).toBe("medium");
    expect(out[0]!.title).toContain("3 snapshot(s)");
    expect(out[0]!.fix_command).toContain("eval-replay capture");
  });

  it("counts only the blind nights since the last probe that had queries", async () => {
    await snapshot("07", 0);
    await snapshot("08", 0);
    await snapshot("09", 4); // had queries to replay — the streak restarts here
    await snapshot("10", 0);
    await snapshot("11", 0);
    const out = await collectEvalBlind.collect(ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("2 snapshot(s)");
  });

  it("keeps quiet for a run that replayed queries but scored none", async () => {
    // Not the same gap: queries existed and retrieval found nothing for them.
    // That is a retrieval problem the trend already shows, not a missing set.
    await snapshot("11", 3, 0);
    expect(await collectEvalBlind.collect(ctx())).toEqual([]);
  });

  it("the advertised remedy actually registers a query", async () => {
    // The fix_command names `eval-replay capture`, whose handler is
    // recordQuery. A finding that points at a command doing something else is
    // worse than no finding, so assert the round trip, not the string.
    await recordQuery(storage.raw(), {
      id: "probe-1",
      query: "what did we decide about the ingress",
      tag: "good",
      expectedDocId: "doc-1",
    });
    const r = await storage
      .raw()
      .query<{ n: number }>(`SELECT count(*)::int AS n FROM eval_queries`);
    expect(r.rows[0]!.n).toBe(1);
    await storage.raw().query(`DELETE FROM eval_queries`);
  });
});

/**
 * The doctor half of the same gap. The collector can be perfect and the owner
 * still never sees it if `doctor` keeps rendering `mean_rr=0.000 (0/0)` for a
 * probe that measured nothing.
 */
describe("doctor eval-trend on an empty eval set", () => {
  const tmp = mkdtempSync(join(tmpdir(), "memex-eval-blind-doctor-"));
  const cfgDir = join(tmp, ".memex");
  const cfgPath = join(cfgDir, "config.json");
  const dbPath = join(cfgDir, "brain.pglite");

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("says nothing was measured instead of printing zeros", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { type: "pglite", path: dbPath },
        embedding: {
          provider: "bedrock-titan",
          model: "amazon.titan-embed-text-v2:0",
          region: "eu-west-1",
        },
        storage: {},
      }),
    );

    // Seed and CLOSE before doctor opens the same directory — one PGLite data
    // dir takes one handle per process.
    const seed = new Storage({ dbPath });
    await seed.init();
    await seed.raw().query(
      `INSERT INTO eval_snapshots (ran_at, total_queries, scored, mean_rr, hit_rate, detail)
       VALUES ('2026-08-12T02:30:00.000Z'::timestamptz, 0, 0, 0, 0, '{"ok":true}'::jsonb)`,
    );
    await seed.close();

    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      await runDoctor({ configPath: cfgPath });
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(captured.join("\n")) as {
      checks: { name: string; detail?: string }[];
    };
    const trend = parsed.checks.find((c) => c.name === "eval-trend");
    expect(trend?.detail).toContain("EMPTY");
    expect(trend?.detail).not.toContain("mean_rr");
  });
});
