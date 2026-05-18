/**
 * hot_memory tests (Phase A.5) -- schema + thin CRUD wrapper.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  listHotFacts,
  recordHotFact,
  supersedeHotFact,
} from "../src/core/hot_memory.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-hot-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("recordHotFact", () => {
  it("inserts a row about a soft-stub entity", async () => {
    const r = await recordHotFact(storage, {
      entity_slug: "people/ghost",
      fact: "first observation",
      effective_confidence: 0.7,
      session_id: "sess-1",
    });
    expect(r.id).toBeGreaterThan(0);
  });

  it("rejects empty fact", async () => {
    await expect(
      recordHotFact(storage, { entity_slug: "x", fact: "" }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects out-of-range confidence", async () => {
    await expect(
      recordHotFact(storage, {
        entity_slug: "x",
        fact: "y",
        effective_confidence: 1.7,
      }),
    ).rejects.toThrow(/\[0, 1\]/);
  });

  it("validates source_slug grammar", async () => {
    await expect(
      recordHotFact(storage, {
        entity_slug: "x",
        fact: "y",
        source_slug: "Bad Slug",
      }),
    ).rejects.toThrow(/kebab-case/);
  });
});

describe("supersedeHotFact", () => {
  it("marks old row as superseded by new", async () => {
    const a = await recordHotFact(storage, {
      entity_slug: "people/alice",
      fact: "works at Acme",
    });
    const b = await recordHotFact(storage, {
      entity_slug: "people/alice",
      fact: "works at Globex",
    });
    const r = await supersedeHotFact(storage, a.id, b.id);
    expect(r.updated).toBe(true);
    expect(r.superseded_by).toBe(b.id);
    const live = await listHotFacts(storage, "people/alice");
    expect(live.length).toBe(1);
    expect(live[0]!.fact).toBe("works at Globex");
  });

  it("re-superseding with the same new id is idempotent", async () => {
    const a = await recordHotFact(storage, {
      entity_slug: "x",
      fact: "a",
    });
    const b = await recordHotFact(storage, {
      entity_slug: "x",
      fact: "b",
    });
    await supersedeHotFact(storage, a.id, b.id);
    const r = await supersedeHotFact(storage, a.id, b.id);
    expect(r.updated).toBe(true);
    expect(r.superseded_by).toBe(b.id);
  });

  it("losing concurrent supersede reveals the winner via superseded_by", async () => {
    const a = await recordHotFact(storage, { entity_slug: "x", fact: "a" });
    const b = await recordHotFact(storage, { entity_slug: "x", fact: "b" });
    const c = await recordHotFact(storage, { entity_slug: "x", fact: "c" });
    const won = await supersedeHotFact(storage, a.id, b.id);
    expect(won.updated).toBe(true);
    const lost = await supersedeHotFact(storage, a.id, c.id);
    expect(lost.updated).toBe(false);
    expect(lost.superseded_by).toBe(b.id);
  });

  it("rejects self-supersede", async () => {
    const a = await recordHotFact(storage, {
      entity_slug: "x",
      fact: "y",
    });
    await expect(supersedeHotFact(storage, a.id, a.id)).rejects.toThrow(
      /itself/,
    );
  });
});

describe("listHotFacts", () => {
  it("unsuperseded_only filters out replaced rows by default", async () => {
    const a = await recordHotFact(storage, { entity_slug: "x", fact: "a" });
    const b = await recordHotFact(storage, { entity_slug: "x", fact: "b" });
    await supersedeHotFact(storage, a.id, b.id);
    const r = await listHotFacts(storage, "x");
    expect(r.length).toBe(1);
    expect(r[0]!.id).toBe(b.id);
  });

  it("unsuperseded_only=false returns the full chain", async () => {
    const a = await recordHotFact(storage, { entity_slug: "x", fact: "a" });
    const b = await recordHotFact(storage, { entity_slug: "x", fact: "b" });
    await supersedeHotFact(storage, a.id, b.id);
    const r = await listHotFacts(storage, "x", { unsuperseded_only: false });
    expect(r.length).toBe(2);
  });

  it("filters by session_id", async () => {
    await recordHotFact(storage, {
      entity_slug: "x",
      fact: "a",
      session_id: "s1",
    });
    await recordHotFact(storage, {
      entity_slug: "x",
      fact: "b",
      session_id: "s2",
    });
    const r = await listHotFacts(storage, "x", { session_id: "s1" });
    expect(r.length).toBe(1);
    expect(r[0]!.fact).toBe("a");
  });

  it("orders by confidence DESC", async () => {
    await recordHotFact(storage, {
      entity_slug: "x",
      fact: "low",
      effective_confidence: 0.3,
    });
    await recordHotFact(storage, {
      entity_slug: "x",
      fact: "high",
      effective_confidence: 0.95,
    });
    const r = await listHotFacts(storage, "x");
    expect(r[0]!.fact).toBe("high");
  });
});
