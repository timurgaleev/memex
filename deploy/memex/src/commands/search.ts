/**
 * `memex search <query> [--k N] [--explain]` — hybrid retrieve from the CLI.
 *
 * Outputs JSON to stdout so it pipes cleanly into jq. The shell helper
 * at deploy/helpers/memex wraps this for ad-hoc use inside the bridge
 * container. `--explain` stamps per-signal ranking attribution on every hit
 * (JSON `explain` field) and prints the human-readable breakdown to stderr.
 */
import { Storage } from "../core/storage.ts";
import { hybridSearch } from "../core/search/index.ts";
import { formatExplainList } from "../core/search/explain.ts";
import { loadConfig } from "../core/config.ts";

export interface SearchCommandOptions {
  query: string;
  k?: number;
  explain?: boolean;
  configPath?: string;
}

export async function runSearch(
  opts: SearchCommandOptions,
): Promise<void> {
  if (!opts.query || !opts.query.trim()) {
    throw new Error("memex search: <query> is required");
  }
  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  await storage.init();
  try {
    const hits = await hybridSearch(storage, opts.query, {
      ...(opts.k ? { k: opts.k } : {}),
      ...(opts.explain ? { explain: true } : {}),
    });
    console.log(JSON.stringify({ ok: true, hits }, null, 2));
    if (opts.explain) {
      // Human-readable attribution on stderr — stdout stays pipeable JSON.
      process.stderr.write(formatExplainList(hits));
    }
  } finally {
    await storage.close();
  }
}
