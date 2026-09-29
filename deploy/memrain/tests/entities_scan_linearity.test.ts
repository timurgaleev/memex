/**
 * The entity wikilink scan must stay linear in chunk length.
 *
 * Two adversarial shapes, one per unbounded run in the old pattern
 * `/(?<!\[)\[\[([^\]|\n]+)(\|[^\]]*)?\]\]/g`:
 *
 *   - `[[a|` repeated — the target stops at the `|` after one char, then the
 *     alias class `[^\]]` (which excludes only `]`) walks to the end of the
 *     chunk before failing on the missing `]]`.
 *   - `[[a` repeated — the target class `[^\]|\n]` accepts both `[` and `a`,
 *     so the target itself walks to the end.
 *
 * Either way the walk happens from every one of the n start positions. Measured
 * on extractWikilinks before the bounds: `[[a|` at 32 K chars = 725 ms, 64 K =
 * 2.85 s, 128 K = 11.7 s, 256 K = 51.0 s; `[[a` at 192 K chars = 69 s. Both
 * square cleanly. Nothing upstream caps the text handed to extractEntities, so
 * one indexed page of that shape could hold the indexer for minutes.
 *
 * The ceiling below is deliberately loose. Linear runs these inputs in about a
 * second; quadratic needs minutes. Anything in between is a real regression,
 * and a slow CI box cannot manufacture a 60x miss.
 */
import { describe, expect, it } from "bun:test";
import { extractEntities, extractWikilinks } from "../src/core/entities";

const CEILING_MS = 15_000;

describe("entity wikilink scan cost", () => {
  it("stays linear on a 1 MB run of unterminated aliases", () => {
    const body = "[[a|".repeat(250_000);
    expect(body.length).toBe(1_000_000);

    const started = performance.now();
    const out = extractWikilinks(body);
    const elapsed = performance.now() - started;

    // Nothing in that body is a wikilink — proof the scan did the work rather
    // than bailing early.
    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear on a 1 MB run of unterminated targets", () => {
    const body = "[[a".repeat(333_333);

    const started = performance.now();
    const out = extractWikilinks(body);
    const elapsed = performance.now() - started;

    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear through extractEntities, the indexer's entry point", () => {
    const body = "[[a|".repeat(250_000);

    const started = performance.now();
    const out = extractEntities(body);
    const elapsed = performance.now() - started;

    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still extracts targets, aliases and duplicates from ordinary prose", () => {
    const body =
      "see [[people/ada-lovelace]] and [[companies/acme|Acme Corp]], " +
      "then [[people/ada-lovelace]] again, plus [[x]] and [[a/b#heading]]";
    expect(extractWikilinks(body).map((e) => e.name)).toEqual([
      "people/ada-lovelace",
      "companies/acme",
      "x",
      "a/b#heading",
    ]);
  });

  it("keeps an empty alias matching, as the unbounded pattern did", () => {
    // `[[a|]]` relies on the alias run accepting zero characters — the bound is
    // `{0,512}`, not `{1,512}`, precisely so this shape survives.
    expect(extractWikilinks("[[a|]]").map((e) => e.name)).toEqual(["a"]);
  });

  it("drops a target longer than a slug can be, and keeps one at the cap", () => {
    // The bound is not arbitrary: a page slug is capped at 256 (MAX_SLUG_LEN in
    // core/links.ts), so a longer target could never resolve to a page.
    expect(extractWikilinks(`[[${"a".repeat(256)}]]`).map((e) => e.name)).toEqual(
      ["a".repeat(256)],
    );
    expect(extractWikilinks(`[[${"a".repeat(257)}]]`)).toEqual([]);
  });

  it("drops an alias longer than the display cap, and keeps one at the cap", () => {
    expect(
      extractWikilinks(`[[t|${"b".repeat(512)}]]`).map((e) => e.name),
    ).toEqual(["t"]);
    expect(extractWikilinks(`[[t|${"b".repeat(513)}]]`)).toEqual([]);
  });
});
