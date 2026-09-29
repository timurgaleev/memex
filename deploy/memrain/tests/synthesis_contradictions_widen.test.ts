/**
 * G30 contradiction-probe widen — hermetic, injected SonnetFn (no Bedrock).
 *   - default pair generator now includes take/take (cross-slug) and take/fact
 *   - typed resolution proposals (supersede/debate/synthesize/manual)
 *   - verdict TTL cache stops re-spend on negatives
 *   - one trend row per run with a Wilson 95% CI
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  probeContradictionsPhase,
  parseJudgment,
  classifyResolution,
  renderResolutionCommand,
  wilsonInterval,
  type CandidatePair,
} from "../src/core/synthesis/contradictions.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-contra-widen-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const countingSonnet = (text: string): { fn: SonnetFn; calls: () => number } => {
  let n = 0;
  const fn: SonnetFn = async () => {
    n += 1;
    return {
      text,
      modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 100, outputTokens: 40 },
    };
  };
  return { fn, calls: () => n };
};

const NEGATIVE = `{"contradicts":false,"severity":"low","axis":"","confidence":0.2,"resolution_kind":"manual","resolution_command":""}`;
const POSITIVE = `{"contradicts":true,"severity":"high","axis":"stance","confidence":0.9,"resolution_kind":"","resolution_command":""}`;

async function seedTake(key: string, docId: string, claim: string, domain: string): Promise<void> {
  await engine.query(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, domain, model_id)
     VALUES ($1, $2, 'h', 'v1', $3, $4, 'm')`,
    [key, docId, claim, domain],
  );
}

async function seedDoc(id: string): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path) VALUES ($1, $2)`, [
    id,
    `/vault/${id}.md`,
  ]);
}

describe("pure helpers", () => {
  it("parseJudgment picks up a valid resolution_kind and drops an invalid one", () => {
    const j = parseJudgment(
      `{"contradicts":true,"severity":"medium","axis":"timing","confidence":0.7,"resolution_kind":"debate"}`,
    );
    expect(j?.resolution_kind).toBe("debate");
    const bad = parseJudgment(
      `{"contradicts":true,"severity":"medium","axis":"t","confidence":0.7,"resolution_kind":"explode"}`,
    );
    expect(bad?.resolution_kind).toBe("");
  });

  it("classifyResolution: judge hint wins, else pair-shape defaults", () => {
    expect(classifyResolution({ a_kind: "fact", b_kind: "fact" }, "debate")).toBe("debate");
    expect(classifyResolution({ a_kind: "take", b_kind: "take" }, "")).toBe("debate");
    expect(classifyResolution({ a_kind: "take", b_kind: "fact" }, "")).toBe("supersede");
    expect(classifyResolution({ a_kind: "fact", b_kind: "fact" }, "")).toBe("synthesize");
  });

  it("renderResolutionCommand targets the take side for supersede", () => {
    const pair: CandidatePair = {
      a_ref: "tk-a",
      a_text: "a",
      b_ref: "42",
      b_text: "b",
      source_id: null,
      a_kind: "take",
      b_kind: "fact",
    };
    expect(renderResolutionCommand(pair, "supersede")).toContain("tk-a");
    expect(renderResolutionCommand(pair, "manual")).toContain("manual review");
  });

  it("wilsonInterval brackets the observed rate and degrades to [0,1] on zero trials", () => {
    const ci = wilsonInterval(3, 10);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThan(0.3);
    expect(ci.upper).toBeGreaterThan(0.3);
    expect(ci.upper).toBeLessThanOrEqual(1);
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
});

describe("widened default pairs", () => {
  it("pairs same-domain takes across different source docs (take/take)", async () => {
    await seedDoc("da");
    await seedDoc("db");
    await seedTake("tk-a", "da", "rates will fall", "macro");
    await seedTake("tk-b", "db", "rates will rise", "macro");

    const s = countingSonnet(POSITIVE);
    const r = await probeContradictionsPhase(engine, { sonnetFn: s.fn });
    expect(r.judged).toBe(1);
    expect(r.contradictionsFound).toBe(1);
    const { rows } = await engine.query<{
      a_kind: string;
      b_kind: string;
      resolution_kind: string;
      resolution_command: string;
    }>(`SELECT a_kind, b_kind, resolution_kind, resolution_command FROM synth_contradictions`);
    expect(rows[0]?.a_kind).toBe("take");
    expect(rows[0]?.b_kind).toBe("take");
    // No judge hint → take/take defaults to debate.
    expect(rows[0]?.resolution_kind).toBe("debate");
    expect(rows[0]?.resolution_command.length).toBeGreaterThan(0);
  });

  it("pairs a take with a fact whose entity name appears in the claim (take/fact)", async () => {
    await seedDoc("dc");
    await seedTake("tk-c", "dc", "acme corp will dominate the market", "business");
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, written_by) VALUES ('companies/acme-corp', 'acme corp shut down', 'test')`,
    );

    const s = countingSonnet(POSITIVE);
    const r = await probeContradictionsPhase(engine, { sonnetFn: s.fn });
    expect(r.judged).toBe(1);
    const { rows } = await engine.query<{ a_kind: string; b_kind: string; resolution_kind: string }>(
      `SELECT a_kind, b_kind, resolution_kind FROM synth_contradictions`,
    );
    expect(rows[0]?.a_kind).toBe("take");
    expect(rows[0]?.b_kind).toBe("fact");
    expect(rows[0]?.resolution_kind).toBe("supersede");
  });
});

describe("verdict TTL cache", () => {
  it("caches a negative verdict so the pair is not re-judged", async () => {
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, written_by) VALUES ('people/bob', 'bob lives in paris', 'test')`,
    );
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, written_by) VALUES ('people/bob', 'bob lives in lyon', 'test')`,
    );

    const s = countingSonnet(NEGATIVE);
    const r1 = await probeContradictionsPhase(engine, { sonnetFn: s.fn });
    expect(r1.judged).toBe(1);
    expect(s.calls()).toBe(1);

    const r2 = await probeContradictionsPhase(engine, { sonnetFn: s.fn });
    expect(r2.cacheHits).toBe(1);
    expect(r2.judged).toBe(0);
    expect(s.calls()).toBe(1); // no re-spend
  });

  it("treats an expired verdict as a miss", async () => {
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, written_by) VALUES ('people/eve', 'eve is a founder', 'test')`,
    );
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, written_by) VALUES ('people/eve', 'eve is an investor', 'test')`,
    );
    const s = countingSonnet(NEGATIVE);
    await probeContradictionsPhase(engine, { sonnetFn: s.fn });
    await engine.query(`UPDATE synth_contradiction_verdicts SET expires_at = now() - interval '1 day'`);
    const r = await probeContradictionsPhase(engine, { sonnetFn: s.fn });
    expect(r.judged).toBe(1);
    expect(s.calls()).toBe(2);
  });
});

describe("trend rows", () => {
  it("writes one synth_contradiction_runs row per run with a Wilson CI", async () => {
    await seedDoc("dd");
    await seedDoc("de");
    await seedTake("tk-d", "dd", "the plan will work", "ops");
    await seedTake("tk-e", "de", "the plan will fail", "ops");

    const s = countingSonnet(POSITIVE);
    const r = await probeContradictionsPhase(engine, { sonnetFn: s.fn });
    expect(r.runId).toBeDefined();
    const { rows } = await engine.query<{
      run_id: string;
      judged: number;
      found: number;
      wilson_ci_lower: number;
      wilson_ci_upper: number;
    }>(`SELECT run_id, judged, found, wilson_ci_lower, wilson_ci_upper FROM synth_contradiction_runs`);
    expect(rows.length).toBe(1);
    expect(rows[0]?.run_id).toBe(r.runId!);
    expect(Number(rows[0]?.judged)).toBe(1);
    expect(Number(rows[0]?.found)).toBe(1);
    expect(Number(rows[0]?.wilson_ci_upper)).toBeLessThanOrEqual(1);
    expect(Number(rows[0]?.wilson_ci_lower)).toBeGreaterThan(0);
  });
});
