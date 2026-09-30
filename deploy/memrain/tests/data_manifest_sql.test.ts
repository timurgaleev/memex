/**
 * `scripts/sql/data-manifest.sql`, the one data-manifest tool: two outputs are
 * compared with a plain `diff`, so a line must change exactly when its object
 * does. Runs the shipped file on PGLite through the test runner and, when
 * MEMRAIN_TEST_POSTGRES_URL points at a scratch database, on Postgres with psql
 * (a missing psql fails that run; it never skips).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { discoverMigrations, runMigrations } from "../src/core/migrate.ts";
import { MANIFEST_SQL, runManifestScript } from "./helpers/manifest-script.ts";

const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;
const PROBE = "manifest_probe";
const PROBE_NOPK = "manifest_probe_nopk";
const PROBE_FN = "manifest_probe_fn";

type Target = {
  engine: Engine;
  run: () => Promise<string>;
  /** The same run from a session whose search_path is `path`. */
  runWithSearchPath: (path: string) => Promise<string>;
};

function psqlManifest(url: string, opts: { pre?: string[]; pgOptions?: string } = {}): string {
  const psql = Bun.which("psql");
  if (!psql) throw new Error("psql not found: the Postgres run of the manifest needs it");
  const pre = (opts.pre ?? []).flatMap((sql) => ["-c", sql]);
  const env = opts.pgOptions ? { ...process.env, PGOPTIONS: opts.pgOptions } : process.env;
  const r = Bun.spawnSync([psql, url, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", ...pre, "-f", MANIFEST_SQL], { env });
  if (r.exitCode !== 0) throw new Error(`psql exited ${r.exitCode}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** Key = kind + name, so a changed digest shows up as one changed key. */
function byKey(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.trimEnd().split("\n")) {
    const [kind, name = ""] = line.split("\t");
    m.set(`${kind}\t${name}`, line);
  }
  return m;
}

function changedKeys(a: string, b: string): string[] {
  const ma = byKey(a);
  const mb = byKey(b);
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  return [...keys].filter((k) => ma.get(k) !== mb.get(k)).sort();
}

const lineOf = (out: string, key: string) => byKey(out).get(key);

const vec = (last: string) => `[${Array.from({ length: 1023 }, () => "0.5").join(",")},${last}]`;

async function seed(e: Engine): Promise<void> {
  await e.exec(`
    CREATE TABLE ${PROBE} (id int PRIMARY KEY, b bytea, note text);
    CREATE TABLE ${PROBE_NOPK} (v text);
    CREATE FUNCTION ${PROBE_FN}() RETURNS int LANGUAGE sql AS 'SELECT 1';
    INSERT INTO ${PROBE} VALUES (1, '\\x00ff'::bytea, 'a'), (2, NULL, NULL), (3, '\\x'::bytea, '');
    INSERT INTO pages (slug, type, title, content_hash, markdown_body, compiled_truth, updated_at)
      VALUES ('${PROBE}/page', 'note', NULL, 'h', 'body text', '{"a": 2, "b": 1}', '2026-01-01 00:00:00.000001+00');
    INSERT INTO documents (id, source_path) VALUES ('${PROBE}-doc', '/${PROBE}/doc.md');
    INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('${PROBE}-c0', '${PROBE}-doc', 0, 'chunk');
    INSERT INTO embeddings (chunk_id, vector, model) VALUES ('${PROBE}-c0', '${vec("0.5")}', 'm');
    INSERT INTO oauth_clients (client_id, client_name) VALUES ('${PROBE}-client', 'probe');
    INSERT INTO oauth_tokens (token_hash, token_type, client_id) VALUES ('${"a".repeat(64)}', 'access', '${PROBE}-client');
  `);
}

async function unseed(e: Engine): Promise<void> {
  await e.exec(`
    DELETE FROM oauth_tokens WHERE client_id = '${PROBE}-client';
    DELETE FROM oauth_clients WHERE client_id = '${PROBE}-client';
    DELETE FROM documents WHERE id = '${PROBE}-doc';
    DELETE FROM pages WHERE slug = '${PROBE}/page';
    DROP FUNCTION IF EXISTS ${PROBE_FN}();
    DROP TABLE IF EXISTS ${PROBE};
    DROP TABLE IF EXISTS ${PROBE_NOPK};
  `);
}

/** A one-value change, the SQL that undoes it, and the one line it must flip. */
const SENSITIVITY: Array<{ kind: string; change: string; undo: string; table: string }> = [
  {
    kind: "a text body",
    change: `UPDATE pages SET markdown_body = 'body texT' WHERE slug = '${PROBE}/page'`,
    undo: `UPDATE pages SET markdown_body = 'body text' WHERE slug = '${PROBE}/page'`,
    table: "pages",
  },
  {
    kind: "the last embedding dimension",
    change: `UPDATE embeddings SET vector = '${vec("0.6")}' WHERE chunk_id = '${PROBE}-c0'`,
    undo: `UPDATE embeddings SET vector = '${vec("0.5")}' WHERE chunk_id = '${PROBE}-c0'`,
    table: "embeddings",
  },
  {
    kind: "a JSONB value",
    change: `UPDATE pages SET compiled_truth = '{"a": 2, "b": 3}' WHERE slug = '${PROBE}/page'`,
    undo: `UPDATE pages SET compiled_truth = '{"a": 2, "b": 1}' WHERE slug = '${PROBE}/page'`,
    table: "pages",
  },
  {
    kind: "a timestamptz microsecond",
    change: `UPDATE pages SET updated_at = updated_at + interval '1 microsecond' WHERE slug = '${PROBE}/page'`,
    undo: `UPDATE pages SET updated_at = updated_at - interval '1 microsecond' WHERE slug = '${PROBE}/page'`,
    table: "pages",
  },
  {
    kind: "a token hash",
    change: `UPDATE oauth_tokens SET token_hash = '${"a".repeat(63)}b' WHERE client_id = '${PROBE}-client'`,
    undo: `UPDATE oauth_tokens SET token_hash = '${"a".repeat(64)}' WHERE client_id = '${PROBE}-client'`,
    table: "oauth_tokens",
  },
  {
    kind: "a bytea byte",
    change: `UPDATE ${PROBE} SET b = '\\x00fe'::bytea WHERE id = 1`,
    undo: `UPDATE ${PROBE} SET b = '\\x00ff'::bytea WHERE id = 1`,
    table: PROBE,
  },
  {
    kind: "NULL to ''",
    change: `UPDATE pages SET title = '' WHERE slug = '${PROBE}/page'`,
    undo: `UPDATE pages SET title = NULL WHERE slug = '${PROBE}/page'`,
    table: "pages",
  },
];

function manifestCases(target: () => Target) {
  const t = () => target();

  it("prints one table line per base table and one function line per function in public", async () => {
    const out = await t().run();
    const lines = out.trimEnd().split("\n");
    const names = (kind: string) =>
      lines.filter((l) => l.startsWith(`${kind}\t`)).map((l) => l.split("\t")[1]!).sort();
    const tables = await t().engine.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    const functions = await t().engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`,
    );
    const catalog = tables.rows.map((r) => r.relname).sort();
    expect(catalog.length).toBeGreaterThan(50);
    expect(names("table")).toEqual(catalog);
    expect(names("columns")).toEqual(catalog);
    expect(names("function").length).toBe(functions.rows[0]!.n);
    expect(lines[0]).toMatch(/^server\t\d+$/);
    // Block order is fixed, and every line is kind + name + digest(s).
    const order = ["server", "table", "sequence", "function", "trigger", "columns"];
    const rank = lines.map((l) => order.indexOf(l.split("\t")[0]!));
    expect(rank.every((r, i) => r >= 0 && (i === 0 || r >= rank[i - 1]!))).toBe(true);
    for (const l of lines.filter((l) => /^(?:table|function|trigger|columns)\t/.test(l))) {
      expect(l).toMatch(/\t[0-9a-f]{64}$/);
    }
  });

  it("lists the tables without a primary key (ordered by row text instead)", async () => {
    const r = await t().engine.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)
        ORDER BY c.relname`,
    );
    expect(r.rows.map((x) => x.relname).filter((n) => !n.startsWith(PROBE))).toEqual(["tags"]);
  });

  it("gives the same output twice, and on a migrated database writes nothing", async () => {
    const before = await t().engine.query<{ n: number; top: string }>(
      `SELECT count(*)::int AS n, max(id)::text AS top FROM migrations`,
    );
    const a = await t().run();
    const b = await t().run();
    expect(b).toBe(a);
    const after = await t().engine.query<{ n: number; top: string }>(
      `SELECT count(*)::int AS n, max(id)::text AS top FROM migrations`,
    );
    expect(after.rows).toEqual(before.rows);
    const onDisk = discoverMigrations().length;
    expect(lineOf(a, "table\tmigrations")!.split("\t")[2]).toBe(String(onDisk));
  });

  it("gives the same output whatever search_path the caller's session has", async () => {
    const a = await t().run();
    expect(await t().runWithSearchPath("pg_catalog")).toBe(a);
  });

  describe("with probe rows", () => {
    beforeAll(async () => {
      await unseed(t().engine);
      await seed(t().engine);
    });
    afterAll(async () => {
      await unseed(t().engine);
    });

    it("rows inserted in a different physical order give the same line", async () => {
      const e = t().engine;
      await e.exec(`INSERT INTO ${PROBE_NOPK} VALUES ('x'), ('y'), ('z')`);
      const first = await t().run();
      await e.exec(`
        DELETE FROM ${PROBE}; DELETE FROM ${PROBE_NOPK};
        INSERT INTO ${PROBE_NOPK} VALUES ('z'), ('x'), ('y');
        INSERT INTO ${PROBE} VALUES (3, '\\x'::bytea, ''), (1, '\\x00ff'::bytea, 'a'), (2, NULL, NULL);
      `);
      const second = await t().run();
      expect(changedKeys(first, second)).toEqual([]);
      expect(lineOf(second, `table\t${PROBE}`)).toMatch(new RegExp(`^table\\t${PROBE}\\t3\\t[0-9a-f]{64}$`));
      await e.exec(`DELETE FROM ${PROBE_NOPK}`);
    });

    it("JSONB key order alone changes nothing", async () => {
      const e = t().engine;
      const base = await t().run();
      await e.exec(`UPDATE pages SET compiled_truth = '{"b": 1, "a": 2}' WHERE slug = '${PROBE}/page'`);
      expect(changedKeys(base, await t().run())).toEqual([]);
    });

    for (const c of SENSITIVITY) {
      it(`${c.kind} flips exactly the ${c.table} table line`, async () => {
        const e = t().engine;
        const base = await t().run();
        await e.exec(c.change);
        expect(changedKeys(base, await t().run())).toEqual([`table\t${c.table}`]);
        await e.exec(c.undo);
        expect(await t().run()).toBe(base);
      });
    }

    it("a sequence setval flips exactly that sequence line", async () => {
      const e = t().engine;
      const base = await t().run();
      const seq = [...byKey(base).keys()].find((k) => k.startsWith("sequence\t"))!.split("\t")[1]!;
      const [, , last, called] = lineOf(base, `sequence\t${seq}`)!.split("\t");
      await e.query(`SELECT setval($1, $2::bigint + 7, true)`, [`public.${seq}`, last]);
      expect(changedKeys(base, await t().run())).toEqual([`sequence\t${seq}`]);
      expect(called).toMatch(/^(?:true|false)$/);
      await e.query(`SELECT setval($1, $2::bigint, $3)`, [`public.${seq}`, last, called === "true"]);
      expect(await t().run()).toBe(base);
    });

    it("CREATE OR REPLACE with a changed body flips exactly that function line", async () => {
      const e = t().engine;
      const base = await t().run();
      await e.exec(`CREATE OR REPLACE FUNCTION ${PROBE_FN}() RETURNS int LANGUAGE sql AS 'SELECT 2'`);
      expect(changedKeys(base, await t().run())).toEqual([`function\t${PROBE_FN}()`]);
    });
  });
}

describe("data-manifest.sql on PGLite", () => {
  let tmp: string;
  let engine: PGliteEngine;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-manifest-"));
    engine = new PGliteEngine({ dbPath: join(tmp, "db") });
    await engine.ready();
    await runMigrations(engine);
  });
  afterAll(async () => {
    await engine.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  manifestCases(() => ({
    engine,
    run: () => runManifestScript(engine.raw()),
    runWithSearchPath: async (path) => {
      const db = engine.raw();
      const prior = (await db.query<{ p: string }>("SELECT current_setting('search_path') AS p")).rows[0]!.p;
      await db.exec(`SET search_path = ${path}`);
      try {
        return await runManifestScript(db);
      } finally {
        await db.query("SELECT set_config('search_path', $1, false)", [prior]);
      }
    },
  }));

  it("runs in a READ ONLY transaction: a write inside it is refused", async () => {
    const begin = readFileSync(MANIFEST_SQL, "utf8").match(/^BEGIN\b[^;]*;/m)?.[0];
    expect(begin).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;");
    const db = engine.raw();
    await db.exec(begin!);
    try {
      await expect(db.exec(`CREATE TABLE ${PROBE}_write (id int)`)).rejects.toThrow(/read-only transaction/);
    } finally {
      await db.exec("ROLLBACK");
    }
    const r = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = '${PROBE}_write'`);
    expect(r.rows[0]!.n).toBe(0);
  });
});

describe.skipIf(!PG_URL)("data-manifest.sql on Postgres (psql)", () => {
  let pg: PostgresEngine;

  beforeAll(async () => {
    if (!Bun.which("psql")) throw new Error("psql not found: the Postgres run of the manifest needs it");
    pg = new PostgresEngine({ url: PG_URL!, max: 2 });
    await pg.ready();
    await runMigrations(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  manifestCases(() => ({
    engine: pg,
    run: async () => psqlManifest(PG_URL!),
    runWithSearchPath: async (path) => psqlManifest(PG_URL!, { pgOptions: `-c search_path=${path}` }),
  }));

  it("a role that row-level security would filter fails instead of printing empty tables", async () => {
    const role = `${PROBE}_reader`;
    const drop = `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        EXECUTE 'DROP OWNED BY ${role}'; EXECUTE 'DROP ROLE ${role}';
      END IF; END $$`;
    const rls = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity`,
    );
    expect(rls.rows[0]!.n).toBeGreaterThan(0);
    await pg.exec(drop);
    try {
      await pg.exec(`
        CREATE ROLE ${role} NOLOGIN;
        GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};
        GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
      `);
      expect(() => psqlManifest(PG_URL!, { pre: [`SET ROLE ${role}`] })).toThrow(/row-level security/);
    } finally {
      await pg.exec(drop);
    }
  });
});
