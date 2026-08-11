/**
 * Orphan exclusions.
 *
 * A brain writes plenty of pages that are islanded on purpose — synthesis
 * output, drift reports — and counting them is what turned the orphan number
 * into noise nobody reads.
 *
 * Exclusion is by PROVENANCE, not namespace. Excluding `atoms/` / `concepts/`
 * by slug was the shortcut, and it was wrong: page_put accepts any valid slug,
 * so an authored, genuinely unlinked `concepts/foo` would have vanished from
 * the very report meant to surface it. Hiding a real signal to quiet a noisy
 * count is a worse failure than the noise.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { findOrphans } from "../src/core/insights.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import {
  DEFAULT_ORPHAN_EXCLUDED_WRITERS,
  orphanExcludedWriters,
  isExcludedOrphanWriter,
} from "../src/core/orphan-policy.ts";

describe("orphanExcludedWriters", () => {
  it("defaults to the brain's own page writers", () => {
    expect(orphanExcludedWriters({})).toEqual([...DEFAULT_ORPHAN_EXCLUDED_WRITERS]);
  });

  it("EXTRA adds, WRITERS replaces", () => {
    expect(orphanExcludedWriters({ MEMEX_ORPHAN_EXCLUDE_EXTRA: "importer" })).toEqual([
      ...DEFAULT_ORPHAN_EXCLUDED_WRITERS,
      "importer",
    ]);
    expect(orphanExcludedWriters({ MEMEX_ORPHAN_EXCLUDE_WRITERS: "only-me" })).toEqual([
      "only-me",
    ]);
  });

  it("lets a brain turn exclusions off entirely", () => {
    // Presence is what counts: the plain `=` form has to work, not just a
    // whitespace string that happens to survive a length check.
    expect(orphanExcludedWriters({ MEMEX_ORPHAN_EXCLUDE_WRITERS: "" })).toEqual([]);
    expect(orphanExcludedWriters({ MEMEX_ORPHAN_EXCLUDE_WRITERS: " " })).toEqual([]);
    expect(orphanExcludedWriters({})).toEqual([...DEFAULT_ORPHAN_EXCLUDED_WRITERS]);
  });

  it("agrees with the predicate, and an unattributed write is never excluded", () => {
    expect(isExcludedOrphanWriter("extract-atoms", {})).toBe(true);
    expect(isExcludedOrphanWriter("timur", {})).toBe(false);
    expect(isExcludedOrphanWriter(null, {})).toBe(false);
  });
});

describe("findOrphans", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-orphanpolicy-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("omits pages the brain wrote for itself", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, {
      slug: "atoms/2026-01-01/a-thing-abc",
      type: "note",
      written_by: "extract-atoms",
    });
    await putPage(storage, {
      slug: "concepts/a-concept",
      type: "concept",
      written_by: "synthesize-concepts",
    });

    expect((await findOrphans(storage)).map((r) => r.slug)).toEqual(["people/alice"]);
  });

  it("still reports an authored page under the same namespace", async () => {
    // The namespace shortcut would have hidden this one — a real, unlinked page
    // the operator wrote, in the report that exists to surface it.
    await putPage(storage, { slug: "concepts/my-own-idea", type: "concept" });
    expect((await findOrphans(storage)).map((r) => r.slug)).toEqual([
      "concepts/my-own-idea",
    ]);
  });

  it("reports a synthesis page once a human edits it", async () => {
    // Current version, not "ever written by": editing it makes it theirs.
    await putPage(storage, {
      slug: "concepts/taken-over",
      type: "concept",
      written_by: "synthesize-concepts",
    });
    await putPage(storage, {
      slug: "concepts/taken-over",
      type: "concept",
      markdown_body: "my own words",
    });
    expect((await findOrphans(storage)).map((r) => r.slug)).toEqual([
      "concepts/taken-over",
    ]);
  });
});

describe("provenance a remote caller cannot claim", () => {
  let tmp2: string;
  let s2: Storage;

  beforeEach(async () => {
    tmp2 = mkdtempSync(join(tmpdir(), "memex-orphanauth-"));
    s2 = new Storage({ dbPath: join(tmp2, "db") });
    await s2.init();
  });

  afterEach(async () => {
    await s2.close();
    rmSync(tmp2, { recursive: true, force: true });
  });

  async function writerOf(slug: string): Promise<string | null> {
    const r = await s2
      .engine()
      .query<{ written_by: string | null }>(
        `SELECT written_by FROM page_versions WHERE slug = $1
          ORDER BY version_n DESC LIMIT 1`,
        [slug],
      );
    return r.rows[0]?.written_by ?? null;
  }

  it("rewrites a reserved writer claimed over a remote ingress", async () => {
    // Stamping `extract-atoms` on your own page would drop it out of the
    // operator's orphan report — the same laundering add_fact refuses.
    await dispatchTool(
      s2,
      {
        name: "page_put",
        arguments: {
          slug: "notes/sneaky",
          markdown_body: "x",
          written_by: "extract-atoms",
        },
      },
      { isPublic: true },
    );
    expect(await writerOf("notes/sneaky")).toBe("public");
    expect((await findOrphans(s2)).map((r) => r.slug)).toEqual(["notes/sneaky"]);
  });

  it("leaves an ordinary writer label alone", async () => {
    await dispatchTool(
      s2,
      {
        name: "page_put",
        arguments: { slug: "notes/honest", markdown_body: "x", written_by: "my-importer" },
      },
      { isPublic: true },
    );
    expect(await writerOf("notes/honest")).toBe("my-importer");
  });

  it("takes a trusted local caller's provenance at face value", async () => {
    await dispatchTool(s2, {
      name: "page_put",
      arguments: { slug: "atoms/x/local", markdown_body: "x", written_by: "extract-atoms" },
    });
    expect(await writerOf("atoms/x/local")).toBe("extract-atoms");
  });
});

describe("a page the brain only edited is still the author's", () => {
  let tmp3: string;
  let s3: Storage;

  beforeEach(async () => {
    tmp3 = mkdtempSync(join(tmpdir(), "memex-orphanenrich-"));
    s3 = new Storage({ dbPath: join(tmp3, "db") });
    await s3.init();
  });

  afterEach(async () => {
    await s3.close();
    rmSync(tmp3, { recursive: true, force: true });
  });

  it("keeps reporting an authored page after enrichment rewrites it", async () => {
    // enrich-thin rewrites EXISTING pages in place. Excluding `enrichment`
    // would make an authored page vanish the moment the brain expanded it —
    // the namespace false negative, reached from the other direction.
    await putPage(s3, { slug: "people/alice", type: "person" });
    await putPage(s3, {
      slug: "people/alice",
      type: "person",
      markdown_body: "expanded by the brain",
      written_by: "enrichment",
    });
    expect((await findOrphans(s3)).map((r) => r.slug)).toEqual(["people/alice"]);
  });
});
