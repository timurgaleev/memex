/**
 * Fact lifecycle columns (migration 085) + the lifecycle read surface:
 * visibility / context / source_session on write, session / grep / visibility /
 * include_forgotten filters on listFacts, the superseded_by pointer, the
 * supersessions audit view, and the pending-consolidation count piggy-back.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  addFact,
  countUnconsolidatedFacts,
  entityRecall,
  listFacts,
  listSupersessions,
} from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-facts-lc-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("addFact lifecycle metadata (mig085)", () => {
  it("stamps visibility / context / source_session; defaults to private", async () => {
    await addFact(storage, {
      entity_slug: "people/bob",
      fact: "moved to Lisbon",
      visibility: "world",
      context: "said during standup",
      source_session: "topic-42",
    });
    await addFact(storage, { entity_slug: "people/bob", fact: "likes tea" });
    const rows = await listFacts(storage, "people/bob", { order: "recency" });
    const world = rows.find((r) => r.fact === "moved to Lisbon")!;
    expect(world.visibility).toBe("world");
    expect(world.context).toBe("said during standup");
    expect(world.source_session).toBe("topic-42");
    const dflt = rows.find((r) => r.fact === "likes tea")!;
    expect(dflt.visibility).toBe("private");
    expect(dflt.source_session).toBeNull();
  });

  it("drops an unrecognized visibility to the private default", async () => {
    await addFact(storage, {
      entity_slug: "people/bob",
      fact: "x",
      visibility: "public-ish",
    });
    const rows = await listFacts(storage, "people/bob");
    expect(rows[0]!.visibility).toBe("private");
  });
});

describe("listFacts lifecycle filters (G35)", () => {
  beforeEach(async () => {
    await addFact(storage, {
      entity_slug: "people/carol",
      fact: "joined Acme as CTO",
      source_session: "s1",
      visibility: "world",
    });
    await addFact(storage, {
      entity_slug: "people/carol",
      fact: "prefers espresso",
      source_session: "s2",
    });
  });

  it("filters by session", async () => {
    const rows = await listFacts(storage, "people/carol", { session: "s1" });
    expect(rows.map((r) => r.fact)).toEqual(["joined Acme as CTO"]);
  });

  it("greps case-insensitively with literal metacharacters", async () => {
    const rows = await listFacts(storage, "people/carol", { grep: "ESPRESSO" });
    expect(rows.map((r) => r.fact)).toEqual(["prefers espresso"]);
    // `%` must match literally, not as a wildcard.
    expect(await listFacts(storage, "people/carol", { grep: "%" })).toHaveLength(0);
  });

  it("gates on visibility", async () => {
    const rows = await listFacts(storage, "people/carol", {
      visibility: ["world"],
    });
    expect(rows.map((r) => r.fact)).toEqual(["joined Acme as CTO"]);
  });

  it("hides tombstones by default; include_forgotten opts in", async () => {
    const rows = await listFacts(storage, "people/carol");
    const id = rows.find((r) => r.fact === "prefers espresso")!.id;
    await forgetFact(storage, id, { reason: "stale" });
    const live = await listFacts(storage, "people/carol");
    expect(live.map((r) => r.fact)).toEqual(["joined Acme as CTO"]);
    const all = await listFacts(storage, "people/carol", {
      include_forgotten: true,
    });
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === id)!.forgotten_at).not.toBeNull();
  });
});

describe("supersede pointer + audit view (mig085)", () => {
  /** Fake classifier that always rules supersede against the first candidate. */
  const supersedeHaiku: LlmFn = async (input) => {
    const m = input.user.match(/id="(\d+)"/);
    return {
      text: JSON.stringify({ decision: "supersede", matched_id: m ? Number(m[1]) : null }),
      modelId: "eu.anthropic.claude-haiku-4-5-v1:0",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };
  /** Two texts at cosine 0.5 — below the fast-path, forcing the classifier. */
  function embedFor(text: string): Promise<number[]> {
    const v = new Array(1024).fill(0);
    if (text.includes("old")) v[0] = 1;
    else {
      v[0] = 0.5;
      v[1] = Math.sqrt(0.75);
    }
    return Promise.resolve(v);
  }

  it("stamps superseded_by and surfaces the chain in listSupersessions", async () => {
    const oldFact = await addFact(storage, {
      entity_slug: "people/dan",
      fact: "old title: engineer",
      dedup: { embed: embedFor },
    });
    const newFact = await addFact(storage, {
      entity_slug: "people/dan",
      fact: "new title: staff engineer",
      dedup: { embed: embedFor, llmFn: supersedeHaiku },
    });
    expect(newFact.inserted).toBe(true);

    const audit = await listSupersessions(storage, { entity_slug: "people/dan" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.id).toBe(oldFact.id!);
    expect(audit[0]!.superseded_by).toBe(newFact.id!);
    expect(audit[0]!.forgotten_at).not.toBeNull();

    // Scope safety: a disjoint source scope sees no rows.
    expect(
      await listSupersessions(storage, { sourceIds: ["nonexistent"] }),
    ).toHaveLength(0);
  });
});

describe("pending-consolidation count", () => {
  it("counts live unconsolidated facts and rides entityRecall", async () => {
    await addFact(storage, { entity_slug: "people/eve", fact: "a" });
    await addFact(storage, { entity_slug: "people/eve", fact: "b" });
    expect(await countUnconsolidatedFacts(storage)).toBe(2);

    const r = await entityRecall(storage, "people/eve", { include_pending: true });
    expect(r.pending_consolidation_count).toBe(2);
    // Not requested -> field absent.
    const plain = await entityRecall(storage, "people/eve");
    expect(plain.pending_consolidation_count).toBeUndefined();
  });
});
