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
 */
import type { Config } from "../config.ts";
import type { Engine } from "./interface.ts";
import { PGliteEngine } from "./pglite.ts";
import { PostgresEngine } from "./postgres.ts";

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
    return new PostgresEngine({ url });
  }
  throw new Error(
    `memex: unknown database.type ${(db as { type: string }).type}`,
  );
}
