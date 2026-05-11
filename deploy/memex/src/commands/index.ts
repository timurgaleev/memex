/**
 * `memex index <path>` — read a markdown file from disk and index it.
 *
 * Used in for one-shot ingestion (manual or scripted).
 * adds a watcher + sweep cron driven by the obsidian recipe.
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
