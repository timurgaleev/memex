/**
 * Facts canonicalization + kind/notability threading + forget-survives-fence
 * + insert-time dedup/supersede.
 *
 * Covers the Tier-1 facts bundle:
 *   2a — writeExtractedFacts reattaches a loose entity name onto its existing
 *        canonical page (no phantom slug), falling back to slugify when novel.
 *   2b — kind / notability flow through addFact + writeExtractedFacts into the
 *        CHECK-constrained columns.
 *   2c — a forgotten fence-owned fact stays forgotten across a page re-put.
 *   3  — addFact insert-time dedup: cosine fast-path duplicate, classifier
 *        failure cosine fallback, independent insert, and supersede (mock Haiku).
 *
 * Offline: a deterministic stub embedder + fake Haiku seam stand in for Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact, listFacts } from "../src/core/facts.ts";
import { recallFact, forgetFact } from "../src/core/facts-recall.ts";
import { writeExtractedFacts, type ExtractedFact } from "../src/core/facts-extract.ts";
import { renderFactsFence, type ParsedFact } from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-facts-canon-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Unit-norm 1024-dim vector from a sparse (index -> weight) spec. */
function vec(spec: Record<number, number>): number[] {
  const v = new Array(1024).fill(0);
  for (const [i, w] of Object.entries(spec)) v[Number(i)] = w;
  return v;
}

/**
 * Deterministic stub embedder with controllable cosine geometry:
 *   gotham           -> e0                       (dup cluster anchor)
 *   nearfall         -> 0.93·e0 + 0.3676·e1      (cos 0.93 to gotham: fallback band)
 *   paris            -> e2                       (orthogonal / independent)
 *   super-old/new    -> cos 0.5                  (below fast-path, forces the LLM)
 */
function stubEmbed(text: string): Promise<number[]> {
  const t = text.toLowerCase();
  if (t.includes("gotham")) return Promise.resolve(vec({ 0: 1 }));
  if (t.includes("nearfall")) {
    return Promise.resolve(vec({ 0: 0.93, 1: Math.sqrt(1 - 0.93 * 0.93) }));
  }
  if (t.includes("paris")) return Promise.resolve(vec({ 2: 1 }));
  if (t.includes("super-old")) return Promise.resolve(vec({ 3: 1 }));
  if (t.includes("super-new")) {
    return Promise.resolve(vec({ 3: 0.5, 4: Math.sqrt(1 - 0.25) }));
  }
  return Promise.resolve(vec({ 7: 1 }));
}

/** Fake Haiku that returns a fixed verdict, substituting the first candidate id. */
function fakeHaiku(decision: "duplicate" | "supersede" | "independent"): LlmFn {
  return async (input) => {
    const m = input.user.match(/id="(\d+)"/);
    const id = m ? Number(m[1]) : null;
    const matched = decision === "independent" ? null : id;
    return {
      text: JSON.stringify({ decision, matched_id: matched }),
      modelId: "eu.anthropic.claude-haiku-4-5-v1:0",
      usage: { inputTokens: 50, outputTokens: 20 },
    };
  };
}

const throwingHaiku: LlmFn = () => Promise.reject(new Error("bedrock down"));

// ---------------------------------------------------------------------------
// 2a — canonicalization in writeExtractedFacts
// ---------------------------------------------------------------------------

describe("writeExtractedFacts canonicalization (2a)", () => {
  function xfact(entity: string): ExtractedFact {
    return { fact: `${entity} claim`, kind: "fact", entity, confidence: 0.9, notability: "medium" };
  }

  it("reattaches a loose display name onto its existing canonical page", async () => {
    await putPage(storage, { slug: "people/alice-smith", type: "person", title: "Alice Smith" });
    const r = await writeExtractedFacts(storage, [xfact("Alice")]);
    expect(r.written).toBe(1);
    // Attached to the canonical page — NOT a phantom `alice` slug.
    const canonical = await listFacts(storage, "people/alice-smith");
    expect(canonical.map((f) => f.fact)).toEqual(["Alice claim"]);
    expect(await listFacts(storage, "alice")).toHaveLength(0);
  });

  it("falls back to the slugify floor for a novel entity", async () => {
    const r = await writeExtractedFacts(storage, [xfact("Zorblax")]);
    expect(r.written).toBe(1);
    expect((await listFacts(storage, "zorblax")).map((f) => f.fact)).toEqual(["Zorblax claim"]);
  });

  it("skips a fact with no entity", async () => {
    const r = await writeExtractedFacts(storage, [
      { fact: "orphan", kind: "fact", entity: null, confidence: 0.5, notability: "low" },
    ]);
    expect(r).toEqual({ written: 0, skipped: 1 });
  });
});

// ---------------------------------------------------------------------------
// 2b — kind / notability threading
// ---------------------------------------------------------------------------

async function metaFor(slug: string): Promise<{ fact: string; kind: string | null; notability: string | null }[]> {
  const r = await storage.engine().query<{ fact: string; kind: string | null; notability: string | null }>(
    `SELECT fact, kind, notability FROM entity_facts WHERE entity_slug = $1 ORDER BY id`,
    [slug],
  );
  return r.rows;
}

describe("addFact kind/notability (2b)", () => {
  it("persists a valid kind + notability", async () => {
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "founded Acme in 2017",
      kind: "event",
      notability: "high",
    });
    expect(await metaFor("people/alice")).toEqual([
      { fact: "founded Acme in 2017", kind: "event", notability: "high" },
    ]);
  });

  it("drops an unrecognized kind/notability to NULL (never trips the CHECK)", async () => {
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "junk meta",
      kind: "nonsense",
      notability: "urgent",
    });
    expect(await metaFor("people/alice")).toEqual([
      { fact: "junk meta", kind: null, notability: null },
    ]);
  });

  it("writeExtractedFacts threads kind + notability through", async () => {
    await writeExtractedFacts(storage, [
      { fact: "likes tea", kind: "preference", entity: "Bob", confidence: 0.9, notability: "low" },
    ]);
    expect(await metaFor("bob")).toEqual([
      { fact: "likes tea", kind: "preference", notability: "low" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2c — forget survives a fence rebuild
// ---------------------------------------------------------------------------

function fenceBody(facts: ParsedFact[]): string {
  return `# Subject\n\nProse.\n\n## Facts\n${renderFactsFence(facts)}\n`;
}
async function putAndReconcile(slug: string, body: string) {
  const w = await putPage(storage, { slug, type: "person", markdown_body: body });
  return reconcileFactsForPage(storage, slug, w.content_hash);
}
async function liveCount(slug: string, fact: string): Promise<number> {
  const r = await storage.engine().query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM entity_facts
      WHERE entity_slug = $1 AND fact = $2 AND forgotten_at IS NULL`,
    [slug, fact],
  );
  return r.rows[0]?.c ?? 0;
}

describe("forget survives a fence rebuild (2c)", () => {
  it("a forgotten fence-owned fact is not resurrected by a page re-put", async () => {
    const body = fenceBody([
      { rowNum: 1, claim: "secret fact", confidence: 1, active: true },
      { rowNum: 2, claim: "kept fact", confidence: 1, active: true },
    ]);
    await putAndReconcile("people/carol", body);

    // Forget the fence-owned "secret fact" by id.
    const idRow = await storage.engine().query<{ id: number }>(
      `SELECT id FROM entity_facts WHERE entity_slug = $1 AND fact = 'secret fact'`,
      ["people/carol"],
    );
    const secretId = idRow.rows[0]!.id;
    const f = await forgetFact(storage, secretId);
    expect(f.forgotten).toBe(true);
    expect(await recallFact(storage, secretId)).toBeNull();

    // Re-put the identical page — the fence still lists "secret fact".
    const r = await putAndReconcile("people/carol", body);

    // It must stay forgotten: no LIVE row, tombstone preserved, "kept fact" live.
    expect(await liveCount("people/carol", "secret fact")).toBe(0);
    expect(await recallFact(storage, secretId)).toBeNull();
    expect(await liveCount("people/carol", "kept fact")).toBe(1);
    // The rebuild re-adds only the live "kept fact"; the forgotten claim is
    // skipped (its tombstone was spared, not deleted + re-inserted).
    expect(r.added).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3 — insert-time dedup / supersede
// ---------------------------------------------------------------------------

describe("addFact insert-time dedup (3)", () => {
  const E = "people/dave";

  it("cosine fast-path collapses a near-identical fact WITHOUT the LLM", async () => {
    const first = await addFact(storage, {
      entity_slug: E,
      fact: "lives in Gotham",
      dedup: { embed: stubEmbed, llmFn: throwingHaiku }, // LLM must NOT be reached
    });
    expect(first.inserted).toBe(true);
    const dup = await addFact(storage, {
      entity_slug: E,
      fact: "is based in Gotham",
      dedup: { embed: stubEmbed, llmFn: throwingHaiku },
    });
    // Same stub vector -> cosine 1.0 >= 0.95 -> duplicate, collapsed onto first.
    expect(dup.inserted).toBe(false);
    expect(dup.id).toBe(first.id);
    expect(await listFacts(storage, E)).toHaveLength(1);
  });

  it("classifier failure falls back to cosine >= 0.92 -> duplicate", async () => {
    const first = await addFact(storage, {
      entity_slug: E,
      fact: "lives in Gotham",
      dedup: { embed: stubEmbed, llmFn: throwingHaiku },
    });
    // cos 0.93 to the anchor, below the 0.95 fast-path -> LLM attempted -> throws
    // -> fallback cosine 0.93 >= 0.92 -> duplicate.
    const dup = await addFact(storage, {
      entity_slug: E,
      fact: "nearfall gotham-ish",
      dedup: { embed: stubEmbed, llmFn: throwingHaiku },
    });
    expect(dup.inserted).toBe(false);
    expect(dup.id).toBe(first.id);
  });

  it("inserts an independent fact (dissimilar, cosine-only path)", async () => {
    await addFact(storage, { entity_slug: E, fact: "lives in Gotham", dedup: { embed: stubEmbed } });
    const indep = await addFact(storage, {
      entity_slug: E,
      fact: "visited Paris once",
      dedup: { embed: stubEmbed }, // no llmFn -> cosine-only; cos 0 -> independent
    });
    expect(indep.inserted).toBe(true);
    expect(await listFacts(storage, E)).toHaveLength(2);
  });

  it("supersede: classifier retires the old fact and inserts the new one", async () => {
    const old = await addFact(storage, {
      entity_slug: E,
      fact: "super-old title CFO",
      dedup: { embed: stubEmbed, llmFn: fakeHaiku("duplicate") }, // unused this call (no candidates)
    });
    const fresh = await addFact(storage, {
      entity_slug: E,
      fact: "super-new title CEO",
      dedup: { embed: stubEmbed, llmFn: fakeHaiku("supersede") },
    });
    expect(fresh.inserted).toBe(true);
    expect(fresh.id).not.toBe(old.id);
    // Old fact tombstoned (superseded), new fact live.
    expect(await recallFact(storage, old.id!)).toBeNull();
    expect(await liveCount(E, "super-new title CEO")).toBe(1);
    const oldRow = await storage.engine().query<{ reason: string | null }>(
      `SELECT forgotten_reason AS reason FROM entity_facts WHERE id = $1`,
      [old.id],
    );
    expect(oldRow.rows[0]!.reason).toMatch(/superseded/);
  });

  it("default (no dedup opts) preserves the legacy manual-insert behavior", async () => {
    const a = await addFact(storage, { entity_slug: E, fact: "lives in Gotham" });
    const b = await addFact(storage, { entity_slug: E, fact: "lives in Gotham" });
    // No dedup -> both manual inserts land (mig018 skip-dedup on NULL chunk).
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(await listFacts(storage, E)).toHaveLength(2);
  });
});
