/**
 * `memex orphans` — DB hygiene report + safe deletions.
 *
 * Wraps cycle/orphans-purge.ts. Always-safe deletes happen by default
 * (orphan embeddings / entity_mentions / entities); flagged classes
 * (docs missing on disk, docs with zero chunks) are reported, never
 * mutated.
 */
import { Storage } from "../core/storage.ts";
import { orphansPurgePhase } from "../core/cycle/orphans-purge.ts";
import { loadConfig } from "../core/config.ts";

export async function runOrphans(): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const r = await orphansPurgePhase(storage.engine());
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  } finally {
    await storage.close();
  }
}
