/**
 * propose_takes + grade_takes phase tests — hermetic, MOCKED llmFn (no
 * Bedrock). Verifies queue-only proposals, idempotency, evidence-grounded
 * grading, parse fallbacks, and fail-open.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  proposeTakesPhase,
  gradeTakesPhase,
  parseTakesResponse,
  parseVerdictResponse,
} from "../src/core/synthesis/takes.ts";
import type { LlmFn } from "../src/core/llm/nova.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-synth-takes-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedDoc(id: string, body: string): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path, title) VALUES ($1, $2, $3)`, [
    id,
    `/vault/${id}.md`,
    id,
  ]);
  await engine.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`,
    [`${id}c0`, id, body],
  );
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

describe("parseTakesResponse / parseVerdictResponse", () => {
  it("parses takes and clamps weight", () => {
    const t = parseTakesResponse(`[{"claim_text":"X will win","kind":"prediction","weight":5,"domain":"macro"}]`);
    expect(t.length).toBe(1);
    expect(t[0]?.weight).toBe(1);
    expect(t[0]?.domain).toBe("macro");
  });
  it("parses a verdict object", () => {
    const v = parseVerdictResponse(`{"verdict":"correct","confidence":0.9,"reasoning":"ok"}`);
    expect(v?.verdict).toBe("correct");
    expect(v?.confidence).toBe(0.9);
  });
  it("returns null on bad verdict", () => {
    expect(parseVerdictResponse("garbage")).toBeNull();
  });
});

describe("proposeTakesPhase", () => {
  it("queues takes only in synth_takes with status queued", async () => {
    await seedDoc("d1", "Z".repeat(500));
    const r = await proposeTakesPhase(engine, {
      llmFn: fakeLlm(`[{"claim_text":"X will happen","kind":"prediction","weight":0.7}]`),
    });
    expect(r.takesQueued).toBe(1);
    const { rows } = await engine.query<{ status: string; source_ref: string }>(
      `SELECT status, source_ref FROM synth_takes`,
    );
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.source_ref).toBe("d1");
  });

  it("is idempotent across runs", async () => {
    await seedDoc("d1", "Y".repeat(500));
    const llm = fakeLlm(`[{"claim_text":"stable claim","kind":"judgment","weight":0.5}]`);
    await proposeTakesPhase(engine, { llmFn: llm });
    const r2 = await proposeTakesPhase(engine, { llmFn: llm });
    expect(r2.documentsScanned).toBe(0);
    const { rows } = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_takes`);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("fails open on LLM error", async () => {
    await seedDoc("d1", "W".repeat(500));
    const boom: LlmFn = async () => {
      throw new Error("down");
    };
    const r = await proposeTakesPhase(engine, { llmFn: boom });
    expect(r.takesQueued).toBe(0);
    expect(r.errors.length).toBe(1);
  });
});

describe("gradeTakesPhase", () => {
  async function seedTake(id: number, claim: string): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
       VALUES ($1, 'd1', 'h', 'v1-nova', $2, 'prediction', 0.7, 'queued', 'm')`,
      [`tk-${id}`, claim],
    );
  }

  it("grades a queued take with injected evidence", async () => {
    await seedTake(1, "the claim");
    const r = await gradeTakesPhase(engine, {
      evidenceFn: async () => "strong supporting evidence",
      llmFn: fakeLlm(`{"verdict":"correct","confidence":0.88,"reasoning":"matches"}`),
    });
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{ verdict: string; confidence: number }>(
      `SELECT verdict, confidence FROM synth_take_grades`,
    );
    expect(rows[0]?.verdict).toBe("correct");
    expect(Number(rows[0]?.confidence)).toBeCloseTo(0.88, 5);
  });

  it("records a parse failure as unresolvable rather than dropping the take", async () => {
    await seedTake(1, "claim");
    const r = await gradeTakesPhase(engine, {
      evidenceFn: async () => "e",
      llmFn: fakeLlm("not json"),
    });
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{ verdict: string; reasoning: string }>(
      `SELECT verdict, reasoning FROM synth_take_grades`,
    );
    expect(rows[0]?.verdict).toBe("unresolvable");
    expect(rows[0]?.reasoning).toBe("judge_output_parse_failed");
  });

  it("is idempotent — an already-graded take is not re-scanned, no duplicate grade", async () => {
    await seedTake(1, "claim");
    const opts = {
      evidenceFn: async () => "same evidence",
      llmFn: fakeLlm(`{"verdict":"partial","confidence":0.5,"reasoning":"mixed"}`),
    };
    const r1 = await gradeTakesPhase(engine, opts);
    const r2 = await gradeTakesPhase(engine, opts);
    expect(r1.gradesWritten).toBe(1);
    // Discovery's NOT EXISTS filter drops the already-graded take → not re-scanned.
    expect(r2.takesScanned).toBe(0);
    expect(r2.gradesWritten).toBe(0);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("the grade row carries provenance: take_id + model_id", async () => {
    await seedTake(1, "the claim");
    await gradeTakesPhase(engine, {
      evidenceFn: async () => "evidence",
      llmFn: fakeLlm(`{"verdict":"correct","confidence":0.9,"reasoning":"r"}`),
    });
    const { rows } = await engine.query<{ take_id: number; model_id: string }>(
      `SELECT g.take_id, g.model_id FROM synth_take_grades g`,
    );
    expect(Number(rows[0]?.take_id)).toBeGreaterThan(0);
    expect(rows[0]?.model_id).toBe("fake-nova");
  });
});
