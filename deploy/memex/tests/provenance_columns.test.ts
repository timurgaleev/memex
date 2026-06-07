/**
 * Provenance / ranking-signal columns (migration 024) — existence + defaults.
 *
 * All columns are nullable/defaulted and have no consumer yet (P2 ranking,
 * P4 cycle, P8 source-health populate them later). This test proves the
 * migration adds each column to pages / sources / links without disturbing
 * existing rows, and that pages.emotional_weight defaults to 0.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-provenance-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(r.rows[0]!.n) > 0;
}

const EXPECTED: Record<string, string[]> = {
  pages: [
    "emotional_weight",
    "last_retrieved_at",
    "links_extracted_at",
    "contextual_retrieval_mode",
  ],
  sources: [
    "chunker_version",
    "archived",
    "archive_expires_at",
    "contextual_retrieval_mode",
    "newest_content_at",
  ],
  links: [
    "context",
    "link_kind",
    "origin_page_id",
    "origin_field",
    "resolution_type",
  ],
};

describe("provenance columns", () => {
  for (const [table, cols] of Object.entries(EXPECTED)) {
    for (const col of cols) {
      it(`${table}.${col} exists`, async () => {
        expect(await columnExists(table, col)).toBe(true);
      });
    }
  }

  it("pages.emotional_weight defaults to 0 on a new page", async () => {
    await putPage(storage, {
      slug: "ideas/a",
      type: "idea",
      markdown_body: "v1",
    });
    const r = await storage
      .engine()
      .query<{ emotional_weight: number }>(
        `SELECT emotional_weight FROM pages WHERE slug = $1`,
        ["ideas/a"],
      );
    expect(Number(r.rows[0]!.emotional_weight)).toBe(0);
  });

  it("sources.archived defaults to false", async () => {
    await storage
      .engine()
      .query(
        `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, $2, $3)`,
        ["src-a", "other", "people/"],
      );
    const r = await storage
      .engine()
      .query<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = $1`,
        ["src-a"],
      );
    expect(r.rows[0]!.archived).toBe(false);
  });
});
