/**
 * extract_atoms phase tests — hermetic. The LLM is a MOCKED `llmFn` (no
 * Bedrock). Verifies: atoms land ONLY in synth_atoms, idempotency, fail-open,
 * and that authored tables (documents/chunks) are never mutated.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { extractAtomsPhase, parseAtomsResponse } from "../src/core/synthesis/atoms.ts";
import type { LlmFn } from "../src/core/llm/nova.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-synth-atoms-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedDoc(id: string, body: string): Promise<void> {
  await engine.query(
    `INSERT INTO documents (id, source_path, title) VALUES ($1, $2, $3)`,
    [id, `/vault/${id}.md`, id],
  );
  await engine.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`,
    [`${id}c0`, id, body],
  );
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

describe("parseAtomsResponse", () => {
  it("parses a clean JSON array", () => {
    const atoms = parseAtomsResponse(
      `[{"title":"T","atom_type":"insight","body":"B body.","concepts":["x"]}]`,
    );
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.atom_type).toBe("insight");
    expect(atoms[0]?.concepts).toEqual(["x"]);
  });
  it("strips markdown fences and caps at 3", () => {
    const arr = Array.from({ length: 5 }, (_, i) => `{"title":"t${i}","atom_type":"x","body":"b${i}."}`);
    const atoms = parseAtomsResponse("```json\n[" + arr.join(",") + "]\n```");
    expect(atoms.length).toBe(3);
    expect(atoms[0]?.atom_type).toBe("insight"); // invalid type → fallback
  });
  it("returns [] on garbage", () => {
    expect(parseAtomsResponse("not json at all")).toEqual([]);
  });
});

describe("extractAtomsPhase", () => {
  it("writes atoms only to synth_atoms and leaves the corpus untouched", async () => {
    await seedDoc("d1", "A".repeat(500));
    const r = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(`[{"title":"Insight one","atom_type":"insight","body":"The body.","concepts":["topic-a"]}]`),
    });
    expect(r.atomsWritten).toBe(1);
    expect(r.errors).toEqual([]);

    const { rows } = await engine.query<{ source_ref: string; model_id: string }>(
      `SELECT source_ref, model_id FROM synth_atoms`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.source_ref).toBe("d1");
    expect(rows[0]?.model_id).toBe("fake-nova");

    // Corpus untouched.
    const docs = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents`);
    const chunks = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks`);
    expect(Number(docs.rows[0]?.n)).toBe(1);
    expect(Number(chunks.rows[0]?.n)).toBe(1);
  });

  it("is idempotent — a second run on unchanged docs writes nothing new", async () => {
    await seedDoc("d1", "B".repeat(500));
    const llm = fakeLlm(`[{"title":"Same","atom_type":"insight","body":"Same body."}]`);
    const r1 = await extractAtomsPhase(engine, { llmFn: llm });
    const r2 = await extractAtomsPhase(engine, { llmFn: llm });
    expect(r1.atomsWritten).toBe(1);
    expect(r2.documentsScanned).toBe(0); // already extracted → not re-discovered
    const { rows } = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_atoms`);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("skips short documents (budget/quality floor)", async () => {
    await seedDoc("d1", "too short");
    const r = await extractAtomsPhase(engine, { llmFn: fakeLlm("[]") });
    expect(r.documentsScanned).toBe(0);
    expect(r.atomsWritten).toBe(0);
  });

  it("fails open — an LLM error skips the doc, never throws", async () => {
    await seedDoc("d1", "C".repeat(500));
    const boom: LlmFn = async () => {
      throw new Error("bedrock down");
    };
    const r = await extractAtomsPhase(engine, { llmFn: boom });
    expect(r.errors.length).toBe(1);
    expect(r.atomsWritten).toBe(0);
  });

  it("idempotency matches on the (ref, hash) PAIR, not the cross-product", async () => {
    // Two docs with DIFFERENT content (different hashes). Extract atoms for d1
    // only by pre-seeding a synth_atoms row for d1's pair. d2 must still be
    // discovered even though d1's hash exists for d1 — a naive
    // ref=ANY AND hash=ANY filter would be fine here, but the regression we
    // guard is a stale row (d1_ref, d2_hash) wrongly skipping d2.
    await seedDoc("d1", "G".repeat(500));
    await seedDoc("d2", "H".repeat(500));
    // Insert a deliberately MISMATCHED stale pair: d1's ref with d2's hash.
    const d2Hash = (await import("../src/core/synthesis/atoms.ts")).contentHash16("H".repeat(500));
    await engine.query(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id)
       VALUES ('stale', 'd1', 'document', $1, 't', 'b', 'm')`,
      [d2Hash],
    );
    const r = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(`[{"title":"t","atom_type":"insight","body":"b."}]`),
    });
    // Both d1 and d2 must be discovered (the stale mismatched pair must NOT
    // suppress d2, whose real pair is (d2, d2Hash)).
    expect(r.documentsScanned).toBe(2);
  });

  it("respects maxDocs (cost guard)", async () => {
    await seedDoc("d1", "D".repeat(500));
    await seedDoc("d2", "E".repeat(500));
    await seedDoc("d3", "F".repeat(500));
    const r = await extractAtomsPhase(engine, {
      maxDocs: 2,
      llmFn: fakeLlm(`[{"title":"t","atom_type":"insight","body":"b."}]`),
    });
    expect(r.documentsScanned).toBe(2);
    expect(r.atomsWritten).toBe(2);
  });
});
