/**
 * Engine factory — instantiate by `database.type` from the loaded config.
 *
 * Both adapters share the Engine surface in `interface.ts`. The factory is
 * the only place that imports from `pglite.ts` or `postgres.ts` directly,
 * keeping callers engine-agnostic.
 *
 * The Postgres URL has two override paths so containers can override
 * config.json without touching EFS state:
 *   1. `MEMEX_POSTGRES_URL` env  — highest precedence
 *   2. `database.url` field in the JSON config — fallback
 *
 * Pool size and statement timeout are env-tunable so a long migration, a
 * whole-corpus re-embed backfill, or a big rechunk transaction isn't killed at
 * the short interactive `statement_timeout` (default 30s):
 *   - `MEMEX_PG_POOL_MAX` (default 10)
 *   - `MEMEX_PG_STATEMENT_TIMEOUT_MS` (default 30000)
 */
import type { Config } from "../config.ts";
import type { Engine } from "./interface.ts";
import { PGliteEngine } from "./pglite.ts";
import { PostgresEngine, type PostgresEngineOptions } from "./postgres.ts";

/** Parse a positive-int env override; undefined when unset/invalid (fail-soft). */
function positiveIntEnv(name: string): number | undefined {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function makeEngine(config: Config): Engine {
  const db = config.database;
  if (db.type === "pglite") {
    return new PGliteEngine({ dbPath: db.path });
  }
  if (db.type === "postgres") {
    const url = process.env.MEMEX_POSTGRES_URL ?? db.url;
    if (!url) {
      throw new Error(
        "memex: database.type=postgres but no URL — set MEMEX_POSTGRES_URL env or database.url in config.json",
      );
    }
    const opts: PostgresEngineOptions = { url };
    const poolMax = positiveIntEnv("MEMEX_PG_POOL_MAX");
    if (poolMax !== undefined) opts.max = poolMax;
    const stmtTimeout = positiveIntEnv("MEMEX_PG_STATEMENT_TIMEOUT_MS");
    if (stmtTimeout !== undefined) opts.statementTimeoutMs = stmtTimeout;
    return new PostgresEngine(opts);
  }
  throw new Error(
    `memex: unknown database.type ${(db as { type: string }).type}`,
  );
}
