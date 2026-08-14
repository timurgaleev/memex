/**
 * The prose/markup pass must stay linear in body length.
 *
 * `"[a"` repeated is the adversarial shape for the markdown-link strip: every
 * `[` is preceded by an `a`, so the `(?<!\[)` guard passes, the anchor class
 * `[^\]]` accepts both characters in the body, and the run therefore walks to
 * the END OF THE BODY from every start position looking for a `]` that is not
 * there. With an unbounded class that is quadratic — measured through
 * `assessContentSanity` at 5.4 s for 62 K, 22 s for 125 K, 92 s for 250 K and
 * 350 s for 500 K, growth ratio 4.0.
 *
 * 500 KB is not a theoretical size: it is the top of the prose window
 * (`DEFAULT_BYTES_BLOCK`), and the pass runs on the FULL body, so a page a
 * scraper can produce by accident holds the ingest worker for six minutes.
 *
 * The `(?<!\[)` lookbehind alone does NOT fix this — it only skips positions
 * whose previous character is `[`, which defends the `"[[[["` shape and nothing
 * else. Only the length bound removes the forward walk.
 *
 * The ceiling below is deliberately loose. Linear runs each of these bodies in
 * well under a second; quadratic needs minutes. Anything in between is a real
 * regression, and a slow CI box cannot manufacture a 20x miss.
 */
import { describe, expect, it } from "bun:test";
import {
  assessContentSanity,
  assessProse,
  DEFAULT_BYTES_BLOCK,
  DEFAULT_BYTES_WARN,
} from "../src/core/content-sanity.ts";

const CEILING_MS = 15_000;

/** Top of the prose window — the largest body the pass ever sees. */
const WORST_CASE_BYTES = DEFAULT_BYTES_BLOCK;

/** One shape per unbounded run that was quadratic before the bound. */
const ADVERSARIAL: ReadonlyArray<[string, string]> = [
  ["[a", "markdown-link anchor run"],
  ["[a](x", "markdown-link URL run"],
  ["![a", "markdown-image anchor run"],
  ["![a](x", "markdown-image URL run"],
  ["<a", "HTML tag attribute run"],
];

describe("prose/markup scan cost", () => {
  for (const [shape, label] of ADVERSARIAL) {
    it(`stays linear on a 500 KB run of ${label}`, () => {
      const body = shape.repeat(Math.floor(WORST_CASE_BYTES / shape.length));
      // The body must sit INSIDE the prose window, or the pass never runs and
      // the test would pass by measuring nothing.
      expect(body.length).toBeGreaterThan(DEFAULT_BYTES_WARN);
      expect(body.length).toBeLessThanOrEqual(DEFAULT_BYTES_BLOCK);

      const started = performance.now();
      const result = assessContentSanity({ body, title: "linearity probe" });
      const elapsed = performance.now() - started;

      // Proof the pass actually ran rather than bailing early: a null
      // prose_chars means the prose window was missed.
      expect(result.prose_chars).not.toBeNull();
      expect(elapsed).toBeLessThan(CEILING_MS);
    });
  }
});

describe("prose/markup scan correctness", () => {
  it("still strips links, images and tags from ordinary prose", () => {
    // Anchor text is KEPT, the URL is dropped; images and tags go entirely.
    const body = "See [Ada Lovelace](https://ada.dev) and ![chart](c.png) in <b>bold</b>.";
    const { markup_ratio } = assessProse(body);
    // "https://ada.dev", "![chart](c.png)" and the tags are markup; the words
    // survive. Ratio is well above zero and well below everything-is-markup.
    expect(markup_ratio).toBeGreaterThan(0.3);
    expect(markup_ratio).toBeLessThan(0.7);
  });

  it("reads a markup-only body as high markup and clean prose as low", () => {
    expect(assessProse("<div><span><p></p></span></div>").markup_ratio).toBe(1);
    expect(assessProse("Plain sentences with no markup at all.").markup_ratio).toBe(0);
  });

  it("excludes fenced code from the ratio entirely", () => {
    expect(assessProse("```\n<div>x</div>\n```").markup_ratio).toBe(0);
  });

  it("bounds each markup run at 512 characters", () => {
    // The bound is where the fix says it is: a link whose anchor is exactly at
    // the cap still strips to its anchor text; one character more and the link
    // is left alone (counted as prose, which only ever LOWERS the ratio — the
    // conservative direction for a gate that flags rather than hides).
    const at = "a".repeat(512);
    const over = "a".repeat(513);
    expect(assessProse(`[${at}](u)`).prose_chars).toBe(512);
    expect(assessProse(`[${over}](u)`).prose_chars).toBe(`[${over}](u)`.length);

    // Same cap on the URL run and on the HTML attribute run.
    expect(assessProse(`[x](${"u".repeat(512)})`).prose_chars).toBe(1);
    expect(assessProse(`[x](${"u".repeat(513)})`).prose_chars).toBe(
      `[x](${"u".repeat(513)})`.length,
    );
    // For a tag the run starts AFTER the leading letter, so `<a` + 512 attribute
    // chars is exactly at the cap.
    expect(assessProse(`<a${"z".repeat(512)}>`).prose_chars).toBe(0);
    expect(assessProse(`<a${"z".repeat(513)}>`).prose_chars).toBe(516);
  });
});
