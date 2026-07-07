/**
 * `memex hnsw <status|sweep|rebuild>` — manual HNSW index lifecycle ops over the
 * ported `core/vector-index.ts` manager. Postgres-only in effect (every op
 * no-ops on PGLite); the recovery path for an index left invalid by an aborted
 * `CREATE INDEX CONCURRENTLY` or an OOM mid-build.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { checkInvalidIndexes } from "../core/doctor-ops.ts";
import {
  EMBEDDINGS_HNSW_SPEC,
  checkActiveBuild,
  dropZombieIndexes,
  dropAndRebuild,
} from "../core/vector-index.ts";

export interface HnswOptions {
  force?: boolean;
}

export async function runHnsw(
  sub: string,
  opts: HnswOptions = {},
): Promise<void> {
  const storage = new Storage(loadConfig());
  await storage.init();
  const engine = storage.engine();
  try {
    switch (sub) {
      case "status": {
        const active = await checkActiveBuild(engine, EMBEDDINGS_HNSW_SPEC.name);
        const invalid = await checkInvalidIndexes(engine);
        console.log(
          JSON.stringify(
            {
              engine: engine.kind,
              index: EMBEDDINGS_HNSW_SPEC.name,
              active_build: active,
              invalid_indexes: invalid,
            },
            null,
            2,
          ),
        );
        break;
      }
      case "sweep": {
        const { dropped } = await dropZombieIndexes(engine);
        console.log(
          dropped.length === 0
            ? "hnsw sweep: no invalid indexes to drop"
            : `hnsw sweep: dropped ${dropped.length} invalid index(es): ${dropped.join(", ")}`,
        );
        break;
      }
      case "rebuild": {
        const res = await dropAndRebuild(engine, EMBEDDINGS_HNSW_SPEC, {
          reason: "cli",
          force: opts.force ?? false,
        });
        console.log(
          res.rebuilt
            ? `hnsw rebuild: ${EMBEDDINGS_HNSW_SPEC.name} rebuilt (temp ${res.tempName})`
            : `hnsw rebuild: skipped (engine=${engine.kind}, an active build may be in flight — pass --force)`,
        );
        break;
      }
      default:
        throw new Error(
          `memex hnsw: unknown subcommand '${sub}' (expected status|sweep|rebuild)`,
        );
    }
  } finally {
    await engine.close();
  }
}
