/**
 * The advisor's takes-ungradeable collector, against a real PGLite brain.
 *
 * The shape being guarded: `propose-takes` writes on every synthesis tick while
 * `grade-takes` only looks past the maturity bar, so on a young brain the paid
 * producer runs nightly and the grader selects nothing — reported as a clean
 * phase with zero grades, indistinguishable from "nothing new to grade".
 *
 * The assertions that matter are the SILENT ones: this must not fire when takes
 * are merely already graded, nor when some are mature, nor on an empty brain.
 * A finding that cries on every brain teaches the owner to ignore the advisor.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { collectTakesUngradeable } from "../src/core/advisor/collectors.ts";
import type { AdvisorContext } from "../src/core/advisor/types.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-takes-ungradeable-"));
let storage: Storage;
const ORIGINAL_BAR = process.env.MEMEX_GRADE_MIN_AGE_DAYS;

function ctx(): AdvisorContext {
  return { engine: storage.raw(), version: "1.2.3", now: new Date() };
}

/** Insert one take aged `ageDays` days. */
async function take(
  id: string,
  ageDays: number,
  opts: { status?: string; active?: boolean; resolved?: boolean } = {},
): Promise<void> {
  await storage.raw().query(
    `INSERT INTO synth_takes
       (take_key, source_ref, source_hash, prompt_version, claim_text, kind,
        model_id, status, active, generated_at, resolved_at)
     VALUES ($1, 'doc-1', 'h', 'v1', 'a claim', 'prediction', 'test-model',
             $2, $3, now() - ($4 * interval '1 day'), $5)`,
    [
      id,
      opts.status ?? "queued",
      opts.active ?? true,
      ageDays,
      opts.resolved ? new Date().toISOString() : null,
    ],
  );
}

beforeAll(async () => {
  process.env.MEMEX_GRADE_MIN_AGE_DAYS = "182";
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.raw().query(`DELETE FROM synth_takes`);
  process.env.MEMEX_GRADE_MIN_AGE_DAYS = "182";
});

afterAll(async () => {
  await storage.close();
  if (ORIGINAL_BAR === undefined) delete process.env.MEMEX_GRADE_MIN_AGE_DAYS;
  else process.env.MEMEX_GRADE_MIN_AGE_DAYS = ORIGINAL_BAR;
  rmSync(dir, { recursive: true, force: true });
});

describe("collectTakesUngradeable", () => {
  it("stays silent on a brain with no takes", async () => {
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  it("fires when takes are waiting and not one has reached the bar", async () => {
    await take("t1", 41);
    await take("t2", 10);
    const out = await collectTakesUngradeable.collect(ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("takes_ungradeable");
    expect(out[0]!.severity).toBe("medium");
    expect(out[0]!.title).toContain("2 unresolved take(s)");
    // Dated off the OLDEST take (41 days in): 182 - 41 = 141 days to wait.
    expect(out[0]!.title).toContain("141 day(s)");
  });

  it("stays silent when at least one take has reached the bar", async () => {
    await take("t1", 200); // mature — grade-takes has real work
    await take("t2", 10);
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  // Each exclusion gets its OWN case with every other predicate satisfied.
  // A fixture that trips two filters at once proves neither: drop one from the
  // SQL and the row is still excluded by the other, so the test stays green.
  it("ignores a rejected take that is otherwise eligible", async () => {
    await take("t1", 10, { status: "rejected", active: true });
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  it("ignores an inactive take that is otherwise eligible", async () => {
    await take("t1", 10, { status: "queued", active: false });
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  it("ignores a resolved take that is otherwise eligible", async () => {
    await take("t1", 10, { status: "queued", active: true, resolved: true });
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  it("stays silent when the bar is disabled, even for a future-dated take", async () => {
    // A bar of 0 disables the age gate entirely. A take dated in the future
    // still fails `generated_at <= now()`, so without the explicit guard this
    // would report an age-blocked pipeline on a brain where age blocks nothing.
    // The pool must be future-dated ONLY: one past-dated take makes `mature`
    // non-zero, and the collector then falls silent for the wrong reason —
    // leaving the guard unobservable.
    process.env.MEMEX_GRADE_MIN_AGE_DAYS = "0";
    await take("future", -3);
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  // Boundaries — where an off-by-one in the comparison or the rounding lives.
  it("stays silent for a take exactly at the bar", async () => {
    await take("t1", 182);
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  it("stays silent one day past the bar", async () => {
    await take("t1", 183);
    expect(await collectTakesUngradeable.collect(ctx())).toEqual([]);
  });

  it("fires one day short of the bar, reporting a single day left", async () => {
    await take("t1", 181);
    const out = await collectTakesUngradeable.collect(ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("1 day(s)");
  });
});
