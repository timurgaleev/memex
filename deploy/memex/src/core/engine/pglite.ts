/**
 * PGLite engine — wraps `@electric-sql/pglite` with the pgvector + pg_trgm
 * extensions (the latter backs migration 033's `CREATE EXTENSION pg_trgm`,
 * used by the wikilink slug canonicalizer's `similarity()` scoring).
 *
 * Storage lives at a filesystem path (a directory). PGLite is single-process,
 * single-connection — concurrent memex processes against the same path
 * are not supported. Per the spec, single-user / single-container is the
 * design point until swaps in real Postgres.
 */
import { PGlite } from "@electric-sql/pglite";
import { classifyPgliteError } from "./pglite-diagnose.ts";
import { acquireDataDirLock, type HeldLock } from "./pglite-lock.ts";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { Engine, QueryResult } from "./interface.ts";

export interface PGliteEngineOptions {
  /** Filesystem path (directory) where PGLite persists. */
  dbPath: string;
}

export class PGliteEngine implements Engine {
  readonly kind = "pglite" as const;
  private db: PGlite;

  private readonly dbPath: string;
  private lock: HeldLock | null = null;

  constructor(opts: PGliteEngineOptions) {
    this.dbPath = opts.dbPath;
    // Claim the directory BEFORE handing it to the driver. Two processes on one
    // PGLite directory corrupt it, and refusing the second is cheaper than
    // repairing what they do to each other.
    this.lock = acquireDataDirLock(opts.dbPath);
    try {
      this.db = new PGlite(opts.dbPath, { extensions: { vector, pg_trgm } });
    } catch (e) {
      this.lock.release();
      this.lock = null;
      throw e;
    }
  }

  /**
   * Open the directory, and say something useful when it will not open.
   *
   * The driver reports a refusal as whatever Emscripten threw — usually a bare
   * `Aborted()`. Passing that up verbatim was the entire diagnosis; the
   * original is kept, with a named cause and a next step in front of it.
   */
  async ready(): Promise<void> {
    try {
      await this.db.waitReady;
    } catch (e) {
      // The directory never opened, so nothing here owns it — give the lock
      // back rather than stranding it for the life of a process that catches
      // this and carries on.
      this.lock?.release();
      this.lock = null;
      const d = classifyPgliteError(e);
      const err = new Error(
        `pglite: cannot open ${this.dbPath} [${d.cause}] — ${d.message}. ${d.hint}`,
      );
      // Keep the original reachable for anyone who wants the raw failure.
      (err as Error & { cause?: unknown }).cause = e;
      throw err;
    }
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
    // Released only after the driver actually let go. Releasing in a `finally`
    // would hand the directory to another process while this one may still
    // hold it open — the lock would be advertising a guarantee it no longer
    // has. A close that throws keeps the lock, and the staleness check
    // recovers it when the process exits.
    this.lock?.release();
    this.lock = null;
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
