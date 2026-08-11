/**
 * Bulk page retype.
 *
 * pages.type decides which enrichment paths see a page and is half of the diary
 * fence, so correcting it in bulk is useful and dangerous in equal measure.
 * The three things worth guarding are all here: what it refuses, what it does
 * NOT touch, and that the refusal reads the rows rather than the request.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { planRetype, applyRetype, RETYPE_MAX_PAGES } from "../src/core/page-retype.ts";
import { getIngestLog } from "../src/core/ingest-log.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-retype-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const engine = () => storage.engine();

describe("planRetype", () => {
  it("refuses a selection with no filter at all", async () => {
    const p = await planRetype(engine(), "person", {});
    expect(p.refusal).toContain("at least one of");
    expect(p.matches).toEqual([]);
  });

  it("groups the matched set by its current type", async () => {
    await putPage(storage, { slug: "people/a", type: "note" });
    await putPage(storage, { slug: "people/b", type: "note" });
    await putPage(storage, { slug: "people/c", type: "concept" });
    const p = await planRetype(engine(), "person", { pathPrefix: "people/" });
    expect(p.refusal).toBeNull();
    expect(p.byType).toEqual([
      { type: "note", count: 2 },
      { type: "concept", count: 1 },
    ]);
  });

  it("refuses fenced rows even when the SELECTOR never mentions them", async () => {
    // The whole point: refusing `--from diary` is not a refusal, because the
    // same rows are reachable by prefix. The fence keys on the row's type.
    await putPage(storage, { slug: "life/notes/x", type: "diary" });
    await putPage(storage, { slug: "life/notes/y", type: "note" });
    const p = await planRetype(engine(), "note", { pathPrefix: "life/" });
    expect(p.refusal).toContain("fenced from remote callers");
    expect(p.refusal).toContain("life/notes/x");
  });

  it("refuses retyping INTO a fenced type", async () => {
    await putPage(storage, { slug: "notes/a", type: "note" });
    const p = await planRetype(engine(), "diary", { pathPrefix: "notes/" });
    expect(p.refusal).toContain("refusing to retype INTO 'diary'");
  });
});

describe("applyRetype", () => {
  it("moves the type and records the operation once", async () => {
    await putPage(storage, { slug: "people/a", type: "note" });
    await putPage(storage, { slug: "people/b", type: "note" });
    const plan = await planRetype(engine(), "person", { from: "note" });
    const r = await applyRetype(engine(), plan, "operator");
    expect(r.updated).toBe(2);

    const rows = await engine().query<{ type: string }>(
      `SELECT type FROM pages WHERE slug LIKE 'people/%' ORDER BY slug`,
    );
    expect(rows.rows.map((x) => x.type)).toEqual(["person", "person"]);

    // One audit row for the operation, not one per page.
    const log = await getIngestLog(engine(), { limit: 20 });
    const entries = log.filter((e) => e.source_type === "page-retype");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pages_updated.sort()).toEqual(["people/a", "people/b"]);
  });

  it("does NOT touch updated_at", async () => {
    // updated_at is behavioural state: the stale-salient anomaly, the
    // recency-biased salience rank and get_recent_transcripts all read it.
    // Stamping NOW() on a bulk retype would erase an anomaly class and make
    // unrelated pages look fresh — irreversibly.
    await putPage(storage, { slug: "people/old", type: "note" });
    await engine().exec(
      `UPDATE pages SET updated_at = NOW() - interval '400 days' WHERE slug = 'people/old'`,
    );
    const before = await engine().query<{ u: string }>(
      `SELECT updated_at::text AS u FROM pages WHERE slug = 'people/old'`,
    );
    const plan = await planRetype(engine(), "person", { slugs: ["people/old"] });
    await applyRetype(engine(), plan, "operator");
    const after = await engine().query<{ u: string; t: string }>(
      `SELECT updated_at::text AS u, type AS t FROM pages WHERE slug = 'people/old'`,
    );
    expect(after.rows[0]!.t).toBe("person");
    expect(after.rows[0]!.u).toBe(before.rows[0]!.u);
  });

  it("writes no page_versions row — a type change is not a body edit", async () => {
    // Writing one would also mean computing version_n from an unlocked MAX(),
    // which races a concurrent page_put into a primary-key violation.
    await putPage(storage, { slug: "people/v", type: "note" });
    const before = await engine().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM page_versions WHERE slug = 'people/v'`,
    );
    const plan = await planRetype(engine(), "person", { slugs: ["people/v"] });
    await applyRetype(engine(), plan, "operator");
    const after = await engine().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM page_versions WHERE slug = 'people/v'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("refuses to apply a plan that was refused", async () => {
    await putPage(storage, { slug: "notes/a", type: "note" });
    const plan = await planRetype(engine(), "diary", { pathPrefix: "notes/" });
    await expect(applyRetype(engine(), plan, "operator")).rejects.toThrow(
      /refusing to retype INTO/,
    );
  });

  it("has a cap that is actually enforced", () => {
    expect(RETYPE_MAX_PAGES).toBeGreaterThan(0);
    expect(RETYPE_MAX_PAGES).toBeLessThanOrEqual(5000);
  });
});
