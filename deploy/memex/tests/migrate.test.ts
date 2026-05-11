/**
 * Migration engine unit tests.
 *
 * Exercises the discoverer (filename grammar, sort order, duplicate
 * detection) against a tmp dir, plus an end-to-end run against a fresh
 * PGLite engine adapter. Total runtime <2s — no Bedrock calls.
 *
 * Postgres-engine equivalents run in tests/engine_postgres.test.ts under
 * , gated on a live RDS connection.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMigrations, runMigrations } from "../src/core/migrate.ts";
import { PGliteEngine } from "../src/core/engine/pglite.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memex-migrate-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discoverMigrations", () => {
  it("returns files sorted by numeric id", () => {
    writeFileSync(join(tmp, "010_late.sql"), "-- 010\n");
    writeFileSync(join(tmp, "001_first.sql"), "-- 001\n");
    writeFileSync(join(tmp, "002_second.sql"), "-- 002\n");
    const r = discoverMigrations(tmp);
    expect(r.map((f) => f.id)).toEqual([1, 2, 10]);
    expect(r[0]!.name).toBe("first");
    expect(r[2]!.name).toBe("late");
  });

  it("ignores non-.sql files", () => {
    writeFileSync(join(tmp, "001_a.sql"), "-- a\n");
    writeFileSync(join(tmp, "README.md"), "ignore me");
    writeFileSync(join(tmp, "002_b.txt"), "ignore me too");
    const r = discoverMigrations(tmp);
    expect(r.length).toBe(1);
    expect(r[0]!.name).toBe("a");
  });

  it("rejects malformed filenames", () => {
    writeFileSync(join(tmp, "no-prefix.sql"), "-- bad\n");
    expect(() => discoverMigrations(tmp)).toThrow(/grammar/);
  });

  it("detects duplicate ids", () => {
    writeFileSync(join(tmp, "001_a.sql"), "-- a\n");
    writeFileSync(join(tmp, "001_b.sql"), "-- b\n");
    expect(() => discoverMigrations(tmp)).toThrow(/duplicate migration id 1/);
  });
});

describe("runMigrations (PGLite engine)", () => {
  it("applies pending migrations in order, skips on second run", async () => {
    writeFileSync(
      join(tmp, "001_init.sql"),
      "CREATE TABLE t (x INT);\n",
    );
    writeFileSync(
      join(tmp, "002_more.sql"),
      "ALTER TABLE t ADD COLUMN y INT;\n",
    );

    const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();

    const r1 = await runMigrations(engine, tmp);
    expect(r1.applied.map((a) => a.id)).toEqual([1, 2]);
    expect(r1.skipped).toBe(0);

    // Schema actually applied
    await engine.exec("INSERT INTO t (x, y) VALUES (1, 2);");

    const r2 = await runMigrations(engine, tmp);
    expect(r2.applied).toEqual([]);
    expect(r2.skipped).toBe(2);

    await engine.close();
  });

  it("records id + name in the migrations table", async () => {
    writeFileSync(
      join(tmp, "001_initial.sql"),
      "CREATE TABLE noop (x INT);\n",
    );
    const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine, tmp);
    const rows = await engine.query<{ id: number; name: string }>(
      "SELECT id, name FROM migrations ORDER BY id",
    );
    expect(rows.rows).toEqual([{ id: 1, name: "initial" }]);
    await engine.close();
  });
});
