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
  resolveMigrationStatementTimeout,
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

  it("resolveMigrationStatementTimeout defaults to 30min and validates", () => {
    expect(resolveMigrationStatementTimeout(undefined)).toBe("30min");
    expect(resolveMigrationStatementTimeout("")).toBe("30min");
    expect(resolveMigrationStatementTimeout("600s")).toBe("600s");
    expect(resolveMigrationStatementTimeout(" 1800000 ")).toBe("1800000");
    expect(() => resolveMigrationStatementTimeout("soon")).toThrow(/malformed/);
    expect(() => resolveMigrationStatementTimeout("30s; DROP TABLE x")).toThrow(/malformed/);
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

describe("migration 029 — link provenance hardening", () => {
  const sql029 = readFileSync(
    join(import.meta.dir, "../src/core/migrations/029_link_provenance.sql"),
    "utf8",
  );

  // Migration 024 already laid `context, link_kind, origin_page_id,
  // origin_field, resolution_type` as bare nullable TEXT stubs. 029 hardens
  // them: context NOT NULL DEFAULT '' (+ backfill), enum CHECKs, and renames
  // origin_page_id → origin_slug. Every step is guarded so a re-apply is a
  // no-op, not an error.
  it("hardens the 024 stub columns and re-runs cleanly", async () => {
    const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    // Reproduce the post-024 shape: links with the bare provenance stubs and
    // a row whose context is still NULL (the pre-029 reality on live).
    await engine.exec(
      `CREATE TABLE links (
         id BIGSERIAL PRIMARY KEY, source_slug TEXT, target_slug TEXT, type TEXT,
         context TEXT, link_kind TEXT, origin_page_id TEXT,
         origin_field TEXT, resolution_type TEXT
       );`,
    );
    await engine.exec(
      "INSERT INTO links (source_slug, target_slug, type) VALUES ('a', 'b', 'works_at');",
    );

    await engine.exec(sql029);

    // context backfilled NULL → '' and is now NOT NULL.
    const after1 = await engine.query<{ context: string; link_kind: string | null }>(
      "SELECT context, link_kind FROM links WHERE source_slug = 'a'",
    );
    expect(after1.rows[0]!.context).toBe("");
    expect(after1.rows[0]!.link_kind).toBeNull();

    // origin_page_id renamed → origin_slug.
    const cols = await engine.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'links' AND column_name IN ('origin_page_id', 'origin_slug')`,
    );
    const names = cols.rows.map((r) => r.column_name).sort();
    expect(names).toEqual(["origin_slug"]);

    // A NULL context now violates NOT NULL.
    await expect(
      engine.exec("INSERT INTO links (source_slug, target_slug, type, context) VALUES ('c','d','works_at',NULL);"),
    ).rejects.toThrow();

    // Re-apply: guarded steps are no-ops, not errors.
    await engine.exec(sql029);
    const after2 = await engine.query<{ n: number }>("SELECT count(*)::int AS n FROM links");
    expect(after2.rows[0]!.n).toBe(1);

    // The CHECK constraint rejects a bad link_kind.
    await expect(
      engine.exec("UPDATE links SET link_kind = 'bogus' WHERE source_slug = 'a';"),
    ).rejects.toThrow();

    await engine.close();
  });
});

describe("migration 031 — two-layer query cache columns", () => {
  const sql031 = readFileSync(
    join(import.meta.dir, "../src/core/migrations/031_two_layer_query_cache.sql"),
    "utf8",
  );

  it("adds documents.generation + query_cache.doc_generations, re-runs cleanly", async () => {
    const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    // Minimal pre-031 shape for the two target tables.
    await engine.exec(
      `CREATE TABLE documents (id TEXT PRIMARY KEY);
       CREATE TABLE query_cache (
         cache_key TEXT PRIMARY KEY, query TEXT, k INTEGER,
         intent TEXT, result_ids JSONB, clock_value BIGINT,
         created_at TIMESTAMPTZ DEFAULT NOW()
       );
       INSERT INTO documents (id) VALUES ('d1');
       INSERT INTO query_cache (cache_key, clock_value) VALUES ('k1', 0);`,
    );

    await engine.exec(sql031);

    // documents.generation defaults to 0 on the existing row.
    const g = await engine.query<{ generation: number }>(
      "SELECT generation FROM documents WHERE id = 'd1'",
    );
    expect(Number(g.rows[0]!.generation)).toBe(0);

    // query_cache.doc_generations defaults to '{}' on the existing row.
    const dg = await engine.query<{ doc_generations: Record<string, number> }>(
      "SELECT doc_generations FROM query_cache WHERE cache_key = 'k1'",
    );
    expect(dg.rows[0]!.doc_generations).toEqual({});

    // Re-apply: ADD COLUMN IF NOT EXISTS makes it a no-op, not an error.
    await engine.exec(sql031);
    const after = await engine.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM query_cache",
    );
    expect(after.rows[0]!.n).toBe(1);

    await engine.close();
  });
});

describe("migration 032 — chunk doc_comment + weighted FTS fold", () => {
  const sql030 = readFileSync(
    join(import.meta.dir, "../src/core/migrations/030_chunk_weighted_search_vector.sql"),
    "utf8",
  );
  const sql032 = readFileSync(
    join(import.meta.dir, "../src/core/migrations/032_chunk_doc_comment.sql"),
    "utf8",
  );

  it("adds doc_comment, folds it into weight A, re-runs cleanly", async () => {
    const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    // Minimal pre-030 chunks shape (the columns the trigger reads).
    await engine.exec(
      `CREATE TABLE chunks (
         id TEXT PRIMARY KEY,
         content TEXT,
         symbol_name TEXT,
         parent_symbol_path TEXT[]
       );
       INSERT INTO chunks (id, content, symbol_name) VALUES ('c1', 'body text', NULL);`,
    );
    await engine.exec(sql030); // establishes search_vector + trigger
    await engine.exec(sql032); // adds doc_comment + folds it into weight A

    // A term present ONLY in doc_comment lands at weight A on insert.
    await engine.exec(
      "INSERT INTO chunks (id, content, doc_comment) VALUES ('c2', 'unrelated body', 'frobnicationengine docs');",
    );
    const r = await engine.query<{ id: string }>(
      `SELECT id FROM chunks
        WHERE search_vector @@ plainto_tsquery('simple', 'frobnicationengine')`,
    );
    expect(r.rows.map((x) => x.id)).toEqual(["c2"]);

    // Re-apply 032: CREATE OR REPLACE + ADD COLUMN IF NOT EXISTS → no-op.
    await engine.exec(sql032);
    const again = await engine.query<{ id: string }>(
      `SELECT id FROM chunks
        WHERE search_vector @@ plainto_tsquery('simple', 'frobnicationengine')`,
    );
    expect(again.rows.map((x) => x.id)).toEqual(["c2"]);

    await engine.close();
  });
});

describe("migration 059 — links + tags source_id in the uniqueness key", () => {
  const sql059 = readFileSync(
    join(import.meta.dir, "../src/core/migrations/059_links_tags_source_id_unique.sql"),
    "utf8",
  );

  // Folds source_id into the links UNIQUE(triple) and the tags PRIMARY
  // KEY(slug,tag) so each tenant owns its own row for an otherwise-identical
  // edge / tag. Collision-safe on live data (every row is source_id='default',
  // a constant column can't create a duplicate) and re-run-safe (guarded
  // DROP/ADD). Reproduces the mig-016 / mig-023 shape + the mig-047 source_id.
  it("widens both keys, allows a same-triple/tag row per source, re-runs cleanly", async () => {
    const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await engine.exec(
      `CREATE TABLE links (
         id BIGSERIAL PRIMARY KEY,
         source_slug TEXT NOT NULL, target_slug TEXT NOT NULL, type TEXT NOT NULL,
         source_id TEXT NOT NULL DEFAULT 'default',
         UNIQUE (source_slug, target_slug, type)
       );
       CREATE TABLE tags (
         slug TEXT NOT NULL, tag TEXT NOT NULL,
         source_id TEXT NOT NULL DEFAULT 'default',
         PRIMARY KEY (slug, tag)
       );`,
    );
    // Live-shape rows: everything on the single 'default' tenant.
    await engine.exec(
      `INSERT INTO links (source_slug, target_slug, type, source_id) VALUES ('a','b','mentions','default');
       INSERT INTO tags (slug, tag, source_id) VALUES ('p','x','default');`,
    );
    // Under the OLD key, a second source's identical triple/tag is a duplicate.
    await expect(
      engine.exec(`INSERT INTO links (source_slug, target_slug, type, source_id) VALUES ('a','b','mentions','tenantb');`),
    ).rejects.toThrow();
    await expect(
      engine.exec(`INSERT INTO tags (slug, tag, source_id) VALUES ('p','x','tenantb');`),
    ).rejects.toThrow();

    await engine.exec(sql059);

    // New key: the same triple/tag in a DIFFERENT source is now allowed.
    await engine.exec(`INSERT INTO links (source_slug, target_slug, type, source_id) VALUES ('a','b','mentions','tenantb');`);
    await engine.exec(`INSERT INTO tags (slug, tag, source_id) VALUES ('p','x','tenantb');`);
    const lc = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM links WHERE source_slug='a' AND target_slug='b' AND type='mentions'`,
    );
    const tc = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tags WHERE slug='p' AND tag='x'`,
    );
    expect(lc.rows[0]!.n).toBe(2);
    expect(tc.rows[0]!.n).toBe(2);

    // ...but a duplicate WITHIN a source still conflicts (own-row uniqueness).
    await expect(
      engine.exec(`INSERT INTO links (source_slug, target_slug, type, source_id) VALUES ('a','b','mentions','tenantb');`),
    ).rejects.toThrow();
    await expect(
      engine.exec(`INSERT INTO tags (slug, tag, source_id) VALUES ('p','x','tenantb');`),
    ).rejects.toThrow();

    // Re-apply: guarded DROP IF EXISTS + pg_constraint-guarded ADD → no-op.
    await engine.exec(sql059);
    const after = await engine.query<{ n: number }>("SELECT count(*)::int AS n FROM links");
    expect(after.rows[0]!.n).toBe(2);

    await engine.close();
  });
});
