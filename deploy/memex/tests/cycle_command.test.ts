/**
 * `memex cycle` one-shot command -- parsePhasesArg validation + a scoped
 * one-shot run against a PGLite Storage.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { parsePhasesArg, runCycle } from "../src/commands/cycle.ts";
import { runCycleOnce } from "../src/core/cycle/index.ts";

describe("parsePhasesArg", () => {
  it("parses a CSV of valid phase names", () => {
    expect(parsePhasesArg("recompute-salience,embed-facts")).toEqual([
      "recompute-salience",
      "embed-facts",
    ]);
  });
  it("trims and drops empties", () => {
    expect(parsePhasesArg(" snapshot , ")).toEqual(["snapshot"]);
  });
  it("throws on an unknown phase", () => {
    expect(() => parsePhasesArg("recompute-salience,bogus")).toThrow(/bogus/);
  });
  it("throws on an empty result (no silent fall-through to ALL phases)", () => {
    expect(() => parsePhasesArg("")).toThrow(/empty/);
    expect(() => parsePhasesArg(" , ")).toThrow(/empty/);
  });
  it("de-dupes a repeated phase", () => {
    expect(parsePhasesArg("snapshot,snapshot")).toEqual(["snapshot"]);
  });
});

describe("runCycleOnce with a phase subset (what `memex cycle --phases` runs)", () => {
  let tmp: string;
  let storage: Storage;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-cyclecmd-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs only the requested phase and realizes its backfill", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      compiled_truth: { tags: ["family"] },
    });
    const r = await runCycleOnce(storage.engine(), {
      phases: ["recompute-salience"],
      storage,
    });
    expect(r.phases.map((p) => p.phase)).toEqual(["recompute-salience"]);
    expect(r.ok).toBe(true);
    // salience backfilled (family tag -> 0.5)
    const row = await storage
      .engine()
      .query<{ salience: number | string }>(
        `SELECT salience FROM pages WHERE slug = $1`,
        ["people/alice"],
      );
    expect(Number(row.rows[0]!.salience)).toBeCloseTo(0.5, 5);
  });
});
