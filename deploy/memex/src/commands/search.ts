/**
 * `memex search <query> [--k N]` — hybrid retrieve from the CLI.
 *
 * Outputs JSON to stdout so it pipes cleanly into jq. wraps this
 * in the openclaw skill so the agent can call it directly.
 */
import { Storage } from "../core/storage.ts";
import { hybridSearch } from "../core/search/index.ts";
import { loadConfig } from "../core/config.ts";

export interface SearchCommandOptions {
  query: string;
  k?: number;
}

export async function runSearch(
  opts: SearchCommandOptions,
): Promise<void> {
  if (!opts.query || !opts.query.trim()) {
    throw new Error("memex search: <query> is required");
  }
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const hits = await hybridSearch(
      storage,
      opts.query,
      opts.k ? { k: opts.k } : {},
    );
    console.log(JSON.stringify({ ok: true, hits }, null, 2));
  } finally {
    await storage.close();
  }
}
