/**
 * The gazetteer's wikilink-masking scan must stay linear in body length.
 *
 * `[[a` repeated is the adversarial shape for WIKILINK_SPAN_RE. The `(?<!\[)`
 * guard on that pattern only pins runs of CONSECUTIVE brackets; a single non-`[`
 * character between the pairs re-opens a legal start every third offset. The
 * masked class `[^\]\n]` accepts both `[` and `a` and the body holds no `]` at
 * all, so an unbounded run walks to the END OF THE BODY from each of those n/3
 * starts before failing.
 *
 * Measured through scanMentions before the length bound: 24 K chars = 457 ms,
 * 48 K = 1.8 s, 96 K = 6.6 s, 192 K = 31 s — a clean squaring, extrapolating to
 * roughly fourteen minutes at the 1 MB MAX_BODY_LEN cap. Bounded, that same
 * 1 MB body is ~1.3 s.
 *
 * The ceiling below is deliberately loose. Linear runs this input in a second
 * or two; quadratic needs minutes. Anything in between is a real regression,
 * and a slow CI box cannot manufacture a 100x miss.
 */
import { describe, expect, it } from "bun:test";
import { scanMentions } from "../src/core/gazetteer.ts";

const CEILING_MS = 15_000;

/** The scan short-circuits on an empty gazetteer, so every case needs entries. */
const ENTRIES = [
  { phrase: "alice smith", slug: "people/alice-smith" },
  { phrase: "acme corp", slug: "companies/acme-corp" },
];

describe("gazetteer scan cost", () => {
  it("stays linear on a 1 MB run of unterminated wikilink openers", () => {
    const body = "[[a".repeat(333_334).slice(0, 1_000_000);
    expect(body.length).toBe(1_000_000);

    const started = performance.now();
    const out = scanMentions(body, ENTRIES);
    const elapsed = performance.now() - started;

    // Nothing in that body names an entity — the assertion that the scan did
    // the work rather than bailing out early.
    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still masks real wikilinks and still finds plain-prose mentions", () => {
    // Inside a wikilink the sync already owns the edge, so it is masked out.
    expect(scanMentions("see [[Alice Smith]] and Acme Corp", ENTRIES)).toEqual([
      "companies/acme-corp",
    ]);
    // Bare prose on both sides still resolves.
    expect(scanMentions("Alice Smith met Acme Corp", ENTRIES)).toEqual([
      "people/alice-smith",
      "companies/acme-corp",
    ]);
    // An aliased wikilink masks its display text too.
    expect(
      scanMentions("[[people/alice-smith|Alice Smith]] at Acme Corp", ENTRIES),
    ).toEqual(["companies/acme-corp"]);
  });

  it("masks a span at the 769-char bound and leaves a longer one alone", () => {
    // The bound is not arbitrary: this mask exists to blank the spans that
    // extractWikilinks (core/links.ts) turns into edges, and the widest span
    // that regex accepts is a 256-char target + `|` + a 512-char alias = 769.
    const name = "Alice Smith";
    const atCap = `[[${"x".repeat(769 - name.length - 1)} ${name}]]`;
    const overCap = `[[${"x".repeat(770 - name.length - 1)} ${name}]]`;

    // Exactly at the cap the span is still a maskable wikilink → no mention.
    expect(scanMentions(atCap, ENTRIES)).toEqual([]);
    // One char over, the extractor could not have made an edge from it either,
    // so the span is not masked and the prose inside is scanned normally.
    expect(scanMentions(overCap, ENTRIES)).toEqual(["people/alice-smith"]);
  });
});
