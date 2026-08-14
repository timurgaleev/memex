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
import { extractWikilinks } from "../src/core/links";

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
