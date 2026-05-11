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

export type CodeLanguage = "typescript" | "tsx" | "python";

const WASM_FILES: Record<CodeLanguage, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
};

const EXTENSION_TO_LANG: Record<string, CodeLanguage> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
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
