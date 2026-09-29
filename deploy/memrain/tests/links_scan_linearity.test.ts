/**
 * The wikilink scan must stay linear in body length.
 *
 * `[[a|` repeated is the adversarial shape: every `[[` starts a candidate, the
 * target run ends immediately at the `|`, and the alias run then walks forward
 * looking for a `]]` that is not there. With an unbounded alias class that walk
 * reaches the end of the body from every start position, which is quadratic —
 * measured at 52 ms for 8 K links, 2.9 s for 64 K, and 243 s for 1 MB, on a
 * path where nothing caps the body. A page like that is cheap to write and
 * holds the daemon for minutes.
 *
 * The ceiling below is deliberately loose. Linear runs this input in well under
 * a second; quadratic needs minutes. Anything in between is a real regression,
 * and a slow CI box cannot manufacture a 20x miss.
 */
import { describe, expect, it } from "bun:test";
import {
  extractMarkdownLinks,
  extractWikilinks,
  slugifyTarget,
} from "../src/core/links";

const CEILING_MS = 15_000;

describe("wikilink scan cost", () => {
  it("stays linear on a 1 MB run of unterminated links", () => {
    const body = "[[a|".repeat(250_000);
    expect(body.length).toBe(1_000_000);

    const started = performance.now();
    const out = extractWikilinks(body);
    const elapsed = performance.now() - started;

    // Nothing in that body is a link — the assertion that the scan did the
    // work rather than bailing early.
    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still extracts targets, aliases and duplicates from ordinary prose", () => {
    const body =
      "see [[people/ada-lovelace]] and [[companies/acme|Acme Corp]], " +
      "then [[people/ada-lovelace]] again, plus [[x]] and [[a/b#heading]]";
    expect(extractWikilinks(body)).toEqual([
      "people/ada-lovelace",
      "companies/acme",
      "x",
      "a/b",
    ]);
  });

  it("drops a target longer than a slug can be, and keeps one at the cap", () => {
    // The bound is not arbitrary: a page slug is capped at 256, so a longer
    // target could never resolve to a page.
    expect(extractWikilinks(`[[${"a".repeat(256)}]]`)).toEqual([
      "a".repeat(256),
    ]);
    expect(extractWikilinks(`[[${"a".repeat(257)}]]`)).toEqual([]);
  });
});

/**
 * The markdown-link scan has the same shape of exposure as the wikilink one,
 * from the other quantifier: the display-text run.
 *
 * `[` repeated is the adversarial shape. Every `[` starts a candidate whose text
 * run walks forward looking for a `]` that is not there, so with an unbounded
 * run the walk reaches the end of the scan from every start position. Measured
 * through extractMarkdownLinks: 428 ms at 31 K, 25 s at 250 K, ratio 3.9 on a
 * doubling. The 512 bound (same as WIKILINK_RE's alias, and for the same
 * reason — it is display text, not a slug) puts 1 MB at ~450 ms.
 */
describe("markdown-link scan cost", () => {
  it("stays linear on a 1 MB run of unterminated links", () => {
    const body = "[".repeat(1_000_000);

    const started = performance.now();
    const out = extractMarkdownLinks(body);
    const elapsed = performance.now() - started;

    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  }, 60_000);

  it("still extracts targets, peels `../` and `.md`, and drops anchors", () => {
    expect(
      extractMarkdownLinks(
        "[A](../people/alice.md) [B](notes/b#heading) [C](https://x.test/y)",
      ),
    ).toEqual(["people/alice", "notes/b"]);
  });

  it("drops a link whose display text exceeds the alias bound, keeps one at it", () => {
    expect(extractMarkdownLinks(`[${"x".repeat(512)}](p/q)`)).toEqual(["p/q"]);
    expect(extractMarkdownLinks(`[${"x".repeat(513)}](p/q)`)).toEqual([]);
  });
});

/**
 * slugifyTarget's trailing `[-/]` trim is the third site with this shape.
 *
 * The two collapses above it only kill `--` and `//`, so an alternating
 * `-/-/-/…` run reaches the trim intact, and the MAX_SLUG_LEN slice lands after
 * it — nothing caps what the trim sees. Unguarded, `[-/]+$` restarts inside the
 * run at every offset: 300 ms at 25 K chars, 20 s at 200 K, ratio 4.0 on a
 * doubling. The `(?<![-/])` guard admits only a run's first character, which
 * makes the total walk the sum of the run lengths.
 */
describe("slugifyTarget trim cost", () => {
  it("stays linear on a 1 MB alternating run with a rejecting suffix", () => {
    const name = `a${"-/".repeat(500_000)}b`;

    const started = performance.now();
    const out = slugifyTarget(name);
    const elapsed = performance.now() - started;

    expect(out.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(CEILING_MS);
  }, 60_000);

  it("stays linear on the unicode-fallback path, which the same input reaches", () => {
    // A pure `-/` run folds to empty on the ASCII pass — that is exactly what
    // routes it to the second trim.
    const name = `я${"-/".repeat(500_000)}ж`;

    const started = performance.now();
    const out = slugifyTarget(name);
    const elapsed = performance.now() - started;

    expect(out.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(CEILING_MS);
  }, 60_000);

  it("still trims, collapses and folds exactly as before", () => {
    expect(slugifyTarget("Alice Smith")).toBe("alice-smith");
    expect(slugifyTarget("  people/Ada  ")).toBe("people/ada");
    expect(slugifyTarget("--people//ada--")).toBe("people/ada");
    expect(slugifyTarget("-/-/-/")).toBe("unknown");
    expect(slugifyTarget("---")).toBe("unknown");
    expect(slugifyTarget("Привет Мир")).toBe(
      "привет-мир",
    );
  });
});
