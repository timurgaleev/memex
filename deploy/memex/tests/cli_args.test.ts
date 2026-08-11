/**
 * CLI argument parsing.
 *
 * Both defects below turned a typo into a silent, wrong, sometimes expensive
 * run — so each case here is written against the OLD parser's behaviour, which
 * is reproduced verbatim in `oldParseArgs` so the guard can be shown to be real
 * rather than decorative.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseArgs,
  SAFETY_FLAG_COMMANDS,
  VALUELESS_FLAGS,
  VALUE_FLAGS,
  KNOWN_FLAGS,
} from "../src/cli-args.ts";

/** The parser exactly as it shipped before this file existed (cli.ts:85-106). */
function oldParseArgs(raw: readonly string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const cmd = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const token = raw[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const next = raw[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(token, next);
        i++;
      } else {
        flags.add(token);
      }
    } else {
      positional.push(token);
    }
  }
  return { cmd, flags, values, positional };
}

describe("boolean flags never consume a positional (CLI-2)", () => {
  it("keeps the slug AND the dry-run for `embed --dry-run <slug>`", () => {
    // The old parser turned this into values={'--dry-run': 'notes/x'} with an
    // EMPTY flag set, so embed ran a real, paid, whole-corpus backfill.
    const old = oldParseArgs(["embed", "--dry-run", "notes/x"]);
    expect(old.flags.has("--dry-run")).toBe(false);
    expect(old.positional).toEqual([]);

    const now = parseArgs(["embed", "--dry-run", "notes/x"]);
    expect(now.flags.has("--dry-run")).toBe(true);
    expect(now.positional).toEqual(["notes/x"]);
  });

  it("is order-independent", () => {
    const a = parseArgs(["embed", "--dry-run", "notes/x"]);
    const b = parseArgs(["embed", "notes/x", "--dry-run"]);
    expect(a.positional).toEqual(b.positional);
    expect(a.flags.has("--dry-run")).toBe(b.flags.has("--dry-run"));
  });

  it("leaves value-taking flags alone", () => {
    const r = parseArgs(["search", "--k", "5", "hello"]);
    expect(r.values.get("--k")).toBe("5");
    expect(r.positional).toEqual(["hello"]);
  });
});

describe("--key=value is split (CLI-3)", () => {
  it("reads the value instead of dropping it", () => {
    // Worse than losing the flag: the old parser treated the whole `--k=5`
    // token as a key and then ate the QUERY as its value, so the search ran
    // with the default k and no search term at all.
    const old = oldParseArgs(["search", "--k=5", "hello"]);
    expect(old.values.get("--k")).toBeUndefined();
    expect(old.values.get("--k=5")).toBe("hello");
    expect(old.positional).toEqual([]);

    const now = parseArgs(["search", "--k=5", "hello"]);
    expect(now.values.get("--k")).toBe("5");
    expect(now.positional).toEqual(["hello"]);
  });

  it("splits on the first '=' only, so values may contain more", () => {
    const r = parseArgs(["call", "--args={\"a\":\"b=c\"}"]);
    expect(r.values.get("--args")).toBe('{"a":"b=c"}');
  });

  it("accepts explicit boolean literals", () => {
    expect(parseArgs(["reindex", "--force=true"]).flags.has("--force")).toBe(true);
    expect(parseArgs(["reindex", "--force=false"]).flags.has("--force")).toBe(false);
  });

  it("REFUSES a bare `--flag=` rather than guessing ON", () => {
    // An unset shell variable expands to nothing: `--force=$MODE` -> `--force=`.
    // Guessing ON there arms a destructive mode by accident.
    expect(() => parseArgs(["reindex", "--force="])).toThrow(/boolean flag/);
  });
});

describe("VALUELESS_FLAGS stays in sync", () => {
  it("contains the destructive booleans", () => {
    for (const f of ["--force", "--apply", "--fix", "--dry-run"]) {
      expect(VALUELESS_FLAGS.has(f)).toBe(true);
    }
  });

  it("does not contain value-taking near-twins", () => {
    for (const f of ["--limit", "--stale-days", "--k"]) {
      expect(VALUELESS_FLAGS.has(f)).toBe(false);
    }
  });
});

describe("strict flag validation", () => {
  it("refuses a misspelled flag and points at the real one", () => {
    expect(() => parseArgs(["embed", "--dry-runn"])).toThrow(
      /unknown flag '--dry-runn' — did you mean --dry-run\?/,
    );
    expect(() => parseArgs(["search", "--kk", "5"])).toThrow(/unknown flag '--kk'/);
  });

  it("refuses a safety flag on a command that would ignore it", () => {
    // The dangerous case is a CORRECTLY spelled flag the command drops: the
    // caller reads "preview", the command does the real thing.
    expect(() => parseArgs(["search", "--dry-run", "q"])).toThrow(
      /--dry-run is not supported by 'search'/,
    );
    expect(() => parseArgs(["embed", "--dry-run"])).not.toThrow();
  });

  it("accepts every flag the CLI actually reads", () => {
    for (const f of VALUELESS_FLAGS) expect(KNOWN_FLAGS.has(f)).toBe(true);
    for (const f of VALUE_FLAGS) expect(KNOWN_FLAGS.has(f)).toBe(true);
  });

  it("can be switched off for callers that parse foreign argv", () => {
    const r = parseArgs(["embed", "--not-a-memex-flag"], { strict: false });
    expect(r.flags.has("--not-a-memex-flag")).toBe(true);
  });
});

describe("SAFETY_FLAG_COMMANDS is derived from cli.ts, not hand-maintained", () => {
  // Hand-listing which commands honour --dry-run/--apply/--fix is exactly what
  // shipped a regression: `lint --dry-run`, `migrate-engine --dry-run` and
  // `quarantine scan --apply` were all real and all refused. The truth lives in
  // the command switch, so read it from there.
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "cli.ts"),
    "utf8",
  );

  function ownersOf(flag: string): string[] {
    const parts = source.split(/\n    case "([a-z0-9-]+)":/);
    const bodies = new Map<string, string>();
    for (let i = 1; i < parts.length; i += 2) {
      const cmd = parts[i]!;
      bodies.set(cmd, (bodies.get(cmd) ?? "") + parts[i + 1]!);
    }
    return [...bodies]
      .filter(([, body]) => body.includes(`flags.has("${flag}")`))
      .map(([cmd]) => cmd)
      .sort();
  }

  for (const flag of ["--dry-run", "--apply", "--fix"]) {
    it(`lists exactly the commands that read ${flag}`, () => {
      const declared = [...(SAFETY_FLAG_COMMANDS.get(flag) ?? [])].sort();
      expect(declared).toEqual(ownersOf(flag));
    });
  }

  it("accepts the invocations the first hand-written list refused", () => {
    for (const argv of [
      ["lint", "--dry-run"],
      ["lint", "--fix"],
      ["migrate-engine", "--dry-run"],
      ["quarantine", "scan", "--apply"],
      ["eval-prune", "--apply"],
    ]) {
      expect(() => parseArgs(argv)).not.toThrow();
    }
  });

  it("still refuses a safety flag on a command that ignores it", () => {
    expect(() => parseArgs(["doctor", "--fix"])).toThrow(/not supported by 'doctor'/);
  });
});
