/**
 * recompute-salience cycle phase — integration over a PGLite-backed Storage.
 *
 * Verifies the phase reads tags from compiled_truth + link-degree from the
 * links table, writes pages.salience, is idempotent, and that the
 * recompute-salience phase is wired into the default cycle.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import {
  recomputeSaliencePhase,
  tagsFromCompiledTruth,
} from "../src/core/cycle/recompute-salience.ts";
import { ALL_PHASES } from "../src/core/cycle/index.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-salience-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function salienceOf(slug: string): Promise<number> {
  const r = await storage
    .raw()
    .query<{ salience: number | string }>(
      `SELECT salience FROM pages WHERE slug = $1`,
      [slug],
    );
  return Number(r.rows[0]?.salience ?? -1);
}

describe("recompute-salience phase wiring", () => {
  it("is part of the default cycle, before snapshot", () => {
    expect(ALL_PHASES).toContain("recompute-salience");
    expect(ALL_PHASES.indexOf("recompute-salience")).toBeLessThan(
      ALL_PHASES.indexOf("snapshot"),
    );
  });
});

describe("recomputeSaliencePhase", () => {
  it("scores a high-emotion-tagged page at the tag floor", async () => {
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      compiled_truth: { tags: ["family"] },
    });
    const res = await recomputeSaliencePhase(storage.raw());
    expect(res.scanned).toBeGreaterThanOrEqual(1);
    expect(res.updated).toBeGreaterThanOrEqual(1);
    expect(await salienceOf("people/alice")).toBeCloseTo(0.5, 5);
  });

  it("scores an untagged, unlinked page at 0.0 (no update from default)", async () => {
    await putPage(storage, {
      slug: "notes/lonely",
      type: "note",
      compiled_truth: { tags: ["work"] },
    });
    const res = await recomputeSaliencePhase(storage.raw());
    // default salience is already 0.0, untagged+unlinked → still 0.0, no write
    expect(await salienceOf("notes/lonely")).toBe(0);
    expect(res.updated).toBe(0);
  });

  it("raises salience with link-degree (in + out neighbours)", async () => {
    await putPage(storage, { slug: "hub", type: "note" });
    await putPage(storage, { slug: "a", type: "note" });
    await putPage(storage, { slug: "b", type: "note" });
    // hub → a (out), b → hub (in): degree(hub) = 2
    await addLink(storage, { source_slug: "hub", target_slug: "a", type: "related_to" });
    await addLink(storage, { source_slug: "b", target_slug: "hub", type: "related_to" });
    await recomputeSaliencePhase(storage.raw());
    const hub = await salienceOf("hub");
    const a = await salienceOf("a");
    expect(hub).toBeGreaterThan(0);
    expect(hub).toBeGreaterThan(a); // degree 2 > degree 1
  });

  it("does NOT count dangling targets (links to non-existent pages)", async () => {
    await putPage(storage, { slug: "spammy", type: "note" });
    // 3 out-edges, all to pages that do not exist → degree must be 0
    for (const t of ["ghost-1", "ghost-2", "ghost-3"]) {
      await addLink(storage, {
        source_slug: "spammy",
        target_slug: t,
        type: "related_to",
      });
    }
    const res = await recomputeSaliencePhase(storage.raw());
    expect(await salienceOf("spammy")).toBe(0); // no real neighbours, no tags
    expect(res.updated).toBe(0);
  });

  it("raises salience from active takes attached via the page mirror", async () => {
    await putPage(storage, { slug: "people/carol", type: "person" });
    // Mirror document for the default-tenant page, plus two active takes.
    const eng = storage.raw();
    await eng.query(
      `INSERT INTO documents (id, source_path, title)
       VALUES ($1, $2, $3)`,
      ["doc-carol", "page://people/carol", "Carol"],
    );
    await eng.query(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, weight, status, model_id)
       VALUES
         ('k1', 'doc-carol', 'h1', 'v1', 'claim one', 0.8, 'queued', 'm'),
         ('k2', 'doc-carol', 'h2', 'v1', 'claim two', 0.6, 'accepted', 'm'),
         ('k3', 'doc-carol', 'h3', 'v1', 'rejected claim', 0.9, 'rejected', 'm')`,
    );
    await recomputeSaliencePhase(eng);
    // 2 active takes (rejected excluded): density 0.10 + avg(0.7)*0.05 = 0.135
    expect(await salienceOf("people/carol")).toBeCloseTo(0.135, 4);
  });

  it("excludes rejected takes and pages with no mirror from the take term", async () => {
    await putPage(storage, { slug: "people/dave", type: "person" });
    const eng = storage.raw();
    await eng.query(
      `INSERT INTO documents (id, source_path, title)
       VALUES ('doc-dave', 'page://people/dave', 'Dave')`,
    );
    await eng.query(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, weight, status, model_id)
       VALUES ('dk1', 'doc-dave', 'h1', 'v1', 'only rejected', 0.9, 'rejected', 'm')`,
    );
    const res = await recomputeSaliencePhase(eng);
    // all takes rejected → no take lift, page stays at default 0.0
    expect(await salienceOf("people/dave")).toBe(0);
    expect(res.updated).toBe(0);
  });

  it("is idempotent — a second run updates nothing", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { tags: ["health"] },
    });
    await recomputeSaliencePhase(storage.raw());
    const second = await recomputeSaliencePhase(storage.raw());
    expect(second.updated).toBe(0);
  });

  it("skips soft-deleted pages", async () => {
    await putPage(storage, {
      slug: "notes/gone",
      type: "note",
      compiled_truth: { tags: ["family"] },
    });
    await storage
      .raw()
      .query(`UPDATE pages SET deleted_at = NOW() WHERE slug = $1`, ["notes/gone"]);
    const res = await recomputeSaliencePhase(storage.raw());
    expect(res.scanned).toBe(0);
  });
});

describe("tagsFromCompiledTruth", () => {
  it("extracts a string array", () => {
    expect(tagsFromCompiledTruth({ tags: ["a", "b"] })).toEqual(["a", "b"]);
  });
  it("wraps a single string tag", () => {
    expect(tagsFromCompiledTruth({ tags: "solo" })).toEqual(["solo"]);
  });
  it("drops non-string array members", () => {
    expect(tagsFromCompiledTruth({ tags: ["a", 1, null, "b"] })).toEqual(["a", "b"]);
  });
  it("tolerates a JSON-string blob", () => {
    expect(tagsFromCompiledTruth(JSON.stringify({ tags: ["x"] }))).toEqual(["x"]);
  });
  it("returns [] for missing / malformed input", () => {
    expect(tagsFromCompiledTruth(null)).toEqual([]);
    expect(tagsFromCompiledTruth("not-json")).toEqual([]);
    expect(tagsFromCompiledTruth({})).toEqual([]);
    expect(tagsFromCompiledTruth({ tags: 42 })).toEqual([]);
  });
});
