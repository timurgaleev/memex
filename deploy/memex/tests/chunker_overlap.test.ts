/**
 * Sliding-window chunk overlap (recursive markdown chunker). Overlap bridges a
 * size-driven split inside one heading section so a boundary-straddling fact
 * stays retrievable from both chunks; it never crosses a heading boundary, and
 * is OFF by default (env `MEMEX_CHUNK_OVERLAP` / `overlapChars` opt).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chunkMarkdown } from "../src/core/chunkers/index.ts";
import {
  overlapTail,
  resolveOverlapChars,
} from "../src/core/chunkers/recursive.ts";

const p1 = "Alpha sentence one. ".repeat(15); // ~300 chars, sentence-delimited
const p2 = "Bravo sentence two. ".repeat(15);
// One H1 section, two paragraphs that won't co-pack under maxChars=350.
const oneSection = `# H\n\n${p1}\n\n${p2}`;

afterEach(() => {
  delete process.env.MEMEX_CHUNK_OVERLAP;
});

describe("chunk overlap", () => {
  it("is OFF by default: adjacent size-split chunks share no text", () => {
    const r = chunkMarkdown(oneSection, { maxChars: 350, minChars: 0 });
    expect(r.chunks.length).toBe(2);
    expect(r.chunks[1]).not.toContain("Alpha"); // no bridge from chunk 0
    expect(r.chunks[0]).not.toContain("Bravo");
  });

  it("prepends the previous chunk's tail when overlapChars > 0", () => {
    const r = chunkMarkdown(oneSection, {
      maxChars: 350,
      minChars: 0,
      overlapChars: 80,
    });
    expect(r.chunks.length).toBe(2);
    // chunk 1 now carries a tail of p1 AND its own p2 content.
    expect(r.chunks[1]).toContain("Alpha sentence one");
    expect(r.chunks[1]).toContain("Bravo");
    // chunk 0 is unchanged (it has no predecessor).
    expect(r.chunks[0]).toContain("Alpha");
    expect(r.chunks[0]).not.toContain("Bravo");
  });

  it("never overlaps across a heading boundary", () => {
    const twoSections = `# A\n\n${p1}\n\n# B\n\n${p2}`;
    const r = chunkMarkdown(twoSections, {
      maxChars: 5000, // each section fits one chunk
      minChars: 0,
      overlapChars: 120,
    });
    expect(r.chunks.length).toBe(2);
    // section B must not inherit section A's text.
    expect(r.chunks[1]).not.toContain("Alpha");
  });

  it("skips overlap for a chunk with an EMBEDDED heading (mergeShort merge)", () => {
    // Section A's short tail merges into section B's start, so the final chunk
    // carries an embedded `# B`. Overlap must skip it -- bridging A's tail in
    // would cross the buried section boundary.
    const aBig = "Alpha sentence one. ".repeat(15);
    const aTail = "Short tail. ".repeat(8); // < minChars -> merges forward
    const bBig = "Bravo sentence two. ".repeat(15);
    const md = `# A\n\n${aBig}\n\n${aTail}\n\n# B\n\n${bBig}`;
    const r = chunkMarkdown(md, {
      maxChars: 350,
      minChars: 200,
      overlapChars: 80,
    });
    const merged = r.chunks.find((c) => c.includes("# B"))!;
    expect(merged).toContain("Short tail");
    expect(merged).not.toContain("Alpha"); // no bridge from section A
  });

  it("snaps the overlap to a sentence boundary (no mid-sentence start)", () => {
    const r = chunkMarkdown(oneSection, {
      maxChars: 350,
      minChars: 0,
      overlapChars: 80,
    });
    const overlapPart = r.chunks[1]!.split("Bravo")[0]!.trim();
    // The overlap begins at a sentence start ("Alpha"), not mid-word.
    expect(overlapPart.startsWith("Alpha")).toBe(true);
  });

  it("caps the overlap at half the previous chunk", () => {
    const r = chunkMarkdown(oneSection, {
      maxChars: 350,
      minChars: 0,
      overlapChars: 100000, // absurd -> capped at min(maxChars/2, prev/2)
    });
    const overlapPart = r.chunks[1]!.split("Bravo")[0]!;
    expect(overlapPart.length).toBeLessThanOrEqual(Math.floor(p1.length / 2) + 5);
  });

  it("reads the default from MEMEX_CHUNK_OVERLAP", () => {
    process.env.MEMEX_CHUNK_OVERLAP = "80";
    const r = chunkMarkdown(oneSection, { maxChars: 350, minChars: 0 });
    expect(r.chunks[1]).toContain("Alpha sentence one");
  });

  it("fails safe to OFF on a non-numeric env value", () => {
    process.env.MEMEX_CHUNK_OVERLAP = "not-a-number";
    const r = chunkMarkdown(oneSection, { maxChars: 350, minChars: 0 });
    expect(r.chunks[1]).not.toContain("Alpha");
  });

  // Regression (codex HIGH): overlap runs AFTER mergeShort, so it must change
  // chunk CONTENT only -- never the chunk COUNT (positional chunk ids stay
  // stable vs overlap-off). This doc has a short middle paragraph that
  // mergeShort folds into its neighbour.
  it("changes chunk content but never chunk count", () => {
    const big1 = "Alpha sentence one. ".repeat(15);
    const tiny = "Tiny mid. ".repeat(8); // ~80 chars < minChars
    const big2 = "Bravo sentence two. ".repeat(15);
    const md3 = `${big1}\n\n${tiny}\n\n${big2}`;
    const opts = { maxChars: 350, minChars: 250 };
    const off = chunkMarkdown(md3, opts).chunks;
    const on = chunkMarkdown(md3, { ...opts, overlapChars: 80 }).chunks;
    expect(on.length).toBe(off.length);
  });
});

describe("overlapTail", () => {
  it("falls back to a word boundary when the first sentence start is too short", () => {
    // The capped window's first sentence boundary leaves only "Hi" (< floor),
    // so it must fall back to a word-boundary tail rather than return "".
    const prev = `${"alpha bravo charlie ".repeat(6)}delta. Hi`;
    const tail = overlapTail(prev, 80);
    expect(tail.length).toBeGreaterThanOrEqual(16);
    expect(tail).not.toStartWith("Hi");
  });

  it("returns '' for a previous chunk with no whitespace (no mid-token bridge)", () => {
    const prev = "x".repeat(400); // one giant token / hash / URL
    expect(overlapTail(prev, 80)).toBe("");
  });

  it("returns '' when the previous chunk is too short to overlap", () => {
    expect(overlapTail("tiny", 80)).toBe("");
  });
});

describe("resolveOverlapChars", () => {
  it("returns 0 for undefined/0/negative and caps at maxChars/2", () => {
    expect(resolveOverlapChars(undefined, 4000)).toBe(0);
    expect(resolveOverlapChars(0, 4000)).toBe(0);
    expect(resolveOverlapChars(-5, 4000)).toBe(0);
    expect(resolveOverlapChars(100000, 4000)).toBe(2000);
    expect(resolveOverlapChars(2.9, 4000)).toBe(2);
  });
});
