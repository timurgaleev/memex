/**
 * Versioned migration engine.
 *
 * Loads migration files from `src/core/migrations/NNN_<name>.sql`, sorts
 * by the numeric prefix, applies any not yet recorded in the `migrations`
 * table. Each migration runs in its own implicit transaction (PGLite's
 * `exec` wraps multi-statement SQL).
 *
 * Filename grammar:
 *   <id:integer, zero-padded>_<slug>.sql
 *   e.g. 001_initial.sql, 002_entities.sql, 010_email_sources.sql
 *
 * The engine is intentionally append-only: never edit a shipped
 * migration in-place — write a new one. Same rule as Rails / sqlx /
 * Diesel migrations.
 */
import type { Engine } from "./engine/interface.ts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(__dirname, "migrations");

export interface MigrationFile {
  id: number;
  name: string;
  filename: string;
  sql: string;
}

export interface MigrationResult {
  applied: { id: number; name: string }[];
  skipped: number;
}

const FILENAME_RE = /^(\d+)_([A-Za-z0-9_-]+)\.sql$/;

/**
 * Per-migration lock timeout. A DDL `ALTER`/`ADD COLUMN` takes a brief
 * `ACCESS EXCLUSIVE` lock; if a long-running query holds a conflicting
 * lock the migration would otherwise block indefinitely and hang the
 * deploy. `SET LOCAL` scopes this to the migration transaction (resets
 * on commit/rollback) so a stuck migration fails fast instead. Harmless
 * on PGLite (single-connection, no lock contention); the value matters
 * on live RDS. Surfaced by the P0 migration review.
 *
 * Default is forgiving enough to ride out a brief transient lock holder
 * without breaking the deploy, yet bounded so it can't hang forever.
 * Override with `MEMEX_MIGRATION_LOCK_TIMEOUT` (e.g. `60s`, `5min`) for a
 * one-off migration that must wait behind a known long transaction.
 */
const DEFAULT_LOCK_TIMEOUT = "10s";

// Postgres `lock_timeout` grammar: a bare integer is milliseconds, or an
// integer with a time unit. We accept the common units only.
const LOCK_TIMEOUT_RE = /^\d+\s*(ms|s|min|h|d)?$/;

/**
 * Resolve the per-migration lock timeout, validating any env override.
 * Throws on a malformed value rather than silently falling back — a
 * typo'd timeout should fail the deploy loudly, not mask the operator's
 * intent (e.g. a misspelled `5min` quietly running at the default).
 */
export function resolveLockTimeout(
  env: string | undefined = process.env.MEMEX_MIGRATION_LOCK_TIMEOUT,
): string {
  const v = env?.trim();
  if (v === undefined || v === "") return DEFAULT_LOCK_TIMEOUT;
  if (!LOCK_TIMEOUT_RE.test(v)) {
    throw new Error(
      `MEMEX_MIGRATION_LOCK_TIMEOUT is malformed: ${JSON.stringify(v)} ` +
        `(expected e.g. "10s", "500ms", "5min")`,
    );
  }
  return v;
}

// A migration runs under a generous statement_timeout so a large ADD COLUMN
// backfill or CREATE INDEX isn't killed at the short interactive limit (30s).
// Applied as a transaction-scoped `SET LOCAL`, so it never leaks to normal
// queries. The engine session's own statement_timeout (MEMEX_PG_STATEMENT_TIMEOUT_MS)
// still governs interactive traffic.
const DEFAULT_MIGRATION_STMT_TIMEOUT = "30min";

/**
 * Resolve the per-migration statement timeout, validating any env override.
 * Same fail-loud policy as {@link resolveLockTimeout}.
 */
export function resolveMigrationStatementTimeout(
  env: string | undefined = process.env.MEMEX_MIGRATION_STATEMENT_TIMEOUT,
): string {
  const v = env?.trim();
  if (v === undefined || v === "") return DEFAULT_MIGRATION_STMT_TIMEOUT;
  if (!LOCK_TIMEOUT_RE.test(v)) {
    throw new Error(
      `MEMEX_MIGRATION_STATEMENT_TIMEOUT is malformed: ${JSON.stringify(v)} ` +
        `(expected e.g. "30min", "600s", "1800000")`,
    );
  }
  return v;
}

/**
 * Discover migration files in a directory. Returns them sorted by id ascending.
 * Throws if a filename doesn't match the grammar so we never silently skip
 * a typo'd migration.
 */
export function discoverMigrations(dir: string = DEFAULT_DIR): MigrationFile[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const out: MigrationFile[] = [];
  for (const filename of entries) {
    const m = FILENAME_RE.exec(filename);
    if (!m) {
      throw new Error(
        `migration filename does not match NNN_name.sql grammar: ${filename}`,
      );
    }
    const id = Number.parseInt(m[1]!, 10);
    const name = m[2]!;
    const sql = readFileSync(resolve(dir, filename), "utf8");
    out.push({ id, name, filename, sql });
  }
  out.sort((a, b) => a.id - b.id);
  // Detect duplicate ids — easy to typo when copy-pasting.
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.id === out[i - 1]!.id) {
      throw new Error(
        `duplicate migration id ${out[i]!.id}: ${out[i - 1]!.filename} vs ${out[i]!.filename}`,
      );
    }
  }
  return out;
}

/**
 * Apply pending migrations. Idempotent. Bootstraps the migrations table
 * itself before the first real migration runs.
 *
 * The engine adds a `name` column on top of the original schema
 * (which only had `id` + `applied_at`). The ALTER runs unconditionally;
 * Postgres / PGLite both treat IF NOT EXISTS as a no-op.
 */
export async function runMigrations(
  engine: Engine,
  dir: string = DEFAULT_DIR,
): Promise<MigrationResult> {
  await engine.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE migrations ADD COLUMN IF NOT EXISTS name TEXT;
  `);

  const seenRows = await engine.query<{ id: number }>(
    "SELECT id FROM migrations ORDER BY id",
  );
  const seen = new Set(seenRows.rows.map((r) => r.id));

  const files = discoverMigrations(dir);
  const lockTimeout = resolveLockTimeout();
  const stmtTimeout = resolveMigrationStatementTimeout();
  const applied: { id: number; name: string }[] = [];
  let skipped = 0;

  for (const f of files) {
    if (seen.has(f.id)) {
      skipped++;
      continue;
    }
    // Apply the migration SQL and the bookkeeping INSERT inside one
    // transaction. A crash between the two (process kill, power loss,
    // pglite I/O error) used to leave the migration physically applied
    // but unrecorded — on next boot the same SQL re-ran, breaking any
    // non-idempotent change (column rename, data backfill). With both
    // in one tx, the migration is either fully applied + recorded or
    // entirely rolled back; PGLite and postgres-js both support
    // transactional DDL on the surfaces we use.
    await engine.transaction(async (tx) => {
      await tx.exec(`SET LOCAL lock_timeout = '${lockTimeout}';`);
      await tx.exec(`SET LOCAL statement_timeout = '${stmtTimeout}';`);
      await tx.exec(f.sql);
      await tx.query(
        "INSERT INTO migrations (id, name) VALUES ($1, $2)",
        [f.id, f.name],
      );
    });
    applied.push({ id: f.id, name: f.name });
  }

  return { applied, skipped };
}
