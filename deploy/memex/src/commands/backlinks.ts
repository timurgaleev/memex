/**
 * `memex backlinks <name> [--type wikilink|tag|date] [--limit N]`
 *
 * Prints documents that mention the named entity. Default type is
 * `wikilink` — answers "what links here" against the entity graph.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { findBacklinks } from "../core/backlinks.ts";
import { loadConfig } from "../core/config.ts";
import type { EntityType } from "../core/entities.ts";

export interface BacklinksCmdOptions {
  name: string;
  type?: EntityType;
  limit?: number;
}

export async function runBacklinks(opts: BacklinksCmdOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const buildOpts: Parameters<typeof findBacklinks>[2] = {};
    if (opts.type !== undefined) buildOpts.type = opts.type;
    if (opts.limit !== undefined) buildOpts.limit = opts.limit;
    const hits = await findBacklinks(storage, opts.name, buildOpts);
    console.log(JSON.stringify({ ok: true, name: opts.name, hits }, null, 2));
  });
}
