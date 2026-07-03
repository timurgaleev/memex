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
  aggregateVerdicts,
} from "../src/core/synthesis/takes.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { BudgetTracker } from "../src/core/budget.ts";

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

// Stateful Sonnet stub: returns each text in turn (last one repeats), with a
// tiny fixed token usage so the default $1 budget easily covers a few judges.
const seqSonnet = (texts: string[]): SonnetFn => {
  let i = 0;
  return async () => ({
    text: texts[Math.min(i++, texts.length - 1)]!,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 100, outputTokens: 50 },
  });
};

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
  // Seed a take dated a year back so it clears the default 6-month grade age
  // gate (grading targets claims old enough to have resolved).
  async function seedTake(id: number, claim: string): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
       VALUES ($1, 'd1', 'h', 'v1-nova', $2, 'prediction', 0.7, 'queued', 'm', now() - interval '365 days')`,
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

describe("aggregateVerdicts", () => {
  it("returns null on no votes", () => {
    expect(aggregateVerdicts([])).toBeNull();
  });
  it("picks the majority verdict and the median confidence of the winners", () => {
    const a = aggregateVerdicts([
      { verdict: "correct", confidence: 0.8, reasoning: "a" },
      { verdict: "correct", confidence: 0.6, reasoning: "b" },
      { verdict: "partial", confidence: 0.9, reasoning: "c" },
    ]);
    expect(a?.verdict).toBe("correct");
    expect(a?.confidence).toBeCloseTo(0.7, 5); // median of [0.6, 0.8]
    expect(a?.reasoning).toBe("a");
  });
  it("breaks a tie toward the higher summed confidence", () => {
    const a = aggregateVerdicts([
      { verdict: "correct", confidence: 0.5, reasoning: "a" },
      { verdict: "incorrect", confidence: 0.95, reasoning: "b" },
    ]);
    expect(a?.verdict).toBe("incorrect");
  });
});

describe("gradeTakesPhase — Sonnet ensemble (S1)", () => {
  // Seed a take dated a year back so it clears the default 6-month grade age
  // gate (grading targets claims old enough to have resolved).
  async function seedTake(id: number, claim: string): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
       VALUES ($1, 'd1', 'h', 'v1-nova', $2, 'prediction', 0.7, 'queued', 'm', now() - interval '365 days')`,
      [`tk-${id}`, claim],
    );
  }

  it("grades via a majority vote and records ensemble provenance", async () => {
    await seedTake(1, "the claim");
    const r = await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "evidence",
      sonnetFn: seqSonnet([
        `{"verdict":"correct","confidence":0.8,"reasoning":"a"}`,
        `{"verdict":"correct","confidence":0.6,"reasoning":"b"}`,
        `{"verdict":"incorrect","confidence":0.9,"reasoning":"c"}`,
      ]),
      judges: 3,
    });
    expect(r.gradesWritten).toBe(1);
    const { rows } = await engine.query<{
      verdict: string;
      confidence: number;
      grader_model: string;
      judge_count: number;
      model_id: string;
      prompt_version: string;
    }>(
      `SELECT verdict, confidence, grader_model, judge_count, model_id, prompt_version FROM synth_take_grades`,
    );
    expect(rows[0]?.verdict).toBe("correct"); // 2 correct vs 1 incorrect
    expect(Number(rows[0]?.confidence)).toBeCloseTo(0.7, 5); // median of [0.6, 0.8]
    expect(rows[0]?.grader_model).toBe("ensemble:3");
    expect(Number(rows[0]?.judge_count)).toBe(3);
    expect(rows[0]?.model_id).toContain("sonnet");
    expect(rows[0]?.prompt_version).toBe("v1-sonnet-ensemble");
  });

  it("judges spent but all unparseable → writes unresolvable, does NOT halt the phase", async () => {
    await seedTake(1, "claim one");
    await seedTake(2, "claim two");
    const r = await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "evidence",
      sonnetFn: seqSonnet(["not json at all"]),
      judges: 2,
    });
    // Both takes are graded (phase not halted); each gets an unresolvable row.
    expect(r.takesScanned).toBe(2);
    expect(r.gradesWritten).toBe(2);
    const { rows } = await engine.query<{ verdict: string; grader_model: string; judge_count: number }>(
      `SELECT verdict, grader_model, judge_count FROM synth_take_grades ORDER BY take_id`,
    );
    expect(rows[0]?.verdict).toBe("unresolvable");
    expect(rows[0]?.grader_model).toBe("ensemble:0");
    expect(Number(rows[0]?.judge_count)).toBe(0);
  });

  it("stops (partial progress) when the budget leaves no room for a judge", async () => {
    await seedTake(1, "claim");
    const r = await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "e",
      sonnetFn: seqSonnet([`{"verdict":"correct","confidence":0.9,"reasoning":"r"}`]),
      budget: new BudgetTracker(0.000001, "test"),
      judges: 3,
    });
    expect(r.gradesWritten).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("ensemble and single-pass grades coexist under distinct prompt versions", async () => {
    await seedTake(1, "coexist claim");
    await gradeTakesPhase(engine, {
      evidenceFn: async () => "evidence",
      llmFn: fakeLlm(`{"verdict":"partial","confidence":0.5,"reasoning":"nova"}`),
    });
    await gradeTakesPhase(engine, {
      ensemble: true,
      evidenceFn: async () => "evidence",
      sonnetFn: seqSonnet([`{"verdict":"correct","confidence":0.9,"reasoning":"s"}`]),
      judges: 1,
    });
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_take_grades`,
    );
    expect(Number(rows[0]?.n)).toBe(2); // two rows, different prompt_version
  });
});
