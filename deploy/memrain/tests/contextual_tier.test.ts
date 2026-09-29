/**
 * The contextual tier behind each stored vector (migration 106). The indexer
 * never marked the chunks it wrapped, so `reindex --contextual` re-paid for them
 * and, with the LLM tier off, overwrote Haiku-situated vectors with
 * deterministic ones. Locks: every write records the tier it actually used, a
 * reused chunk keeps its own, and a re-embed never lowers a chunk's tier.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { runContextualReembed } from "../src/core/contextual-reembed.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;
let prevLlm: string | undefined;
let prevWrap: string | undefined;

const SRC = "/notes/tier.md";
const section = (n: number) =>
  `## Section ${n}\n\nSection ${n} discusses topic number ${n} in some depth. It covers the ` +
  `background, the core argument, and a few supporting details that run long enough to keep ` +
  `this section on its own as a distinct retrievable chunk well past the minimum chunk size floor.`;
const doc = (sections: number[]) => sections.map(section).join("\n\n");

const embedFn = async (t: string) => deterministicEmbed(t);
const situating: LlmFn = async () => ({ text: "Situates the chunk.", modelId: "fake" });
const failing: LlmFn = async () => ({ text: "", modelId: "fake" });

beforeEach(async () => {
  prevLlm = process.env.MEMEX_CONTEXTUAL_LLM;
  prevWrap = process.env.MEMEX_CONTEXTUAL_RETRIEVAL;
  delete process.env.MEMEX_CONTEXTUAL_LLM;
  delete process.env.MEMEX_CONTEXTUAL_RETRIEVAL;
  tmp = mkdtempSync(join(tmpdir(), "memex-tier-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  if (prevLlm === undefined) delete process.env.MEMEX_CONTEXTUAL_LLM;
  else process.env.MEMEX_CONTEXTUAL_LLM = prevLlm;
  if (prevWrap === undefined) delete process.env.MEMEX_CONTEXTUAL_RETRIEVAL;
  else process.env.MEMEX_CONTEXTUAL_RETRIEVAL = prevWrap;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function tierRows(): Promise<{ content: string; tier: string | null; marked: boolean; vec: string }[]> {
  const r = await storage.engine().query<{ content: string; tier: string | null; marked: boolean; vec: string }>(
    `SELECT c.content, c.contextual_tier AS tier, c.contextual_embedded AS marked, e.vector::text AS vec
       FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
      WHERE c.document_id = (SELECT id FROM documents WHERE source_path = $1)
      ORDER BY c.chunk_index`,
    [SRC],
  );
  return r.rows;
}

describe("the indexer records the tier it used", () => {
  it("marks a Haiku-situated chunk llm", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: situating });
    const rows = await tierRows();
    expect(rows.map((r) => [r.tier, r.marked])).toEqual([["llm", true], ["llm", true]]);
  });

  it("marks a chunk whose LLM call fell back deterministic", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: failing });
    const rows = await tierRows();
    expect(rows.map((r) => [r.tier, r.marked])).toEqual([["deterministic", true], ["deterministic", true]]);
  });

  it("marks a chunk embedded with wrapping off none", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn });
    const rows = await tierRows();
    expect(rows.map((r) => [r.tier, r.marked])).toEqual([["none", false], ["none", false]]);
  });

  it("lets a reused chunk keep its own tier", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: situating });
    // Re-put with a new section and the LLM failing: the two reused chunks stay
    // llm, only the new one is deterministic.
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 9, 2]) }, { embedFn, contextualLlmFn: failing });
    const rows = await tierRows();
    expect(rows.map((r) => r.tier)).toEqual(["llm", "deterministic", "llm"]);
  });
});

describe("a re-embed never lowers a chunk's tier", () => {
  it("keeps an llm chunk when a forced re-embed runs without the LLM tier", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: situating });
    const before = await tierRows();

    const r = await runContextualReembed(storage.engine(), { embed: embedFn, force: true });
    expect(r.tierKept).toBe(2);
    expect(r.chunks).toBe(0);

    const after = await tierRows();
    expect(after.map((row) => row.tier)).toEqual(["llm", "llm"]);
    expect(after.map((row) => row.vec)).toEqual(before.map((row) => row.vec));
  });

  it("keeps an llm chunk when the LLM call falls back during a forced re-embed", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: situating });
    const before = await tierRows();

    const r = await runContextualReembed(storage.engine(), { embed: embedFn, llmFn: failing, force: true });
    expect(r.tierKept).toBe(2);
    expect((await tierRows()).map((row) => row.vec)).toEqual(before.map((row) => row.vec));
  });

  it("still upgrades a deterministic chunk when the LLM answers", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: failing });
    const r = await runContextualReembed(storage.engine(), { embed: embedFn, llmFn: situating, force: true });
    expect(r.llmContext).toBe(2);
    expect((await tierRows()).map((row) => row.tier)).toEqual(["llm", "llm"]);
  });

  it("does not re-pay for chunks a write already wrapped", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: failing });
    // Not forced: the write marked both chunks, so there is nothing to do.
    const r = await runContextualReembed(storage.engine(), { embed: embedFn, llmFn: situating });
    expect(r.chunks).toBe(0);
  });

  it("records the downgrade when the embed backfill rebuilds an llm chunk", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc([1, 2]) }, { embedFn, contextualLlmFn: situating });
    // The backfill (a signature change, `memex embed --all`) can only rebuild
    // with the deterministic prefix; the tier must say so, or the next
    // contextual re-embed would "keep" a vector that already lost its LLM context.
    await storage.engine().query(
      `DELETE FROM embeddings WHERE chunk_id IN (
         SELECT id FROM chunks WHERE document_id = (SELECT id FROM documents WHERE source_path = $1))`,
      [SRC],
    );
    const b = await runEmbedBackfill(storage.engine(), { embed: embedFn });
    expect(b.embedded).toBe(2);
    expect((await tierRows()).map((row) => row.tier)).toEqual(["deterministic", "deterministic"]);

    const r = await runContextualReembed(storage.engine(), { embed: embedFn, llmFn: situating, force: true });
    expect(r.tierKept).toBe(0);
    expect(r.llmContext).toBe(2);
  });
});
