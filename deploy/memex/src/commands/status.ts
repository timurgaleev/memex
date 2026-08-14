/**
 * `memex status` — one-shot operational snapshot of the brain.
 *
 * Bundles the three signals an operator usually wants at a glance into a single
 * JSON object: index counts (`stats`), data/ingest health (embed coverage,
 * staleness lag, job queue), and the query-cache state. Read-only — unlike
 * `doctor` it makes no pass/fail judgement and sets no exit code; it just
 * reports the numbers. Reuses the same primitives `doctor` and `cache` use.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { currentDocumentClock } from "../core/generation.ts";
import { brainHealthMetrics, collectPerSourceHealth } from "../core/source-health.ts";
import { cacheStats } from "../core/search/query-cache.ts";
import {
  readWorkerLock,
  DEFAULT_WORKER_LOCK_ID,
} from "../core/jobs/worker-lock.ts";
import { VERSION } from "../version.ts";

export interface StatusCmdOptions {
  /** Override the config path (tests point this at a temp dir). */
  configPath?: string;
  /** Include the per-source (per-tenant) health breakdown. Local CLI is an
   *  unscoped/trusted caller, so it sees every source incl. '(unclassified)'. */
  perSource?: boolean;
}

export async function runStatus(opts: StatusCmdOptions = {}): Promise<void> {
  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const engine = storage.raw();
    // Sequential: the engine may be a single PGLite connection that serializes
    // queries anyway, these are cheap reads, and cacheStats needs the clock
    // first (data dependency).
    const stats = await storage.stats();
    const health = await brainHealthMetrics(engine);
    const clock = await currentDocumentClock(engine);
    const cache = await cacheStats(engine, clock);
    // Active job worker: holder + heartbeat staleness. `null` = no worker has
    // ever acquired the lock; `stale: true` = the holder crashed or wedged
    // (heartbeat older than its TTL) and a survivor will steal on next tick.
    const worker = await readWorkerLock(engine, DEFAULT_WORKER_LOCK_ID);
    // Unscoped (no sourceIds) → whole-brain breakdown incl. '(unclassified)'.
    const perSource = opts.perSource
      ? await collectPerSourceHealth(engine)
      : undefined;
    console.log(
      JSON.stringify(
        {
          ok: true,
          version: VERSION,
          stats,
          health,
          ...(perSource ? { perSource } : {}),
          cache,
          worker,
        },
        null,
        2,
      ),
    );
  });
}
