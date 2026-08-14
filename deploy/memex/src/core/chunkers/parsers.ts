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
import { Parser, Language, type Tree } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export type CodeLanguage =
  | "typescript"
  | "tsx"
  | "python"
  | "bash"
  | "go"
  | "sql";

export const WASM_FILES: Record<CodeLanguage, string> = {
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

/**
 * Parse `source`, hand the tree to `use`, and ALWAYS release the tree.
 *
 * A Tree is an allocation in the Emscripten heap; JS garbage collection never
 * reclaims it, only `Tree.delete()` does. The code sweep parses one tree per
 * file plus one per symbol, so trees that were merely dropped on the floor grew
 * the heap by tens of thousands of allocations on a single boot sweep, in a
 * process that then runs for weeks. Ownership lives here, next to the parse,
 * rather than at each call site — "who frees this" is not a question a future
 * caller should be able to get wrong — and the `finally` keeps a throw inside
 * `use` (or a degrade path that swallows it upstream) from skipping the free.
 *
 * `use` MUST be synchronous and MUST NOT let a `Node` escape: nodes are views
 * into the tree and read freed memory once it is gone.
 */
export function withParsedTree<T>(
  parser: Parser,
  source: string,
  use: (tree: Tree) => T,
): T {
  const tree = parseWithBudget(parser, source);
  try {
    return use(tree);
  } finally {
    tree.delete();
  }
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
    // A grammar built against a different tree-sitter runtime fails in one of
    // two ways, and BOTH are opaque bare:
    //   1. Emscripten rejects while LINKING the side module, before the ABI can
    //      be read, with an EMPTY message — what this wrapper names.
    //   2. It links cleanly and parses simple input, then dies inside the
    //      external scanner on a real construct (`case…esac`, an array slice)
    //      with `resolved is not a function` — the shape of the live incident
    //      that left every .sh file unindexed. That one escapes this wrapper by
    //      design: it happens at parse time, not load time. The guard for it is
    //      `tests/grammar_selfcheck.test.ts`, whose fixtures exercise the
    //      scanner; keep them scanner-heavy or the guard stops guarding.
    cached = Language.load(bytes).catch((e: unknown) => {
      const detail = e instanceof Error && e.message ? e.message : "(empty error — link-time failure)";
      throw new GrammarLoadError(lang, path, bytes.byteLength, detail);
    });
    languageCache.set(lang, cached);
  }
  return cached;
}

/** A grammar blob that this runtime cannot link. Carries the facts a bare
 *  Emscripten rejection drops: which language, which file, how big, and the
 *  original (often empty) reason. */
export class GrammarLoadError extends Error {
  constructor(
    readonly language: CodeLanguage,
    readonly path: string,
    readonly bytes: number,
    readonly reason: string,
  ) {
    super(
      `tree-sitter grammar '${language}' failed to load from ${path} ` +
        `(${bytes} bytes): ${reason}. The blob is almost certainly built for a ` +
        `different tree-sitter runtime than web-tree-sitter in package.json — ` +
        `re-vendor it from its pinned npm grammar package.`,
    );
    this.name = "GrammarLoadError";
  }
}

/**
 * Verify the vendored grammar blobs still match `wasm/manifest.json`.
 *
 * Build hygiene, NOT a health check: the manifest was generated from these very
 * blobs, so agreement only ever proves the blobs are the blobs. During the live
 * incident every byte matched and every .sh file still threw at parse time.
 * `grammarSelfCheck` is what answers "does this grammar work"; this answers the
 * narrower "did someone swap a blob without re-vendoring", which is worth
 * asserting in the suite when a re-vendor lands.
 */
export function verifyGrammarManifest(): {
  ok: boolean;
  checked: number;
  problems: string[];
} {
  const manifestPath = join(wasmDir(), "manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, checked: 0, problems: ["wasm/manifest.json is missing"] };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    grammars: Record<string, { sha256: string; bytes: number }>;
  };
  const problems: string[] = [];
  let checked = 0;
  for (const [file, expected] of Object.entries(manifest.grammars)) {
    const path = join(wasmDir(), file);
    if (!existsSync(path)) {
      problems.push(`${file}: missing`);
      continue;
    }
    const buf = readFileSync(path);
    checked += 1;
    if (buf.byteLength !== expected.bytes) {
      problems.push(`${file}: ${buf.byteLength} bytes, manifest says ${expected.bytes}`);
      continue;
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== expected.sha256) problems.push(`${file}: sha256 drift`);
  }
  return { ok: problems.length === 0, checked, problems };
}

/**
 * One probe per shipped language: the smallest input that still exercises the
 * grammar for real, plus the root node type a healthy parse produces.
 *
 * The bash probe is deliberately scanner-heavy. The blobs this exists to reject
 * LINK cleanly and parse simple input (`greet() { echo hi; }` passes on them);
 * they only die once the external scanner runs — `case…esac`, an array slice,
 * ANSI-C quoting — with the production symptom `resolved is not a function`. A
 * probe without those constructs is a check that checks nothing, which is how
 * the broken shell grammar shipped in the first place. Keep every probe small
 * enough that six of them cost milliseconds: `doctor` runs them all.
 */
export const GRAMMAR_PROBES: Readonly<
  Record<CodeLanguage, { readonly source: string; readonly root: string }>
> = Object.freeze({
  bash: {
    source:
      "#!/bin/sh\n" +
      "greet() { echo hi; }\n" +
      "case $1 in\n  a) echo a;;\n  *) echo b;;\nesac\n" +
      // Shell parameter expansion inside a bash fixture, not a JS template
      // literal that lost its backticks. It is here precisely to prove the
      // bash grammar parses it.
      // eslint-disable-next-line no-template-curly-in-string
      'echo "${arr[@]:1:2}"\n' +
      "printf $'\\x41'\n",
    root: "program",
  },
  go: {
    source:
      "package main\n\n" +
      "const (\n\tA = iota\n\tB\n)\n\n" +
      "type T struct {\n\tName string `json:\"name\"`\n}\n\n" +
      "func Add(a int) int { return a + 1 }\n",
    root: "source_file",
  },
  python: { source: "def add(a):\n    return a + 1\n", root: "module" },
  typescript: {
    source: "export function add(a: number): number { return a + 1 }\n",
    root: "program",
  },
  tsx: { source: "export const A = () => <div>hi</div>;\n", root: "program" },
  sql: { source: "SELECT id FROM users WHERE id = 1;\n", root: "program" },
});

export interface GrammarCheckResult {
  language: CodeLanguage;
  ok: boolean;
  /** Grammar ABI version, when the blob linked far enough to expose one. */
  abi?: number;
  /** Which half of the check failed — only set when `ok` is false. */
  stage?: "load" | "parse";
  /** Why it failed, verbatim where the runtime gave us anything. */
  error?: string;
}

/**
 * Load every declared grammar AND parse its probe, reporting which language
 * failed and how.
 *
 * Loading alone is not enough: the incident that took the shell corpus out of
 * the brain for weeks linked cleanly and died inside the external scanner on
 * ordinary syntax, so a load-only (or, worse, bytes-vs-manifest) check reported
 * green while every .sh file threw. A grammar that fails here indexes ZERO
 * symbols for its file type — the file still lands as plain text via the
 * indexer's degrade path, but the call graph for that language is simply gone,
 * silently, until someone reads the sweep counters.
 *
 * Cost: linking all six grammars is ~112 MB of resident Emscripten heap, which
 * this deliberately avoided paying on a box with OOM history. It is paid now
 * because the cheap check could not have caught the real fault, and it is paid
 * ONCE per process — `loadLanguage`/`getParser` cache, and a sweep over a mixed
 * repo links the same grammars anyway. Emscripten offers no way to unload a
 * linked language, so there is nothing to give back afterwards.
 */
export async function grammarSelfCheck(): Promise<GrammarCheckResult[]> {
  const out: GrammarCheckResult[] = [];
  for (const lang of Object.keys(WASM_FILES) as CodeLanguage[]) {
    let parser: Parser;
    let abi: number | undefined;
    try {
      abi = (await loadLanguage(lang)).abiVersion;
      parser = await getParser(lang);
    } catch (e) {
      out.push({
        language: lang,
        ok: false,
        stage: "load",
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const probe = GRAMMAR_PROBES[lang];
    try {
      // Everything the probe asserts is read INSIDE the callback: the tree is
      // freed on the way out, so no Node may outlive it.
      const problem = withParsedTree(parser, probe.source, (tree) => {
        const root = tree.rootNode;
        if (root.type !== probe.root) {
          return `probe parsed as '${root.type}', expected '${probe.root}' — wrong grammar for this language?`;
        }
        if (root.hasError) return "probe input parsed with syntax errors";
        return null;
      });
      if (problem) out.push({ language: lang, ok: false, abi, stage: "parse", error: problem });
      else out.push({ language: lang, ok: true, abi });
    } catch (e) {
      out.push({
        language: lang,
        ok: false,
        abi,
        stage: "parse",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
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
