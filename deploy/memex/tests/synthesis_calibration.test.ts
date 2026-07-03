/**
 * calibration_profile phase tests — hermetic, MOCKED llmFn (no Bedrock).
 * Verifies the scorecard aggregation, the min-graded gate, provenance, and
 * fail-open template fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  calibrationProfilePhase,
  parseBiasTags,
  parsePatternStatements,
} from "../src/core/synthesis/calibration.ts";
import { getCalibrationProfile } from "../src/core/synthesis/reads.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-synth-calib-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

let takeCounter = 0;
async function seedGradedTake(verdict: string): Promise<void> {
  takeCounter += 1;
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
     VALUES ($1, 'd1', 'h', 'v1-nova', 'claim', 'm') RETURNING id`,
    [`ct-${takeCounter}`],
  );
  await engine.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1-nova', $2, $3, 0.8, 'm')`,
    [Number(rows[0]?.id), `sig-${takeCounter}`, verdict],
  );
}

/** Register a tenant so the profile FK to sources(id) is satisfiable. */
async function seedSource(id: string): Promise<void> {
  await engine.query(
    `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2)
       ON CONFLICT (id) DO NOTHING`,
    [id, `__${id}__`],
  );
}

/** Seed a graded take owned by `sourceId` (via its source document). */
async function seedGradedTakeForSource(sourceId: string, verdict: string): Promise<void> {
  takeCounter += 1;
  const docId = `doc-${sourceId}-${takeCounter}`;
  await engine.query(
    `INSERT INTO documents (id, source_path, source_id) VALUES ($1, $2, $3)`,
    [docId, `/x/${docId}.md`, sourceId],
  );
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
     VALUES ($1, $2, 'h', 'v1-nova', 'claim', 'm') RETURNING id`,
    [`ct-${sourceId}-${takeCounter}`, docId],
  );
  await engine.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1-nova', $2, $3, 0.8, 'm')`,
    [Number(rows[0]?.id), `sig-${sourceId}-${takeCounter}`, verdict],
  );
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

describe("parsers", () => {
  it("parses pattern statements, stripping bullets", () => {
    expect(parsePatternStatements("- one\n2. two\nthree")).toEqual(["one", "two", "three"]);
  });
  it("parses kebab-case bias tags only", () => {
    expect(parseBiasTags(`["over-confident-macro","BAD TAG","late-on-hiring"]`)).toEqual([
      "over-confident-macro",
      "late-on-hiring",
    ]);
  });
});

describe("calibrationProfilePhase", () => {
  it("skips when below the min-graded gate", async () => {
    await seedGradedTake("correct");
    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("x") });
    expect(r.profileWritten).toBe(false);
    expect(r.skippedReason).toBe("insufficient_data");
  });

  it("writes a profile with scorecard + provenance once enough takes are graded", async () => {
    await seedGradedTake("correct");
    await seedGradedTake("correct");
    await seedGradedTake("correct");
    await seedGradedTake("incorrect");
    await seedGradedTake("partial");

    const r = await calibrationProfilePhase(engine, {
      llmFn: fakeLlm("You called macro well — 3 of 5 held up."),
    });
    expect(r.profileWritten).toBe(true);
    expect(r.totalGraded).toBe(5);
    // accuracy = (correct + 0.5*partial) / resolved = (3 + 0.5) / 5 = 0.7
    expect(r.accuracy).toBeCloseTo(0.7, 5);
    expect(r.patternStatements.length).toBeGreaterThan(0);

    const { rows } = await engine.query<{
      total_graded: number;
      correct: number;
      graded_take_ids: unknown;
      model_id: string;
    }>(`SELECT total_graded, correct, graded_take_ids, model_id FROM synth_calibration_profile`);
    expect(Number(rows[0]?.total_graded)).toBe(5);
    expect(Number(rows[0]?.correct)).toBe(3);
    expect(rows[0]?.model_id).toBe("fake-nova");
    const ids = rows[0]?.graded_take_ids;
    const parsed = typeof ids === "string" ? JSON.parse(ids) : ids;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(5);
  });

  it("fails open — LLM error falls back to a template profile", async () => {
    for (let i = 0; i < 5; i++) await seedGradedTake("correct");
    const boom: LlmFn = async () => {
      throw new Error("nova down");
    };
    const r = await calibrationProfilePhase(engine, { llmFn: boom });
    expect(r.profileWritten).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.patternStatements.length).toBe(1); // template fallback
  });
});

describe("per-source calibration (tenancy)", () => {
  it("writes one profile per source; a scoped read returns only that source, no blend", async () => {
    await seedSource("tenant-a");
    await seedSource("tenant-b");
    // tenant-a: a strong track record; tenant-b: a weak one.
    for (let i = 0; i < 5; i++) await seedGradedTakeForSource("tenant-a", "correct");
    for (let i = 0; i < 5; i++) await seedGradedTakeForSource("tenant-b", "incorrect");

    const r = await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });
    expect(r.profileWritten).toBe(true);
    expect(r.profiles.length).toBe(2);

    const a = await getCalibrationProfile(engine, ["tenant-a"]);
    const b = await getCalibrationProfile(engine, ["tenant-b"]);
    expect(a?.source_id).toBe("tenant-a");
    expect(a?.total_graded).toBe(5);
    expect(a?.accuracy).toBeCloseTo(1.0, 5); // 5/5 correct — never blended with b
    expect(b?.source_id).toBe("tenant-b");
    expect(b?.total_graded).toBe(5);
    expect(b?.accuracy).toBeCloseTo(0.0, 5); // 0/5 correct — never blended with a
  });

  it("excludes other tenants' profiles fail-closed for a scoped caller", async () => {
    await seedSource("tenant-a");
    for (let i = 0; i < 5; i++) await seedGradedTakeForSource("tenant-a", "correct");
    await calibrationProfilePhase(engine, { llmFn: fakeLlm("pattern") });

    // A caller scoped to a tenant with no profile sees nothing — not tenant-a's.
    const other = await getCalibrationProfile(engine, ["tenant-z"]);
    expect(other).toBeNull();
  });
});
