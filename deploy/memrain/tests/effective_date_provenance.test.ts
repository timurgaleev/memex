/**
 * Effective-date provenance (migration 080): the derivation sentinel +
 * import_filename stored at index time, and pages.salience_touched_at bumped
 * only when the recompute-salience phase actually changes a score.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import {
  importFilename,
  resolveEffectiveDateWithSource,
} from "../src/core/effective-date.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { recomputeSaliencePhase } from "../src/core/cycle/recompute-salience.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-edp-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveEffectiveDateWithSource", () => {
  it("reports which derivation won", () => {
    expect(
      resolveEffectiveDateWithSource({ date: "2024-03-10" }, "/v/x.md").source,
    ).toBe("date");
    expect(
      resolveEffectiveDateWithSource({ event_date: "2024-03-10" }, null).source,
    ).toBe("event_date");
    expect(
      resolveEffectiveDateWithSource({ published: "2024-03-10" }, null).source,
    ).toBe("published");
    expect(
      resolveEffectiveDateWithSource({}, "/vault/2024-05-01-notes.md").source,
    ).toBe("filename");
    const fb = resolveEffectiveDateWithSource({}, "/vault/undated.md");
    expect(fb.source).toBe("fallback");
    expect(fb.iso).toBeNull();
  });

  it("importFilename returns the basename", () => {
    expect(importFilename("/vault/sub/2024-05-01-notes.md")).toBe("2024-05-01-notes.md");
    expect(importFilename(null)).toBeNull();
  });
});

describe("index-time provenance columns (mig080)", () => {
  it("stores effective_date_source + import_filename on the document", async () => {
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc-edp-1",
        sourcePath: "/vault/2024-05-01-meeting.md",
        title: "Meeting",
        frontmatter: {},
      },
      [],
    );
    const r = await storage
      .engine()
      .query<{ effective_date_source: string | null; import_filename: string | null }>(
        `SELECT effective_date_source, import_filename FROM documents WHERE id = 'doc-edp-1'`,
      );
    expect(r.rows[0]!.effective_date_source).toBe("filename");
    expect(r.rows[0]!.import_filename).toBe("2024-05-01-meeting.md");
  });
});

describe("pages.salience_touched_at (mig080)", () => {
  it("stamps only pages whose salience changed", async () => {
    await putPage(storage, { slug: "hub", type: "note" });
    await putPage(storage, { slug: "spoke", type: "note" });
    await putPage(storage, { slug: "island", type: "note" });
    await addLink(storage, { source_slug: "hub", target_slug: "spoke", type: "related_to" });

    const r = await recomputeSaliencePhase(storage.engine());
    expect(r.updated).toBeGreaterThan(0);
    const rows = await storage
      .engine()
      .query<{ slug: string; salience_touched_at: string | null }>(
        `SELECT slug, salience_touched_at::text AS salience_touched_at
           FROM pages ORDER BY slug`,
      );
    const bySlug = new Map(rows.rows.map((x) => [x.slug, x.salience_touched_at]));
    expect(bySlug.get("hub")).not.toBeNull();
    // An unlinked, untagged page keeps salience 0 -> untouched.
    expect(bySlug.get("island")).toBeNull();
  });
});
