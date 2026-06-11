/**
 * `memex embed [--limit N] [--dry-run]` — backfill embeddings for non-code
 * chunks that are missing a vector (see `core/embed-backfill.ts`).
 *
 * This is the operator remedy for a partial vector arm: `memex status` /
 * `memex doctor` (source-health) report `embed_coverage` below 100% when
 * markdown chunks lack an embedding. Run this to (re)embed them via Titan.
 *
 *   --dry-run   count the missing chunks, write nothing (no Bedrock calls)
 *   --limit N   embed at most N this run (cap cost; re-run to continue)
 *
 * Idempotent — a re-run only embeds what is still missing. Exits non-zero
 * only on TOTAL failure (candidates existed, none embedded), so a cron can
 * detect a fully-broken Bedrock path while tolerating the occasional skip.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { runEmbedBackfill } from "../core/embed-backfill.ts";

export interface EmbedCmdOptions {
  limit?: number;
  dryRun?: boolean;
}

export async function runEmbed(opts: EmbedCmdOptions = {}): Promise<number> {
  const config = loadConfig();
  const storage = new Storage(config);
  // init() inside the try so a failed migration/connect still hits close().
  try {
    await storage.init();
    const engine = storage.engine();
    const result = await runEmbedBackfill(engine, {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      onProgress: (done, total) =>
        console.error(`embed-backfill: ${done}/${total}`),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    // Total failure → non-zero so an unattended run is detectable.
    if (!result.dryRun && result.candidates > 0 && result.embedded === 0) {
      return 1;
    }
    return 0;
  } finally {
    await storage.close();
  }
}
