/**
 * PGLite engine adapter tests — exercise the Engine surface directly.
 *
 * Postgres adapter has the same shape; once ships RDS the same
 * tests can be re-run via tests/engine_postgres.test.ts gated on a live
 * connection URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";

let tmp: string;
let engine: PGliteEngine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-engine-pglite-"));
  engine = new PGliteEngine({ dbPath: join(tmp, "db") });
  await engine.ready();
});

afterEach(async () => {
  await engine.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("PGliteEngine", () => {
  it("exposes kind=pglite", () => {
    expect(engine.kind).toBe("pglite");
  });

  it("query returns { rows } shape", async () => {
    const r = await engine.query<{ x: number }>("SELECT 1::int AS x");
    expect(r.rows).toEqual([{ x: 1 }]);
  });

  it("query supports $1 parameter binding", async () => {
    const r = await engine.query<{ y: number }>(
      "SELECT ($1::int + 1)::int AS y",
      [41],
    );
    expect(r.rows[0]?.y).toBe(42);
  });

  it("exec runs multi-statement DDL", async () => {
    await engine.exec(`
      CREATE TABLE t (a INT, b TEXT);
      INSERT INTO t VALUES (1, 'one');
      INSERT INTO t VALUES (2, 'two');
    `);
    const r = await engine.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM t",
    );
    expect(r.rows[0]?.c).toBe(2);
  });

  it("supports BEGIN / COMMIT / ROLLBACK via exec", async () => {
    await engine.exec("CREATE TABLE tx (n INT);");
    await engine.exec("BEGIN; INSERT INTO tx VALUES (1); COMMIT;");
    await engine.exec("BEGIN; INSERT INTO tx VALUES (2); ROLLBACK;");
    const r = await engine.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM tx",
    );
    expect(r.rows[0]?.c).toBe(1);
  });

  it("loads pgvector — vector(1024) type works", async () => {
    await engine.exec(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE v (id INT, e vector(1024));
    `);
    const vec = JSON.stringify(new Array(1024).fill(0.5));
    await engine.query("INSERT INTO v (id, e) VALUES ($1, $2::vector)", [
      1,
      vec,
    ]);
    const r = await engine.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM v",
    );
    expect(r.rows[0]?.c).toBe(1);
  });
});
