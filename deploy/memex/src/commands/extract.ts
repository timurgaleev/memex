/**
 * `memex extract [--all] [--vault P]`
 *
 * Re-runs the regex entity extractor over every chunk in the index.
 * No Bedrock calls. Useful when the extractor itself changes.
 *
 * `--vault` is currently a no-op — there's no per-vault filter on the
 * documents table — but accepted so the command line is symmetric with
 * `reindex` / `integrity`. may add a `source` column that gives
 * this real meaning.
 */
import { Storage } from "../core/storage.ts";
import { extractAll } from "../core/extract.ts";
import { extractStaleLinks } from "../core/links-stale-sweep.ts";
import { loadConfig } from "../core/config.ts";

export interface ExtractCmdOptions {
  all?: boolean;
  vault?: string;
  /** Run the incremental link re-extraction sweep instead of the entity pass. */
  stale?: boolean;
  dryRun?: boolean;
  json?: boolean;
  catchUp?: boolean;
  sourceIds?: string[];
}

export async function runExtract(opts: ExtractCmdOptions = {}): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    if (opts.stale) {
      await extractStaleLinks(storage, {
        dryRun: opts.dryRun,
        jsonMode: opts.json,
        catchUp: opts.catchUp,
        sourceIds: opts.sourceIds,
      });
      return;
    }
    if (opts.vault) {
      console.log(
        `[memex extract] note: --vault filter not yet implemented; processing all documents.`,
      );
    }
    const r = await extractAll(storage, { all: opts.all ?? false });
    console.log(
      JSON.stringify(
        {
          ok: r.errors.length === 0,
          documents: r.documents,
          chunks: r.chunks,
          mentionsBefore: r.mentionsBefore,
          mentionsAfter: r.mentionsAfter,
          delta: r.mentionsAfter - r.mentionsBefore,
          errors: r.errors,
        },
        null,
        2,
      ),
    );
    if (r.errors.length > 0) process.exitCode = 1;
  } finally {
    await storage.close();
  }
}
