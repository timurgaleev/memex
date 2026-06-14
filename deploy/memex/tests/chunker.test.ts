import { describe, it, expect } from "bun:test";
import {
  chunkMarkdown,
  parseFrontmatter,
} from "../src/core/chunkers/index.ts";

describe("parseFrontmatter", () => {
  it("returns empty frontmatter when none present", () => {
    const r = parseFrontmatter("# Hello\n\nbody");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("# Hello\n\nbody");
  });

  it("parses simple key: value frontmatter", () => {
    const md = `---\ntitle: Hello\nauthor: 'Sample'\n---\nbody here\n`;
    const r = parseFrontmatter(md);
    expect(r.frontmatter).toEqual({ title: "Hello", author: "Sample" });
    expect(r.body).toBe("body here\n");
  });

  it("parses YAML lists with `-` items", () => {
    const md = `---\ntags:\n  - alpha\n  - beta\n---\nx\n`;
    const r = parseFrontmatter(md);
    expect(r.frontmatter).toEqual({ tags: ["alpha", "beta"] });
  });

  it("returns no frontmatter when delimiter is missing", () => {
    const md = `---\ntitle: Lost\nbody never closes`;
    const r = parseFrontmatter(md);
    expect(r.frontmatter).toEqual({});
  });
});

describe("chunkMarkdown", () => {
  it("returns one chunk for a tiny document", () => {
    const r = chunkMarkdown("# Hi\n\nA single paragraph.");
    expect(r.chunks.length).toBe(1);
    expect(r.title).toBe("Hi");
  });

  it("splits at H1 / H2 boundaries", () => {
    const md = `# Top\nintro text\n\n## Section A\naaa\n\n## Section B\nbbb\n`;
    const r = chunkMarkdown(md, { minChars: 0 });
    expect(r.chunks.length).toBe(3);
    expect(r.chunks[0]).toContain("# Top");
    expect(r.chunks[1]).toContain("Section A");
    expect(r.chunks[2]).toContain("Section B");
  });

  it("falls back to paragraph splitting when a section is over maxChars", () => {
    const para = "lorem ipsum ".repeat(100); // ~1200 chars
    const md = `# Big\n\n${para}\n\n${para}\n\n${para}\n`;
    const r = chunkMarkdown(md, { maxChars: 1500, minChars: 0 });
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) {
      expect(c.length).toBeLessThanOrEqual(1500);
    }
  });

  it("hard-splits a wall-of-text paragraph with no blank lines or newlines", () => {
    // A voice-note transcript: one unbroken sentence-delimited blob, no blank
    // lines (so paragraph splitting alone leaves it whole). Every chunk must
    // still respect maxChars so the embedding model's token cap is never hit.
    const sentence = "Wir besprechen die AWS Backup Strategie heute. ";
    const blob = sentence.repeat(400); // ~19k chars, single paragraph
    const md = `# Voice Note\n\n${blob}`;
    const r = chunkMarkdown(md, { maxChars: 1500, minChars: 0 });
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) {
      expect(c.length).toBeLessThanOrEqual(1500);
    }
  });

  it("hard-slices a single run with no sentence boundaries at all", () => {
    // Worst case: a long run with no terminators -- the char-slice floor must
    // still bound every chunk to maxChars.
    const blob = "x".repeat(20000);
    const md = `# Blob\n\n${blob}`;
    const r = chunkMarkdown(md, { maxChars: 1500, minChars: 0 });
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) {
      expect(c.length).toBeLessThanOrEqual(1500);
    }
  });

  it("keeps every chunk within the safety ceiling with overlap ON", () => {
    // Overlap + mergeShort run after splitBySize and can regrow a chunk; the
    // final clamp must keep the public output bounded (<= 2x maxChars) so the
    // embedder is never handed an over-cap chunk.
    const sentence = "Wir besprechen die AWS Backup Strategie heute. ";
    const blob = sentence.repeat(400);
    const md = `# Voice Note\n\n${blob}`;
    const r = chunkMarkdown(md, { maxChars: 1500, overlapChars: 700 });
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) {
      expect(c.length).toBeLessThanOrEqual(3000);
    }
  });

  it("loses no substance when hard-splitting a wall-of-text blob", () => {
    const blob = "alpha beta gamma delta epsilon zeta ".repeat(500);
    const md = `# Note\n\n${blob}`;
    const r = chunkMarkdown(md, { maxChars: 1500, minChars: 0 });
    const joined = r.chunks.join(" ").replace(/\s+/g, " ");
    for (const tok of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) {
      expect(joined).toContain(tok);
    }
  });

  it("merges chunks shorter than minChars with the next sibling", () => {
    const md = `# A\nshort\n\n## B\nshort\n\n## C\n${"x".repeat(800)}\n`;
    const r = chunkMarkdown(md, { minChars: 100 });
    // The two short sections should fold into the third.
    expect(r.chunks.length).toBeLessThanOrEqual(2);
  });

  it("preserves frontmatter and body title", () => {
    const md = `---\ntitle: Override\ntags:\n  - x\n---\n# Real Title\nbody.\n`;
    const r = chunkMarkdown(md);
    expect(r.frontmatter).toEqual({ title: "Override", tags: ["x"] });
    expect(r.title).toBe("Real Title");
  });
});
