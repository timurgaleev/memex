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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverMigrations,
  resolveLockTimeout,
  runMigrations,
} from "../src/core/migrate.ts";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import type { Engine } from "../src/core/engine/interface.ts";

/**
 * Wraps a real engine and records every `exec` SQL (including the SQL
 * run inside transaction callbacks) so a test can assert ordering.
 */
function recordingEngine(inner: Engine): { engine: Engine; execLog: string[] } {
  const execLog: string[] = [];
  const wrap = (e: Engine): Engine => ({
    kind: e.kind,
    ready: () => e.ready(),
    query: (sql, params) => e.query(sql, params),
    exec: (sql) => {
      execLog.push(sql);
      return e.exec(sql);
    },
    close: () => e.close(),
    transaction: (fn) => e.transaction((tx) => fn(wrap(tx))),
  });
  return { engine: wrap(inner), execLog };
}

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

describe("resolveLockTimeout", () => {
  it("falls back to the default when unset or empty", () => {
    expect(resolveLockTimeout(undefined)).toBe("10s");
    expect(resolveLockTimeout("")).toBe("10s");
    expect(resolveLockTimeout("   ")).toBe("10s");
  });

  it("accepts a valid override and trims it", () => {
    expect(resolveLockTimeout("60s")).toBe("60s");
    expect(resolveLockTimeout("5min")).toBe("5min");
    expect(resolveLockTimeout("500ms")).toBe("500ms");
    expect(resolveLockTimeout(" 30s ")).toBe("30s");
  });

  it("throws on a malformed override", () => {
    expect(() => resolveLockTimeout("soon")).toThrow(/malformed/);
    expect(() => resolveLockTimeout("5secs")).toThrow(/malformed/);
    expect(() => resolveLockTimeout("-5s")).toThrow(/malformed/);
    expect(() => resolveLockTimeout("5s; DROP TABLE x")).toThrow(/malformed/);
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

  // NOTE: this asserts the SET LOCAL is emitted in the right ORDER, not
  // that it aborts a contended lock — PGLite is single-connection so
  // lock_timeout is a no-op locally. The fail-fast behavior only exists
  // on live Postgres/RDS and is not exercised by the unit suite.
  it("sets lock_timeout inside the migration tx, before the body", async () => {
    writeFileSync(join(tmp, "001_init.sql"), "CREATE TABLE t (x INT);\n");

    const inner = new PGliteEngine({ dbPath: join(tmp, "db") });
    await inner.ready();
    const { engine, execLog } = recordingEngine(inner);

    await runMigrations(engine, tmp);

    const lockIdx = execLog.findIndex((s) =>
      /SET LOCAL lock_timeout = '10s';/.test(s),
    );
    const bodyIdx = execLog.findIndex((s) => s.includes("CREATE TABLE t"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(lockIdx);

    await inner.close();
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

describe("migration 028 — parent_symbol_path scalar→TEXT[] guard", () => {
  const sql028 = readFileSync(
    join(
      import.meta.dir,
      "../src/core/migrations/028_chunk_parent_symbol_path_array.sql",
    ),
    "utf8",
  );

  // The catalog-guarded DO block must (a) cast a scalar `text` column to a
  // 1-element `text[]`, preserving NULL, and (b) be a no-op when re-applied
  // to the already-`text[]` column — NOT nest it into [['x']]. Locks the
  // codex-review fix for migration re-run safety.
  it("casts scalar to 1-element array and re-runs without nesting", async () => {
    const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await engine.exec(
      "CREATE TABLE chunks (id TEXT PRIMARY KEY, parent_symbol_path TEXT);",
    );
    await engine.exec(
      "INSERT INTO chunks (id, parent_symbol_path) VALUES ('a', 'Inner'), ('b', NULL);",
    );

    // First apply: scalar text → text[].
    await engine.exec(sql028);
    const after1 = await engine.query<{
      id: string;
      parent_symbol_path: string[] | null;
    }>("SELECT id, parent_symbol_path FROM chunks ORDER BY id");
    expect(after1.rows.find((r) => r.id === "a")!.parent_symbol_path).toEqual([
      "Inner",
    ]);
    expect(
      after1.rows.find((r) => r.id === "b")!.parent_symbol_path,
    ).toBeNull();

    // Second apply on the already-text[] column: no-op, no nesting.
    await engine.exec(sql028);
    const after2 = await engine.query<{
      id: string;
      parent_symbol_path: string[] | null;
    }>("SELECT id, parent_symbol_path FROM chunks ORDER BY id");
    expect(after2.rows.find((r) => r.id === "a")!.parent_symbol_path).toEqual([
      "Inner",
    ]);
    expect(
      after2.rows.find((r) => r.id === "b")!.parent_symbol_path,
    ).toBeNull();

    await engine.close();
  });
});
