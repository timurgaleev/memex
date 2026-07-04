/**
 * Tree-sitter parser cache. Singleton `Parser.init()`, lazy per-language
 * `Language.load()`, one reusable Parser instance per language.
 *
 * Why this shape:
 *   - `Parser.init()` MUST be awaited exactly once before any `new Parser()`,
 *     or all subsequent parses throw an opaque "Module not initialized" error.
 *     A single module-level promise guarantees that.
 *   - WASM grammar load is ~5–10 MB resident per language; doing it lazily
 *     keeps the boot path light on t4g.small (memory `feedback_t4gsmall_oom`).
 *   - One Parser per language is reused across files; constructing per-call
 *     would leak Emscripten heap (Parser holds onto its language module).
 *
 * WASM file location: vendored into `deploy/memex/wasm/` and resolved
 * relative to this source file via `import.meta.url`. That layout is
 * identical in dev (`/.../deploy/memex/wasm/...`) and in the container
 * (`/app/wasm/...`) — the Dockerfile `COPY wasm/ ./wasm/` mirrors it.
 *
 * Override: `MEMEX_WASM_DIR` env var. Used by tests to point at a
 * fixture wasm dir without mutating the production layout.
 */
import { Parser, Language } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export type CodeLanguage =
  | "typescript"
  | "tsx"
  | "python"
  | "bash"
  | "go"
  | "sql";

const WASM_FILES: Record<CodeLanguage, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
  bash: "tree-sitter-bash.wasm",
  go: "tree-sitter-go.wasm",
  sql: "tree-sitter-sql.wasm",
};

const EXTENSION_TO_LANG: Record<string, CodeLanguage> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".sh": "bash",
  ".bash": "bash",
  ".go": "go",
  ".sql": "sql",
};

/** Lowercase extensions (with dot) we know how to parse. */
export const SUPPORTED_EXTENSIONS = Object.freeze(
  Object.keys(EXTENSION_TO_LANG),
) as readonly string[];

/** Pick a parser language from a filename. Returns null for unsupported types. */
export function languageForFile(filename: string): CodeLanguage | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot).toLowerCase();
  return EXTENSION_TO_LANG[ext] ?? null;
}

/**
 * Resolve the directory containing the vendored grammar WASM blobs.
 * Honors `MEMEX_WASM_DIR` for tests; otherwise resolves relative to
 * this file's location.
 */
function wasmDir(): string {
  const override = process.env.MEMEX_WASM_DIR;
  if (override && override.length > 0) return resolve(override);
  // parsers.ts lives at <root>/src/core/chunkers/parsers.ts
  // grammar wasm files at <root>/wasm/
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(join(here, "..", "..", "..", "wasm"));
}

/**
 * Wall-clock budget on a SINGLE tree-sitter parse. `indexer-code` already
 * bounds input by byte size (MAX_INDEX_FILE_BYTES), but a small-yet-
 * pathological file can still make the WASM parser spin; `parser.parse()` is
 * SYNCHRONOUS so a `Promise.race` can't interrupt it. tree-sitter's own
 * `progressCallback` (called from inside the WASM parse) is the in-process
 * lever: returning truthy cancels the parse, which then returns null.
 * (`setTimeoutMicros` is the older API but its i64 argument mis-marshals under
 * Bun's WASM bridge — ToBigInt error — so we use the progress callback.)
 *
 * COOPERATIVE, NOT HARD (codex review): the callback fires roughly every 100
 * parser operations, so (a) a very small input can complete with ZERO
 * callbacks — the budget never engages for trivially-short parses (which also
 * can't hang), and (b) the lexer / external scanner runs before the progress
 * check, so a pathological *lexer* hang is not interrupted. This covers the
 * realistic case — a parser quadratic-blowup on a mid-size file — not a
 * hostile worst case; hard preemption would need a worker/child process.
 *
 * Default 5s; override with `MEMEX_PARSE_TIMEOUT_MS`; 0 disables the cap.
 */
const DEFAULT_PARSE_TIMEOUT_MS = 5_000;

/** Thrown by `parseWithBudget` when a parse is cancelled for exceeding its
 *  wall-clock budget. Callers let it propagate so the whole file is skipped
 *  (no partial/lossy reindex) and the sweep records it per-file. */
export class ParseTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`tree-sitter parse exceeded its ${budgetMs}ms wall-clock budget`);
    this.name = "ParseTimeoutError";
  }
}

/** Resolve the per-parse timeout in MILLISECONDS. A malformed env value throws
 *  (fail loud) rather than silently reverting; 0 / unset disables the cap. A
 *  positive sub-1ms value clamps to 1 (not floored to 0, which would silently
 *  disable the cap). */
export function resolveParseTimeoutMs(
  env: string | undefined = process.env.MEMEX_PARSE_TIMEOUT_MS,
): number {
  const v = env?.trim();
  if (v === undefined || v === "") return DEFAULT_PARSE_TIMEOUT_MS;
  const ms = Number(v);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(
      `MEMEX_PARSE_TIMEOUT_MS must be a non-negative number of ms ` +
        `(got ${JSON.stringify(v)}); 0 disables the cap`,
    );
  }
  if (ms === 0) return 0;
  return Math.max(1, Math.floor(ms));
}

/**
 * Parse `source` under the configured wall-clock budget. On overrun the parse
 * is cancelled (null) — this resets the parser (a cancelled tree-sitter parser
 * is left RESUMABLE; reusing the cached instance without reset would corrupt
 * the NEXT parse, returning a spurious `hasError`) and throws
 * `ParseTimeoutError`. Budget 0 parses with no cap. Returns a non-null Tree.
 */
export function parseWithBudget(parser: Parser, source: string) {
  const budgetMs = resolveParseTimeoutMs();
  let tree: ReturnType<Parser["parse"]>;
  if (budgetMs <= 0) {
    tree = parser.parse(source);
  } else {
    const deadline = Date.now() + budgetMs;
    // progressCallback is typed `=> void` but tree-sitter cancels the parse
    // when it returns a truthy value (verified against web-tree-sitter 0.25).
    const cancelWhenOverBudget = (() =>
      Date.now() > deadline) as unknown as () => void;
    tree = parser.parse(source, null, { progressCallback: cancelWhenOverBudget });
  }
  if (!tree) {
    parser.reset(); // clear the cancelled state before this cached parser is reused
    throw new ParseTimeoutError(budgetMs);
  }
  return tree;
}

let initPromise: Promise<void> | null = null;
const languageCache = new Map<CodeLanguage, Promise<Language>>();
const parserCache = new Map<CodeLanguage, Parser>();

/**
 * Idempotent global init. Multiple concurrent callers share one promise.
 */
export function ensureParserInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

/**
 * Load (and cache) a tree-sitter Language by reading its `.wasm` file
 * from the vendored `wasm/` directory.
 */
export async function loadLanguage(lang: CodeLanguage): Promise<Language> {
  await ensureParserInit();
  let cached = languageCache.get(lang);
  if (!cached) {
    const filename = WASM_FILES[lang];
    const path = join(wasmDir(), filename);
    if (!existsSync(path)) {
      throw new Error(
        `core/chunkers/parsers: wasm grammar not found at ${path}. ` +
          `Run \`bun install\` and verify \`deploy/memex/wasm/${filename}\` ` +
          `is vendored. Set MEMEX_WASM_DIR to override.`,
      );
    }
    // Pass the bytes directly so Emscripten doesn't need to know how to
    // fetch from a `file://` URL — works identically in Bun, Node, and
    // any test runner.
    const bytes = new Uint8Array(readFileSync(path));
    cached = Language.load(bytes);
    languageCache.set(lang, cached);
  }
  return cached;
}

/**
 * Return a Parser pre-bound to the requested language. Subsequent calls
 * for the same language return the same instance — Parser carries the
 * language reference, no per-parse allocation.
 */
export async function getParser(lang: CodeLanguage): Promise<Parser> {
  const cached = parserCache.get(lang);
  if (cached) return cached;
  const language = await loadLanguage(lang);
  const p = new Parser();
  p.setLanguage(language);
  parserCache.set(lang, p);
  return p;
}

/** Test helper: drop all caches. Production code must never call this. */
export function _resetParsersForTests(): void {
  initPromise = null;
  languageCache.clear();
  for (const p of parserCache.values()) {
    try {
      p.delete();
    } catch {
      // best-effort
    }
  }
  parserCache.clear();
}
