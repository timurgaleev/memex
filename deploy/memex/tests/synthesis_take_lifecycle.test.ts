/**
 * Take lifecycle hygiene (Item 4): the grade age gate + queued→graded status
 * advance. Hermetic — injected llmFn + evidenceFn, no Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { gradeTakesPhase, gradeMinAgeDays } from "../src/core/synthesis/takes.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-lifecycle-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-haiku" });
const correct = fakeLlm(`{"verdict":"correct","confidence":0.9,"reasoning":"ok"}`);

/** Seed a take at a chosen age (days old). */
async function seedTake(key: string, ageDays: number): Promise<void> {
  await engine.query(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
     VALUES ($1, 'd', 'h', 'v', 'claim', 'prediction', 0.7, 'queued', 'm', now() - ($2 * interval '1 day'))`,
    [key, ageDays],
  );
}

async function statusOf(key: string): Promise<string> {
  const { rows } = await engine.query<{ status: string }>(
    `SELECT status FROM synth_takes WHERE take_key = $1`,
    [key],
  );
  return rows[0]!.status;
}

describe("gradeMinAgeDays", () => {
  it("defaults to ~6 months and honors 0 / overrides", () => {
    expect(gradeMinAgeDays("")).toBe(182);
    expect(gradeMinAgeDays(undefined)).toBe(182);
    expect(gradeMinAgeDays("0")).toBe(0);
    expect(gradeMinAgeDays("30")).toBe(30);
  });
  it("rejects a malformed value", () => {
    expect(() => gradeMinAgeDays("-5")).toThrow();
    expect(() => gradeMinAgeDays("abc")).toThrow();
  });
});

describe("grade age gate (Item 4a)", () => {
  it("skips a take younger than the min age", async () => {
    await seedTake("young", 10);
    const r = await gradeTakesPhase(engine, { evidenceFn: async () => "e", llmFn: correct });
    expect(r.takesScanned).toBe(0);
    expect(r.gradesWritten).toBe(0);
    expect(await statusOf("young")).toBe("queued");
  });

  it("grades a take older than the min age", async () => {
    await seedTake("old", 200);
    const r = await gradeTakesPhase(engine, { evidenceFn: async () => "e", llmFn: correct });
    expect(r.gradesWritten).toBe(1);
  });

  it("minAgeDays:0 disables the gate", async () => {
    await seedTake("fresh", 0);
    const r = await gradeTakesPhase(engine, { minAgeDays: 0, evidenceFn: async () => "e", llmFn: correct });
    expect(r.gradesWritten).toBe(1);
  });
});

describe("status advance (Item 4b)", () => {
  it("moves a graded take out of the queued pool", async () => {
    await seedTake("t", 200);
    await gradeTakesPhase(engine, { evidenceFn: async () => "e", llmFn: correct });
    expect(await statusOf("t")).toBe("graded");
  });

  it("does not downgrade an operator-terminal status", async () => {
    await seedTake("t", 200);
    await engine.query(`UPDATE synth_takes SET status='accepted' WHERE take_key='t'`);
    await gradeTakesPhase(engine, { minAgeDays: 0, evidenceFn: async () => "e", llmFn: correct });
    // 'accepted' is not in the eligible pool, so it is never graded or advanced.
    expect(await statusOf("t")).toBe("accepted");
  });

  it("a graded take is still re-gradeable under a NEW prompt version", async () => {
    await seedTake("t", 200);
    const r1 = await gradeTakesPhase(engine, {
      promptVersion: "vA",
      evidenceFn: async () => "e",
      llmFn: correct,
    });
    expect(r1.gradesWritten).toBe(1);
    expect(await statusOf("t")).toBe("graded");

    // Same take, different prompt version → eligible again despite 'graded'.
    const r2 = await gradeTakesPhase(engine, {
      promptVersion: "vB",
      evidenceFn: async () => "e",
      llmFn: correct,
    });
    expect(r2.gradesWritten).toBe(1);

    // But not re-graded under the SAME version (idempotent).
    const r3 = await gradeTakesPhase(engine, {
      promptVersion: "vA",
      evidenceFn: async () => "e",
      llmFn: correct,
    });
    expect(r3.gradesWritten).toBe(0);
  });
});
