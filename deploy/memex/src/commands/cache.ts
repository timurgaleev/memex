/**
 * `memex cache <subcommand>` — operator surface for the exact-match query
 * cache (migration 026). The cache is a pure optimization gated on the
 * document-generation clock; these commands let an operator see its health
 * and reclaim space without restarting the daemon.
 *
 *   stats  — total / fresh / stale rows vs the current clock (read-only)
 *   prune  — drop only the stale rows (clock_value <> current clock)
 *   clear  — drop every cached row
 *
 * Clearing or pruning never changes search CORRECTNESS — a miss just
 * recomputes the ranking from the live tables. Stale rows are already
 * never served (getCachedQuery filters on the clock); prune only reclaims
 * their space.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { currentDocumentClock } from "../core/generation.ts";
import {
  cacheStats,
  clearCache,
  pruneCache,
} from "../core/search/query-cache.ts";

export type CacheSubcommand = "stats" | "prune" | "clear";

export interface CacheCmdOptions {
  sub: CacheSubcommand;
}

export async function runCache(opts: CacheCmdOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  // init() inside the try so a failed migration/connect still hits close()
  // in finally (no leaked engine/pool).
  try {
    await storage.init();
    const engine = storage.engine();
    switch (opts.sub) {
      case "stats": {
        const clock = await currentDocumentClock(engine);
        const stats = await cacheStats(engine, clock);
        console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
        return;
      }
      case "prune": {
        const clock = await currentDocumentClock(engine);
        const removed = await pruneCache(engine, clock);
        console.log(
          JSON.stringify({ ok: true, action: "prune", removed, current_clock: clock }, null, 2),
        );
        return;
      }
      case "clear": {
        const removed = await clearCache(engine);
        console.log(
          JSON.stringify({ ok: true, action: "clear", removed }, null, 2),
        );
      }
    }
  } finally {
    await storage.close();
  }
}
