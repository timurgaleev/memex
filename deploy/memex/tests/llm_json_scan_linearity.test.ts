/**
 * The salvage scans that pull JSON back out of a model reply must stay linear
 * in reply length.
 *
 * Three of them re-scanned the whole string from every opening character:
 *
 *   - facts-classify's brace scan `/\{[\s\S]*?\}/` — 60 ms for a 16 K run of
 *     `{`, ratio 3.96-4.04 on a doubling (quadratic).
 *   - facts-classify's trailing-fence strip `/\s*```$/` — 97 ms for a 16 K
 *     space run anywhere in the reply, ratio 3.99-4.03.
 *   - two-pass's index-array scan `/\[[^\]]*\]/` — 96 ms for a 16 K run of
 *     `[` measured through rerank(), ratio 3.81-4.05.
 *
 * Each is now bounded by the call's own `maxTokens` cap, which is what makes
 * the scan linear; these tests hold that bound in place. The ceiling is loose
 * on purpose — linear finishes in tens to hundreds of milliseconds, the old
 * shapes needed a minute or more at these sizes.
 */
import { describe, expect, it } from "bun:test";
import { parseClassifierJson } from "../src/core/facts-classify.ts";
import { rerank } from "../src/core/search/two-pass.ts";
import type { ChunkScore } from "../src/core/search/dedup.ts";

const CEILING_MS = 10_000;
const RUN = 500_000;

interface Payload {
  content: string;
  title: string | null;
  sourcePath: string;
}

const HITS: ChunkScore<Payload>[] = [
  {
    chunkId: "a",
    documentId: "doc-a",
    score: 1,
    payload: { content: "x", title: "A", sourcePath: "a.md" },
  },
  {
    chunkId: "b",
    documentId: "doc-b",
    score: 0.5,
    payload: { content: "y", title: "B", sourcePath: "b.md" },
  },
];

/** A Bedrock client stub that answers with whatever text the test names. */
const stubClient = (text: string) =>
  ({
    send: async () => ({ output: { message: { content: [{ text }] } } }),
  }) as never;

describe("classifier verdict salvage cost", () => {
  it("stays linear on a 500 K run of unclosed braces", () => {
    const started = performance.now();
    const out = parseClassifierJson("{".repeat(RUN), new Set([1]));
    const elapsed = performance.now() - started;
    expect(out).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear on a 500 K space run in the reply", () => {
    const started = performance.now();
    const out = parseClassifierJson(`a${" ".repeat(RUN)}b`, new Set([1]));
    const elapsed = performance.now() - started;
    expect(out).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still reads a fenced verdict, and still rejects an unlisted id", () => {
    const ids = new Set([3]);
    expect(
      parseClassifierJson('```json\n{"decision":"duplicate","matched_id":3}\n```', ids),
    ).toEqual({ decision: "duplicate", matchedId: 3 });
    expect(
      parseClassifierJson('here you go: {"decision":"supersede","matched_id":3} thanks', ids),
    ).toEqual({ decision: "supersede", matchedId: 3 });
    expect(parseClassifierJson('{"decision":"independent","matched_id":null}', ids)).toEqual({
      decision: "independent",
      matchedId: null,
    });
    expect(parseClassifierJson('{"decision":"duplicate","matched_id":99}', ids)).toBeNull();
  });
});

describe("rerank index-array salvage cost", () => {
  it("stays linear on a 500 K run of unclosed brackets", async () => {
    const started = performance.now();
    const out = await rerank("q", HITS, { client: stubClient("[".repeat(RUN)) });
    const elapsed = performance.now() - started;
    // No array in the reply — the input order survives unchanged.
    expect(out.map((h) => h.chunkId)).toEqual(["a", "b"]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still reorders on a well-formed reply", async () => {
    const out = await rerank("q", HITS, { client: stubClient("sure: [1,0]") });
    expect(out.map((h) => h.chunkId)).toEqual(["b", "a"]);
  });
});
