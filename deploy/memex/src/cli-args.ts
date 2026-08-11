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

/**
 * Every flag that takes a value, across all commands. Derived from the
 * `values.get("--x")` reads in src/ — a flag missing here is rejected as a
 * typo, so adding a new value-taking flag means adding it here too.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--anchor", "--args", "--baseline", "--batch-size", "--boost-weight",
  "--budget", "--config-a", "--config-b", "--date-context", "--days",
  "--dedup-type-ratio", "--depth", "--description", "--dir", "--example-limit",
  "--expected-doc", "--file", "--filter", "--from", "--host", "--id",
  "--indexed-policy", "--input", "--k", "--keep-days", "--kind", "--limit",
  "--max-drop", "--max-pages", "--max-retries", "--max-usd",
  "--min-confidence", "--min-recall", "--model", "--modes", "--notes",
  "--older-than-days", "--out", "--path-prefix", "--paths", "--pattern",
  "--payload", "--pglite-path", "--phases", "--port", "--postgres-url",
  "--priority", "--qrels", "--query", "--question", "--rate-limit-per-minute",
  "--reason", "--rounds", "--rrf-k", "--search-mode", "--severity", "--since",
  "--skill", "--slug", "--slugs", "--source", "--source-id", "--source-path",
  "--source-slug", "--stale-days", "--status", "--sync-policy", "--tag",
  "--take", "--target", "--threshold", "--title", "--to", "--tool-name",
  "--top-skills", "--type", "--until", "--vault", "--what", "--where", "--who",
  "--window-turns", "--written-by",
]);

/** Union of every flag the CLI understands. Anything else is a typo. */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...VALUELESS_FLAGS,
  ...VALUE_FLAGS,
]);

/**
 * Flags that carry intent about whether real work happens, mapped to the
 * commands that actually honour them.
 *
 * A misspelled flag is caught by KNOWN_FLAGS, but a correctly spelled one on a
 * command that ignores it is the worse bug: `--dry-run` on a command with no
 * dry-run support reads as "preview" and mutates. The fallback for every one of
 * these is the mutating or paid path, so silence is the expensive answer.
 */
export const SAFETY_FLAG_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "--dry-run",
    new Set([
      "apply-migrations", "embed", "extract", "jobs", "lint", "migrate-engine",
      "reindex", "skillify",
    ]),
  ],
  ["--apply", new Set(["eval-prune", "quarantine", "search"])],
  ["--fix", new Set(["lint"])],
]);

export interface ParsedArgs {
  cmd: string | undefined;
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

export interface ParseArgsOptions {
  /**
   * Reject flags the CLI does not define, and safety flags on commands that
   * ignore them. Default ON: a dropped `--dry-run` costs money, and a dropped
   * `--limit` costs a whole-corpus pass.
   */
  strict?: boolean;
}

/** Thrown for an unknown or misplaced flag — the CLI prints it and exits 2. */
export class UnknownFlagError extends Error {}

/** "Did you mean" for a typo — one edit away, cheap Levenshtein under a cap. */
function nearest(flag: string): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(flag, known);
    if (d < bestD) {
      bestD = d;
      best = known;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** Validate the parsed flags against the CLI's vocabulary. */
export function validateFlags(parsed: ParsedArgs): void {
  const seen = [...parsed.flags, ...parsed.values.keys()];
  for (const flag of seen) {
    if (!KNOWN_FLAGS.has(flag)) {
      const hint = nearest(flag);
      throw new UnknownFlagError(
        `memex: unknown flag '${flag}'${hint ? ` — did you mean ${hint}?` : ""}`,
      );
    }
  }
  if (parsed.cmd === undefined) return;
  for (const [flag, commands] of SAFETY_FLAG_COMMANDS) {
    if ((parsed.flags.has(flag) || parsed.values.has(flag)) && !commands.has(parsed.cmd)) {
      throw new UnknownFlagError(
        `memex: ${flag} is not supported by '${parsed.cmd}' — refusing to run, ` +
          `because ignoring it would do the opposite of what it asks for`,
      );
    }
  }
}

export function parseArgs(raw: readonly string[], opts: ParseArgsOptions = {}): ParsedArgs {
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
  const parsed = { cmd, flags, values, positional };
  if (opts.strict !== false) validateFlags(parsed);
  return parsed;
}
