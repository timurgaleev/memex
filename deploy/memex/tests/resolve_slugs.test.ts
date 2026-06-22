/**
 * resolveSlugs — fuzzy partial/typo → canonical page slugs, ranked.
 * Offline: PGLite Storage, no Bedrock. pg_trgm `similarity()` comes from
 * migration 033, which `storage.init()` applies.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { resolveSlugs } from "../src/core/slug-resolve.ts";

describe("resolveSlugs", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-resolveslugs-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    await putPage(storage, {
      slug: "people/bob-jones",
      type: "person",
      title: "Bob Jones",
    });
    await putPage(storage, {
      slug: "companies/acme",
      type: "company",
      title: "Acme Corp",
    });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves a typo to the right page, ranked first", async () => {
    const hits = await resolveSlugs(storage, "alce smth");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.slug).toBe("people/alice-smith");
    expect(hits[0]!.title).toBe("Alice Smith");
    expect(hits[0]!.score).toBeGreaterThan(0.3);
  });

  it("resolves a partial title to the matching slug", async () => {
    const hits = await resolveSlugs(storage, "acme");
    expect(hits[0]!.slug).toBe("companies/acme");
  });

  it("returns score-1 exact-slug match outright", async () => {
    const hits = await resolveSlugs(storage, "companies/acme");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.slug).toBe("companies/acme");
    expect(hits[0]!.score).toBe(1);
  });

  it("orders candidates by descending score", async () => {
    const hits = await resolveSlugs(storage, "alice smith");
    const scores = hits.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(hits[0]!.slug).toBe("people/alice-smith");
  });

  it("honours the limit", async () => {
    const hits = await resolveSlugs(storage, "s", { limit: 1, threshold: 0 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it("excludes soft-deleted pages", async () => {
    await storage
      .engine()
      .exec(
        "UPDATE pages SET deleted_at = now() WHERE slug = 'people/alice-smith'",
      );
    const hits = await resolveSlugs(storage, "alce smth");
    expect(hits.find((h) => h.slug === "people/alice-smith")).toBeUndefined();
  });

  it("returns [] for an empty query", async () => {
    expect(await resolveSlugs(storage, "   ")).toEqual([]);
  });

  it("throws on an out-of-range limit", async () => {
    await expect(resolveSlugs(storage, "acme", { limit: 0 })).rejects.toThrow(
      /limit/,
    );
    await expect(resolveSlugs(storage, "acme", { limit: 101 })).rejects.toThrow(
      /limit/,
    );
  });

  it("throws on an out-of-range threshold", async () => {
    await expect(
      resolveSlugs(storage, "acme", { threshold: 1.5 }),
    ).rejects.toThrow(/threshold/);
  });
});
