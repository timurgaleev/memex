/**
 * PGLite engine — wraps `@electric-sql/pglite` with the pgvector extension.
 *
 * Storage lives at a filesystem path (a directory). PGLite is single-process,
 * single-connection — concurrent memex processes against the same path
 * are not supported. Per the spec, single-user / single-container is the
 * design point until swaps in real Postgres.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import type { Engine, QueryResult } from "./interface.ts";

export interface PGliteEngineOptions {
  /** Filesystem path (directory) where PGLite persists. */
  dbPath: string;
}

export class PGliteEngine implements Engine {
  readonly kind = "pglite" as const;
  private db: PGlite;

  constructor(opts: PGliteEngineOptions) {
    this.db = new PGlite(opts.dbPath, { extensions: { vector } });
  }

  async ready(): Promise<void> {
    await this.db.waitReady;
  }

  async query<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const r = await this.db.query<T>(sql, params);
    return { rows: r.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async transaction<T>(fn: (tx: Engine) => Promise<T>): Promise<T> {
    await this.db.exec("BEGIN");
    try {
      const result = await fn(this);
      await this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        await this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors — the original failure is what matters
      }
      throw e;
    }
  }

  /**
   * Escape hatch for code that genuinely needs the raw PGLite handle
   * (migrate-engine command, debug tools). Avoid in normal flow.
   */
  raw(): PGlite {
    return this.db;
  }
}
