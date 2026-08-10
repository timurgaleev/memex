/**
 * CLI argument parsing.
 *
 * The old inline parser got two things wrong, and both turned a typo into a
 * silent, wrong — sometimes expensive — run:
 *
 *   1. A boolean flag consumed the next token whenever that token was not
 *      `--`-prefixed. `memex embed --dry-run <slug>` therefore lost BOTH the
 *      slug and the dry-run and started a real, paid whole-corpus backfill.
 *      `VALUELESS_FLAGS` settles it by name, not by position: a boolean is a
 *      boolean wherever it sits on the line.
 *   2. `--key=value` arrives as ONE token and was never split, so
 *      `memex search --k=5 hello` searched with the default k and
 *      `memex apply-migrations --dry-run=true` really applied.
 *
 * Adding a new boolean flag to a command means adding it to VALUELESS_FLAGS
 * too — otherwise it eats the next positional. The test asserts that.
 */

/**
 * Flags that never take a value — one entry per boolean the command cases in
 * cli.ts read out of `flags`. Matching is exact, so the value-taking
 * near-twins (`--stale-days`, `--pglite-path`, `--postgres-url`) are
 * untouched. `--limit` is deliberately absent: it TAKES a value, and the
 * embed/salience/cycle cases read it from `flags` only to detect that the
 * value is missing.
 */
export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
  "--all",
  "--apply",
  "--catch-up",
  "--contextual",
  "--cosine-rescore",
  "--dry-run",
  "--expand",
  "--explain",
  "--fix",
  "--force",
  "--graph-signals",
  "--help",
  "--http",
  "--include-flagged",
  "--json",
  "--max-pool",
  "--no-expand",
  "--no-redact",
  "--no-respect-quiet-hours",
  "--per-source",
  "--pglite",
  "--postgres",
  "--promote",
  "--rechunk-stale",
  "--reconcile-deletes",
  "--relational-arm",
  "--rerank",
  "--respect-quiet-hours",
  "--save",
  "--stale",
  "--stdin",
  "--strict",
  "--with-calibration",
  "--write-baseline",
]);

/**
 * `--flag=<literal>` forms a boolean accepts.
 *
 * A bare `--flag=` is an ERROR, not ON. Shells expand an unset variable to
 * nothing, so `memex reindex --force=$MODE` arrives as `--force=` — and the
 * destructive booleans (`--apply`, `--force`, `--fix`) are exactly the ones
 * where guessing ON turns a typo into data loss. Refusing is the only reading
 * that cannot silently destroy something.
 */
const TRUE_LITERALS: ReadonlySet<string> = new Set(["true", "1", "yes"]);
const FALSE_LITERALS: ReadonlySet<string> = new Set(["false", "0", "no"]);

export interface ParsedArgs {
  cmd: string | undefined;
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

export function parseArgs(raw: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const cmd = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const token = raw[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    // `--key=value` is a single token. Split on the FIRST '=' only, so a value
    // may contain more of them (JSON payloads and URLs do).
    const eq = token.indexOf("=");
    if (eq > 2) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (VALUELESS_FLAGS.has(key)) {
        const literal = value.toLowerCase();
        if (TRUE_LITERALS.has(literal)) {
          flags.add(key);
        } else if (!FALSE_LITERALS.has(literal)) {
          throw new Error(
            `memex: ${key} is a boolean flag — got '${token}' (use ${key}, ${key}=true or ${key}=false)`,
          );
        }
      } else {
        values.set(key, value);
      }
      continue;
    }
    // A boolean never consumes the next token, whatever follows it.
    if (VALUELESS_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }
    const next = raw[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(token, next);
      i++;
    } else {
      // A value-taking flag with nothing to take lands in `flags`, where the
      // command case rejects it (see the `--limit` guards) instead of guessing.
      flags.add(token);
    }
  }
  return { cmd, flags, values, positional };
}
