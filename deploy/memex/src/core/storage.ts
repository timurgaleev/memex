/**
 * Storage — engine-agnostic façade over the persistence layer.
 *
 * Engines (PGLite, Postgres) live in `core/engine/`. This class adds
 * lifecycle bookkeeping (init = wait-ready + run-migrations) and a couple
 * of convenience read-only queries (stats) on top of the Engine surface.
 *
 * Callers that need to issue arbitrary SQL go through `engine()` — the
 * Engine has the same `query` / `exec` / `close` shape regardless of the
 * underlying driver.
 */
import { runMigrations, type MigrationResult } from "./migrate.ts";
import type { Engine } from "./engine/interface.ts";
import { makeEngine } from "./engine/factory.ts";
import type { Config } from "./config.ts";

export interface StorageStats {
  documents: number;
  chunks: number;
  embeddings: number;
}

export class Storage {
  private _engine: Engine;
  private _config: Config | null;

  constructor(engineOrConfig: Engine | Config | { dbPath: string }) {
    if (isEngine(engineOrConfig)) {
      this._engine = engineOrConfig;
      this._config = null;
    } else if ("database" in engineOrConfig) {
      this._engine = makeEngine(engineOrConfig);
      this._config = engineOrConfig;
    } else {
      // Legacy `{ dbPath }` shape — kept so existing tests / callers don't
      // need to know about the engine factory. PGLite-only.
      const cfg: Config = {
        database: { type: "pglite", path: engineOrConfig.dbPath },
        embedding: {
          provider: "bedrock-titan",
          model: "amazon.titan-embed-text-v2:0",
          region: "eu-west-1",
        },
        storage: {},
      };
      this._engine = makeEngine(cfg);
      this._config = cfg;
    }
  }

  /**
   * Active runtime config, or null if Storage was constructed from a
   * raw Engine handle (tests). Optional fields like `evalCapture`
   * read off this directly.
   */
  config(): Config | null {
    return this._config;
  }

  async init(): Promise<MigrationResult> {
    await this._engine.ready();
    return runMigrations(this._engine);
  }

  /** Engine surface — issue arbitrary SQL via .query / .exec. */
  engine(): Engine {
    return this._engine;
  }

  /**
   * Back-compat: legacy callers used `storage.raw()` to get the underlying
   * PGLite handle. The Engine has the same `query` / `exec` shape so we
   * can return it directly. Adapters that genuinely need a raw client
   * (migrate-engine, debug) cast and import from `engine/{pglite,postgres}.ts`.
   */
  raw(): Engine {
    return this._engine;
  }

  async stats(): Promise<StorageStats> {
    const [docs, chs, embs] = await Promise.all([
      this._engine.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM documents",
      ),
      this._engine.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM chunks",
      ),
      this._engine.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM embeddings",
      ),
    ]);
    return {
      documents: docs.rows[0]?.c ?? 0,
      chunks: chs.rows[0]?.c ?? 0,
      embeddings: embs.rows[0]?.c ?? 0,
    };
  }

  async close(): Promise<void> {
    await this._engine.close();
  }
}

function isEngine(x: unknown): x is Engine {
  return (
    typeof x === "object" &&
    x !== null &&
    "kind" in x &&
    "query" in x &&
    "exec" in x &&
    "ready" in x &&
    "transaction" in x
  );
}
