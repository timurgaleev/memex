/**
 * `memex index <path>` — read a markdown file from disk and index it.
 *
 * One-shot ingestion (manual or scripted). For a whole tree use
 * `memex reindex`; there is no boot-time watcher.
 */
import { Storage } from "../core/storage.ts";
import { indexFile } from "../core/indexer.ts";
import { loadConfig } from "../core/config.ts";

export interface IndexCommandOptions {
  path: string;
}

export async function runIndex(opts: IndexCommandOptions): Promise<void> {
  if (!opts.path) {
    throw new Error("memex index: <path> is required");
  }
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const result = await indexFile(storage, opts.path);
    console.log(JSON.stringify({ ok: true, ...result }));
  } finally {
    await storage.close();
  }
}
