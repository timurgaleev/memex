/**
 * Pages — DB-canonical page store CRUD tests.
 *
 * Covers slug validation, idempotent put, content versioning, append,
 * soft delete, list filters, and the page_versions audit trail.
 *
 * Uses a fresh PGLite-backed Storage per test — no Bedrock, no HTTP.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  appendPage,
  deletePage,
  getPage,
  KNOWN_PAGE_TYPES,
  listPages,
  pageVersions,
  putPage,
  validateSlug,
} from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-pages-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

describe("validateSlug", () => {
  it("accepts kebab-case", () => {
    expect(() => validateSlug("alice")).not.toThrow();
    expect(() => validateSlug("the-quick-brown-fox")).not.toThrow();
  });

  it("accepts /-namespaces", () => {
    expect(() =>
      validateSlug("journal/2026/05/2026-05-18"),
    ).not.toThrow();
    expect(() => validateSlug("people/alice-smith")).not.toThrow();
  });

  it("rejects uppercase", () => {
    expect(() => validateSlug("Alice")).toThrow(/kebab-case/);
  });

  it("rejects leading hyphen / slash", () => {
    expect(() => validateSlug("-alice")).toThrow();
    expect(() => validateSlug("/alice")).toThrow();
  });

  it("rejects spaces", () => {
    expect(() => validateSlug("alice smith")).toThrow();
  });

  it("rejects empty", () => {
    expect(() => validateSlug("")).toThrow(/non-empty/);
  });

  it("rejects double-slash", () => {
    expect(() => validateSlug("a//b")).toThrow();
  });

  it("rejects overly long slugs", () => {
    expect(() => validateSlug("a".repeat(257))).toThrow(/exceeds/);
  });
});

// ---------------------------------------------------------------------------
// putPage — first write
// ---------------------------------------------------------------------------

describe("putPage — first write", () => {
  it("creates a page with version_n=1", async () => {
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Met Alice at the conference.",
    });
    expect(r.created).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(1);
    expect(r.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an unknown type by default", async () => {
    await expect(
      putPage(storage, { slug: "x", type: "spaceship" }),
    ).rejects.toThrow(/KNOWN_PAGE_TYPES/);
  });

  it("accepts an ad-hoc type when allowAdHocType=true", async () => {
    const r = await putPage(storage, {
      slug: "ufo-sighting-2026",
      type: "ufo-report",
      allowAdHocType: true,
    });
    expect(r.created).toBe(true);
  });

  it("normalises type to lowercase", async () => {
    await putPage(storage, { slug: "alice", type: "PERSON" });
    const row = await getPage(storage, "alice");
    expect(row?.type).toBe("person");
  });

  it("every well-known type is accepted", async () => {
    for (const t of KNOWN_PAGE_TYPES) {
      await putPage(storage, { slug: `test-${t}`, type: t });
    }
  });
});

// ---------------------------------------------------------------------------
// putPage — idempotent re-put
// ---------------------------------------------------------------------------

describe("putPage — idempotency", () => {
  it("identical re-put is a no-op", async () => {
    const a = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Note 1",
    });
    const b = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Note 1",
    });
    expect(b.created).toBe(false);
    expect(b.changed).toBe(false);
    expect(b.version_n).toBe(a.version_n);
    const versions = await pageVersions(storage, "alice");
    expect(versions.length).toBe(1);
  });

  it("body change bumps version", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v1",
    });
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v2",
    });
    expect(r.created).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(2);
  });

  it("title change without body change still bumps version", async () => {
    await putPage(storage, { slug: "alice", type: "person", title: "Alice" });
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice Smith",
    });
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(2);
  });

  it("compiled_truth change bumps version", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      compiled_truth: { tier: 1 },
    });
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      compiled_truth: { tier: 2 },
    });
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getPage
// ---------------------------------------------------------------------------

describe("getPage", () => {
  it("returns null for unknown slug", async () => {
    const r = await getPage(storage, "ghost");
    expect(r).toBeNull();
  });

  it("returns the latest row", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Initial note.",
      compiled_truth: { tier: 1 },
    });
    const r = await getPage(storage, "alice");
    expect(r).not.toBeNull();
    expect(r!.slug).toBe("alice");
    expect(r!.type).toBe("person");
    expect(r!.title).toBe("Alice");
    expect(r!.markdown_body).toBe("Initial note.");
    expect(r!.compiled_truth).toEqual({ tier: 1 });
  });

  it("does not return soft-deleted pages", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await deletePage(storage, "alice");
    expect(await getPage(storage, "alice")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPages
// ---------------------------------------------------------------------------

describe("listPages", () => {
  it("returns newest-first", async () => {
    await putPage(storage, { slug: "old", type: "note", markdown_body: "a" });
    // Force a measurable delta in updated_at.
    await new Promise((r) => setTimeout(r, 10));
    await putPage(storage, { slug: "new", type: "note", markdown_body: "b" });
    const r = await listPages(storage);
    expect(r.length).toBe(2);
    expect(r[0]!.slug).toBe("new");
    expect(r[1]!.slug).toBe("old");
  });

  it("filters by type", async () => {
    await putPage(storage, { slug: "p1", type: "person" });
    await putPage(storage, { slug: "p2", type: "person" });
    await putPage(storage, { slug: "c1", type: "company" });
    const persons = await listPages(storage, { type: "person" });
    expect(persons.length).toBe(2);
    expect(persons.every((p) => p.type === "person")).toBe(true);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await putPage(storage, { slug: `p-${i}`, type: "note" });
    }
    const r = await listPages(storage, { limit: 3 });
    expect(r.length).toBe(3);
  });

  it("omits soft-deleted pages", async () => {
    await putPage(storage, { slug: "kept", type: "note" });
    await putPage(storage, { slug: "gone", type: "note" });
    await deletePage(storage, "gone");
    const r = await listPages(storage);
    expect(r.length).toBe(1);
    expect(r[0]!.slug).toBe("kept");
  });
});

// ---------------------------------------------------------------------------
// pageVersions
// ---------------------------------------------------------------------------

describe("pageVersions", () => {
  it("returns descending version_n", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v1",
    });
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v2",
    });
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v3",
    });
    const v = await pageVersions(storage, "alice");
    expect(v.map((x) => x.version_n)).toEqual([3, 2, 1]);
    expect(v[0]!.body_snapshot).toBe("v3");
    expect(v[2]!.hash_prev).toBeNull();
    expect(v[1]!.hash_prev).toBe(v[2]!.hash_new);
  });

  it("records written_by", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "x",
      written_by: "idea-capture-skill",
    });
    const v = await pageVersions(storage, "alice");
    expect(v[0]!.written_by).toBe("idea-capture-skill");
  });
});

// ---------------------------------------------------------------------------
// appendPage
// ---------------------------------------------------------------------------

describe("appendPage", () => {
  it("appends to existing body and bumps version", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "first line",
    });
    const r = await appendPage(storage, {
      slug: "alice",
      content: "second line",
    });
    expect(r.version_n).toBe(2);
    const got = await getPage(storage, "alice");
    expect(got!.markdown_body).toBe("first line\nsecond line");
  });

  it("does not double-newline when body already ends with \\n", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "first line\n",
    });
    await appendPage(storage, { slug: "alice", content: "second line" });
    const got = await getPage(storage, "alice");
    expect(got!.markdown_body).toBe("first line\nsecond line");
  });

  it("rejects appending to a page that does not exist", async () => {
    await expect(
      appendPage(storage, { slug: "ghost", content: "x" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("preserves type and compiled_truth across appends", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      compiled_truth: { tier: 1 },
      markdown_body: "x",
    });
    await appendPage(storage, { slug: "alice", content: "y" });
    const got = await getPage(storage, "alice");
    expect(got!.type).toBe("person");
    expect(got!.title).toBe("Alice");
    expect(got!.compiled_truth).toEqual({ tier: 1 });
  });
});

// ---------------------------------------------------------------------------
// deletePage
// ---------------------------------------------------------------------------

describe("deletePage", () => {
  it("soft-deletes (page row stays, versions stay)", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    const r = await deletePage(storage, "alice");
    expect(r.already_deleted).toBe(false);
    expect(await getPage(storage, "alice")).toBeNull();
    // Versions remain — query directly via engine.
    const v = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM page_versions WHERE slug = $1",
        ["alice"],
      );
    expect(v.rows[0]!.c).toBeGreaterThan(0);
  });

  it("appends a tombstone version row", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await deletePage(storage, "alice", "test-suite");
    const r = await storage
      .engine()
      .query<{ version_n: number; written_by: string | null }>(
        "SELECT version_n, written_by FROM page_versions WHERE slug = $1 ORDER BY version_n DESC",
        ["alice"],
      );
    expect(r.rows[0]!.version_n).toBe(2);
    expect(r.rows[0]!.written_by).toBe("test-suite");
  });

  it("re-delete is a no-op", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await deletePage(storage, "alice");
    const r = await deletePage(storage, "alice");
    expect(r.already_deleted).toBe(true);
  });

  it("delete of unknown slug returns already_deleted=true", async () => {
    const r = await deletePage(storage, "ghost");
    expect(r.already_deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transactional integrity
// ---------------------------------------------------------------------------

describe("putPage — transactional", () => {
  it("page + page_versions are written atomically", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    const page = await getPage(storage, "alice");
    const v = await pageVersions(storage, "alice");
    expect(page).not.toBeNull();
    expect(v.length).toBe(1);
    expect(v[0]!.hash_new).toBe(page!.content_hash);
  });
});
