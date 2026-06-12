/**
 * Declared page aliases (migration 034) — normalization, the
 * compiled_truth → page_aliases sync on putPage, and unique alias
 * resolution (collision-safe).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import {
  extractAliasNorms,
  normalizeAlias,
  resolveAliasUnique,
  setPageAliases,
} from "../src/core/page-aliases.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-alias-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function aliasRows(slug: string): Promise<string[]> {
  const r = await storage.engine().query<{ alias_norm: string }>(
    `SELECT alias_norm FROM page_aliases WHERE slug = $1 ORDER BY alias_norm`,
    [slug],
  );
  return r.rows.map((x) => x.alias_norm);
}

describe("normalizeAlias", () => {
  it("lowercases, NFKC-folds, collapses whitespace, trims", () => {
    expect(normalizeAlias("  Robert   Smith ")).toBe("robert smith");
    expect(normalizeAlias("ACME")).toBe("acme");
    expect(normalizeAlias("\tBob\n")).toBe("bob");
  });

  it("returns empty for non-strings / blanks", () => {
    expect(normalizeAlias(123)).toBe("");
    expect(normalizeAlias("   ")).toBe("");
    expect(normalizeAlias(null)).toBe("");
  });

  it("does NOT truncate (length is enforced by the indexable check)", () => {
    const long = "a".repeat(250);
    expect(normalizeAlias(long)).toBe(long); // full string, uncut
  });
});

describe("extractAliasNorms", () => {
  it("pulls + normalizes + dedupes a string array", () => {
    expect(
      extractAliasNorms({ aliases: ["Robert", "robert ", "Bobby", 42, ""] }),
    ).toEqual(["robert", "bobby"]);
  });

  it("returns [] when aliases is missing or not an array", () => {
    expect(extractAliasNorms({})).toEqual([]);
    expect(extractAliasNorms({ aliases: "Robert" })).toEqual([]);
    expect(extractAliasNorms(null)).toEqual([]);
  });

  it("drops an over-limit alias instead of truncating", () => {
    const long = "x".repeat(201);
    expect(extractAliasNorms({ aliases: [long, "ok"] })).toEqual(["ok"]);
  });
});

describe("putPage → page_aliases sync", () => {
  it("writes declared aliases on create", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Robert", "Bobby"] },
    });
    expect(await aliasRows("people/bob")).toEqual(["bobby", "robert"]);
  });

  it("replaces the alias set on a content edit", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Robert"] },
      markdown_body: "v1",
    });
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Bobby"] },
      markdown_body: "v2",
    });
    expect(await aliasRows("people/bob")).toEqual(["bobby"]);
  });

  it("clears aliases when the page drops them", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Robert"] },
      markdown_body: "v1",
    });
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: {},
      markdown_body: "v2",
    });
    expect(await aliasRows("people/bob")).toEqual([]);
  });

  it("hard-deletes aliases via FK cascade", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Robert"] },
    });
    await storage.engine().query(`DELETE FROM pages WHERE slug = $1`, [
      "people/bob",
    ]);
    expect(await aliasRows("people/bob")).toEqual([]);
  });

  it("sanitizes NUL / lone surrogate in an alias (page write succeeds)", async () => {
    const NUL = String.fromCharCode(0);
    const loneSurrogate = String.fromCharCode(0xd800); // unpaired high half
    const r = await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: [`a${NUL}b`, `c${loneSurrogate}d`] },
    });
    expect(r.created).toBe(true); // the page write was NOT aborted by the NUL
    const rows = await aliasRows("people/bob");
    expect(rows.length).toBe(2);
    expect(rows).toContain("ab"); // NUL dropped: "a\0b" → "ab"
    expect(rows.some((a) => a.includes(NUL))).toBe(false);
  });
});

describe("resolveAliasUnique", () => {
  it("resolves a unique alias to its slug", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Robert"] },
    });
    expect(await resolveAliasUnique(storage, "robert", "journal/x")).toBe(
      "people/bob",
    );
  });

  it("returns null on a collision (two pages claim the alias)", async () => {
    await putPage(storage, {
      slug: "teams/red/standup",
      type: "note",
      compiled_truth: { aliases: ["Standup"] },
    });
    await putPage(storage, {
      slug: "teams/blue/standup",
      type: "note",
      compiled_truth: { aliases: ["Standup"] },
    });
    expect(await resolveAliasUnique(storage, "standup", "journal/x")).toBeNull();
  });

  it("treats a source-vs-other collision as a collision (not a resolve)", async () => {
    // Source page AND another page both claim "Robert" → real collision;
    // excluding the source must NOT silently resolve to the other one.
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Robert"] },
    });
    await putPage(storage, {
      slug: "people/robert-frost",
      type: "person",
      compiled_truth: { aliases: ["Robert"] },
    });
    expect(await resolveAliasUnique(storage, "robert", "people/bob")).toBeNull();
  });

  it("excludes the source slug + soft-deleted pages", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Robert"] },
    });
    // Self-exclusion: source IS the sole alias holder → null.
    expect(await resolveAliasUnique(storage, "robert", "people/bob")).toBeNull();
    // Soft-deleted holder → null.
    await deletePage(storage, "people/bob");
    expect(await resolveAliasUnique(storage, "robert", "journal/x")).toBeNull();
  });

  it("returns null for an empty alias", async () => {
    expect(await resolveAliasUnique(storage, "", "journal/x")).toBeNull();
  });
});

describe("setPageAliases (direct)", () => {
  it("is idempotent and replaces the set", async () => {
    await putPage(storage, { slug: "people/bob", type: "person" });
    await setPageAliases(storage.engine(), "people/bob", ["a", "b"]);
    await setPageAliases(storage.engine(), "people/bob", ["b", "c"]);
    expect(await aliasRows("people/bob")).toEqual(["b", "c"]);
  });
});
