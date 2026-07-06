/**
 * DB integrity pair (migration 082): the auto-RLS event trigger (a table
 * created AFTER migrations gets ROW LEVEL SECURITY at CREATE time), RLS
 * enabled on the post-049 tables, and the unique facts fence key.
 *
 * PGLite's role is `postgres` (superuser, BYPASSRLS), so the enables run and
 * change no behavior — exactly the mig049 posture.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-rls-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function rlsOn(table: string): Promise<boolean> {
  const r = await storage
    .engine()
    .query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1 AND n.nspname = 'public'`,
      [table],
    );
  return r.rows[0]?.relrowsecurity === true;
}

describe("082 RLS", () => {
  it("enables RLS on the post-049 tables", async () => {
    for (const t of [
      "cycle_locks",
      "synth_contradictions",
      "slug_aliases",
      "eval_snapshots",
      "mcp_spend_log",
      "mcp_spend_reservations",
    ]) {
      expect(await rlsOn(t)).toBe(true);
    }
  });

  it("auto-enables RLS on a table created AFTER migrations (event trigger)", async () => {
    await storage.engine().exec(`CREATE TABLE rls_probe_table (id int)`);
    expect(await rlsOn("rls_probe_table")).toBe(true);
  });
});

describe("082 unique fence key", () => {
  it("rejects a second LIVE row for the same (source, page, row_num)", async () => {
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, source_markdown_slug, row_num)
       VALUES ('people/a', 'claim one', 'people/a', 1)`,
    );
    await expect(
      storage.engine().query(
        `INSERT INTO entity_facts (entity_slug, fact, source_markdown_slug, row_num)
         VALUES ('people/a', 'claim one dup', 'people/a', 1)`,
      ),
    ).rejects.toThrow();
    // A preserved tombstone on the same fence line does NOT block the live
    // re-insert (the reconcile keeps supersede tombstones with their row_num).
    await storage.engine().query(
      `UPDATE entity_facts SET forgotten_at = NOW(), forgotten_cause = 'supersede'
        WHERE source_markdown_slug = 'people/a' AND row_num = 1`,
    );
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, source_markdown_slug, row_num)
       VALUES ('people/a', 'claim one v2', 'people/a', 1)`,
    );
    const r = await storage
      .engine()
      .query<{ n: number }>(
        `SELECT count(*)::int AS n FROM entity_facts WHERE row_num = 1`,
      );
    expect(r.rows[0]!.n).toBe(2);
  });
});
