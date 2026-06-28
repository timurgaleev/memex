/**
 * `extract --stale` incremental link re-extraction sweep — auto-remediates the
 * watermark (migration 051) that the inline put-path stamp leaves detect-only
 * after a version bump or for never-extracted pages. Mirrors the reference's
 * `extractStaleFromDB`: stamp clears the staleness predicate, idempotent on
 * re-run, dry-run is read-only.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { countStalePagesForExtraction } from "../src/core/links.ts";
import { extractStaleLinks } from "../src/core/links-stale-sweep.ts";
import { registerSource } from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-stalesweep-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function linkCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM links",
  );
  return r.rows[0]?.n ?? 0;
}

describe("extractStaleLinks", () => {
  it("re-extracts links for stale pages and clears the watermark", async () => {
    // Raw putPage (not the MCP dispatch path) leaves links_extracted_at NULL.
    await putPage(storage, { slug: "people/b", type: "person" });
    await putPage(storage, {
      slug: "people/a",
      type: "person",
      markdown_body: "knows [[people/b]] well",
    });
    expect(await countStalePagesForExtraction(storage.engine())).toBe(2);
    expect(await linkCount()).toBe(0);

    const res = await extractStaleLinks(storage, { jsonMode: true });

    expect(res.pagesProcessed).toBe(2);
    expect(res.staleRemaining).toBe(0);
    expect(res.budgetHit).toBe(false);
    // The wikilink [[people/b]] from people/a was synced.
    expect(await linkCount()).toBe(1);
    expect(await countStalePagesForExtraction(storage.engine())).toBe(0);
  });

  it("is idempotent — a second sweep finds nothing stale", async () => {
    await putPage(storage, { slug: "people/a", type: "person", markdown_body: "x" });
    await extractStaleLinks(storage, { jsonMode: true });

    const res2 = await extractStaleLinks(storage, { jsonMode: true });
    expect(res2.pagesProcessed).toBe(0);
    expect(res2.staleRemaining).toBe(0);
  });

  it("clears the version-staleness arm for a page edited before the version bump", async () => {
    const e = storage.engine();
    // Simulate the version-bump case: a page last edited AND extracted BEFORE
    // the current LINK_EXTRACTOR_VERSION_TS. Its updated_at predates the
    // version, so stamping raw updated_at would leave it stale forever.
    await putPage(storage, { slug: "people/a", type: "person", markdown_body: "x" });
    await e.query(
      "UPDATE pages SET updated_at = '2026-01-01T00:00:00Z', links_extracted_at = '2026-01-01T00:00:00Z' WHERE slug = $1",
      ["people/a"],
    );
    // Stale only via the version arm (links_extracted_at < versionTs).
    expect(await countStalePagesForExtraction(e)).toBe(1);

    const res = await extractStaleLinks(storage, { jsonMode: true });
    expect(res.pagesProcessed).toBe(1);
    expect(res.staleRemaining).toBe(0);
    // Idempotent: the version arm is cleared, so a second sweep finds nothing.
    const res2 = await extractStaleLinks(storage, { jsonMode: true });
    expect(res2.pagesProcessed).toBe(0);
  });

  it("dry-run reports the count without stamping", async () => {
    await putPage(storage, { slug: "people/a", type: "person" });
    const res = await extractStaleLinks(storage, { dryRun: true, jsonMode: true });

    expect(res.pagesProcessed).toBe(0);
    expect(res.staleRemaining).toBe(1);
    // Still stale — dry-run did not stamp.
    expect(await countStalePagesForExtraction(storage.engine())).toBe(1);
  });

  it("scopes to the given source", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "s1", kind: "vault", pathPrefix: "/s1" });
    await registerSource(e, { id: "s2", kind: "vault", pathPrefix: "/s2" });
    await putPage(storage, { slug: "people/a", type: "person", source_id: "s1" });
    await putPage(storage, { slug: "people/b", type: "person", source_id: "s2" });

    const res = await extractStaleLinks(storage, { jsonMode: true, sourceIds: ["s1"] });
    expect(res.pagesProcessed).toBe(1);
    // people/b (s2) is untouched → still stale.
    expect(await countStalePagesForExtraction(storage.engine(), { sourceIds: ["s2"] })).toBe(1);
  });
});
