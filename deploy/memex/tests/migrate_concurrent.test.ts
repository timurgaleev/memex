/**
 * `serve` and a `docker exec memex …` CLI both run migrations. Each read the
 * applied set up front, so two of them racing both applied the same file and
 * the loser died on the duplicate `migrations` row — at boot. Two concurrent
 * runs must both succeed and apply each migration exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { runMigrations } from "../src/core/migrate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/core/migrations");
let tmp: string;
let engine: PGliteEngine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-migrate-race-"));
  engine = new PGliteEngine({ dbPath: join(tmp, "db") });
  await engine.ready();
});
afterEach(async () => {
  await engine.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("concurrent migration runs", () => {
  it("both succeed and apply every migration exactly once", async () => {
    const [a, b] = await Promise.all([
      runMigrations(engine, MIGRATIONS_DIR),
      runMigrations(engine, MIGRATIONS_DIR),
    ]);
    const total = a.applied.length + b.applied.length;
    const rows = await engine.query<{ n: number; distinct_n: number }>(
      "SELECT count(*)::int AS n, count(DISTINCT id)::int AS distinct_n FROM migrations",
    );
    expect(rows.rows[0]!.n).toBe(total);
    expect(rows.rows[0]!.distinct_n).toBe(total);
    // Whatever one run applied, the other skipped.
    expect(a.skipped + b.skipped).toBe(total);
  });
});
