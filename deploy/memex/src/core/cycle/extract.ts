/**
 * extract phase — re-run the regex entity extractor over existing chunks.
 *
 * Thin wrapper around `core/extract.ts::extractAll`. Picked up by the
 * cycle so that any extractor changes propagate without a full re-embed.
 */
import type { Engine } from "../engine/interface.ts";
import { Storage } from "../storage.ts";
import { extractAll, type ExtractResult } from "../extract.ts";

export interface ExtractPhaseOptions {
  /** Cap docs processed per cycle. Default 200 — one full vault is ~115. */
  maxDocs?: number;
}

export async function extractPhase(
  engine: Engine,
  opts: ExtractPhaseOptions = {},
): Promise<ExtractResult> {
  const storage = new Storage(engine);
  const exOpts: Parameters<typeof extractAll>[1] = {};
  if (opts.maxDocs !== undefined) exOpts.maxDocs = opts.maxDocs;
  return extractAll(storage, exOpts);
}
