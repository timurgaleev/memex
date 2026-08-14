/**
 * `memex index <path>` — read one file from disk and index it. Markdown is
 * chunked as prose; a recognised code file (.ts/.tsx/.py/…) is routed through
 * the tree-sitter code chunker so it lands in the same store with symbol +
 * call-graph metadata. For a whole tree use `memex reindex`; there is no
 * boot-time watcher.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { indexFile } from "../core/indexer.ts";
import { indexCodeFile } from "../core/indexer-code.ts";
import { languageForFile } from "../core/chunkers/parsers.ts";
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
  return withStorage(storage, async () => {
    // Auto-detect: a recognised source extension is parsed by the code
    // chunker; everything else is treated as markdown prose.
    const isCode = languageForFile(opts.path) !== null;
    const result = isCode
      ? await indexCodeFile(storage, opts.path)
      : await indexFile(storage, opts.path);
    console.log(
      JSON.stringify({ ok: true, kind: isCode ? "code" : "doc", ...result }),
    );
  });
}
