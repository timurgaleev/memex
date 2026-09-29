/**
 * Life Chronicle feature eval — runs the deterministic harness in-process
 * against a fresh in-memory PGLite and asserts a perfect 6/6. This is the CI
 * gate that proves the chronicle layer answers the temporal/longitudinal
 * questions correctly; it touches no gateway (injected stub judge).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { runChronicleEval } from "../src/eval/chronicle-harness.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-eval-chron-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("runChronicleEval", () => {
  it("scores a perfect 6/6 on the synthetic corpus", async () => {
    const res = await runChronicleEval(storage);
    const failed = res.tasks.filter((t) => !t.passed).map((t) => `${t.id} — ${t.detail}`);
    // Surface the offending task(s) in the assertion message on a regression.
    expect(failed).toEqual([]);
    expect(res.passed).toBe(6);
    expect(res.total).toBe(6);
    expect(res.score).toBe(1);
  }, 30000);
});
