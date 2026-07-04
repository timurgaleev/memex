/**
 * `memex merge <from-slug> <to-slug>` — fold a duplicate/phantom stub page onto
 * an existing canonical page.
 *
 * Thin CLI wrapper over `mergePage` (core/entity-merge.ts): re-points the stub's
 * facts, links, timeline, tags, and aliases onto the canonical, soft-deletes the
 * stub, and leaves a durable `stub → canonical` redirect. Use when two pages
 * describe the same entity (e.g. a bare `alice` stub and a canonical
 * `people/alice-example`) and you want them collapsed into one.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { mergePage, type MergeOptions } from "../core/entity-merge.ts";

export interface MergeCommandOptions {
  from: string;
  to: string;
  /** Owning source (tenant). Confines resolution + substrate moves to it. */
  sourceId?: string;
  /** Caller identifier for the audit trail. */
  writtenBy?: string;
}

export async function runMerge(opts: MergeCommandOptions): Promise<void> {
  if (!opts.from || !opts.to) {
    throw new Error("memex merge: <from-slug> and <to-slug> are required");
  }
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const mergeOpts: MergeOptions = {};
    if (opts.sourceId) mergeOpts.source_id = opts.sourceId;
    if (opts.writtenBy) mergeOpts.written_by = opts.writtenBy;
    const result = await mergePage(storage, opts.from, opts.to, mergeOpts);
    console.log(JSON.stringify({ ok: result.merged, ...result }, null, 2));
  } finally {
    await storage.close();
  }
}
