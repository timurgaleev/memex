/**
 * CLI argument parsing.
 *
 * Both defects below turned a typo into a silent, wrong, sometimes expensive
 * run — so each case here is written against the OLD parser's behaviour, which
 * is reproduced verbatim in `oldParseArgs` so the guard can be shown to be real
 * rather than decorative.
 */
import { describe, expect, it } from "bun:test";
import { parseArgs, VALUELESS_FLAGS } from "../src/cli-args.ts";

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
