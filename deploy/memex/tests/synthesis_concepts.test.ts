/**
 * synthesize_concepts phase tests — hermetic, MOCKED llmFn (no Bedrock).
 * Verifies clustering/tiering, provenance links, idempotent upsert, fail-open.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-synth-concepts-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

let atomCounter = 0;
async function seedAtom(concepts: string[], title = `atom-${atomCounter}`): Promise<number> {
  atomCounter += 1;
  const key = `k-${atomCounter}`;
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, concepts, model_id)
     VALUES ($1, 'd1', 'h1', $2, 'body', $3::jsonb, 'm') RETURNING id`,
    [key, title, JSON.stringify(concepts)],
  );
  return Number(rows[0]?.id);
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

describe("synthesizeConceptsPhase", () => {
  it("groups atoms, tiers by count, writes concept + provenance", async () => {
    const a1 = await seedAtom(["alpha"]);
    const a2 = await seedAtom(["alpha"]);
    await seedAtom(["lonely"]); // count 1 → below threshold, skipped

    const r = await synthesizeConceptsPhase(engine, {
      llmFn: fakeLlm("A synthesized narrative."),
    });
    expect(r.groupsFound).toBe(1);
    expect(r.conceptsWritten).toBe(1);
    expect(r.tierCounts.T3).toBe(1); // 2 atoms → T3

    const c = await engine.query<{ narrative: string; atom_count: number }>(
      `SELECT narrative, atom_count FROM synth_concepts WHERE concept_slug = 'alpha'`,
    );
    // 2 atoms = T3 → deterministic narrative (LLM only fires for T1/T2).
    expect(c.rows[0]?.narrative).toContain("T3 concept");
    expect(Number(c.rows[0]?.atom_count)).toBe(2);

    const links = await engine.query<{ atom_id: number }>(
      `SELECT atom_id FROM synth_concept_atoms WHERE concept_slug = 'alpha' ORDER BY atom_id`,
    );
    expect(links.rows.map((l) => Number(l.atom_id))).toEqual([a1, a2].sort((x, y) => x - y));
  });

  it("uses the LLM narrative for a T2 group", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["beta"]);
    const r = await synthesizeConceptsPhase(engine, { llmFn: fakeLlm("LLM beta summary.") });
    expect(r.tierCounts.T2).toBe(1);
    const c = await engine.query<{ narrative: string }>(
      `SELECT narrative FROM synth_concepts WHERE concept_slug = 'beta'`,
    );
    expect(c.rows[0]?.narrative).toBe("LLM beta summary.");
  });

  it("is idempotent — re-running upserts, not duplicates", async () => {
    await seedAtom(["gamma"]);
    await seedAtom(["gamma"]);
    const llm = fakeLlm("n");
    await synthesizeConceptsPhase(engine, { llmFn: llm });
    await synthesizeConceptsPhase(engine, { llmFn: llm });
    const c = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_concepts`);
    expect(Number(c.rows[0]?.n)).toBe(1);
  });

  it("fails open — LLM error falls back to deterministic narrative", async () => {
    for (let i = 0; i < 5; i++) await seedAtom(["delta"]);
    const boom: LlmFn = async () => {
      throw new Error("nova error");
    };
    const r = await synthesizeConceptsPhase(engine, { llmFn: boom });
    expect(r.conceptsWritten).toBe(1);
    expect(r.errors.length).toBe(1);
    const c = await engine.query<{ narrative: string }>(
      `SELECT narrative FROM synth_concepts WHERE concept_slug = 'delta'`,
    );
    expect(c.rows[0]?.narrative).toContain("T2 concept");
  });
});
