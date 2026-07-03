/**
 * Content-sanity gate — the marker WRITER. Verifies the deterministic assessor
 * (junk / oversize / markup / clean) and the frontmatter stamper that stamps
 * the SAME quarantine / content_flag / embed_skip markers the read side honors,
 * then an end-to-end pass through the indexer chokepoint.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessContentSanity,
  stampSanityMarkers,
  ContentSanityBlockError,
  DEFAULT_BYTES_BLOCK,
} from "../src/core/content-sanity.ts";
import { isQuarantined, isContentFlagged } from "../src/core/quarantine.ts";
import { isEmbedSkipped } from "../src/core/embed-skip.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = (t: string) => Promise.resolve(deterministicEmbed(t));

const CLEAN =
  "# Quarterly Plan\n\nThis quarter we ship the ingest gate. The team agreed to " +
  "prioritize retrieval quality over new surfaces, and to measure the impact " +
  "with a small evaluation harness before committing to the larger refactor.";

const JUNK =
  "Attention Required! | Cloudflare\n\nPlease enable cookies. Ray ID: 7abc. " +
  "Checking your browser before accessing the site.";

describe("assessContentSanity", () => {
  it("passes clean prose with no markers", () => {
    const r = assessContentSanity({ body: CLEAN, title: "Quarterly Plan" });
    expect(r.shouldQuarantine).toBe(false);
    expect(r.shouldFlag).toBe(false);
    expect(r.shouldSkipEmbed).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  it("quarantines scraper junk on a built-in pattern", () => {
    const r = assessContentSanity({ body: JUNK, title: "Attention Required!" });
    expect(r.shouldQuarantine).toBe(true);
    expect(r.junk_pattern_matches.length).toBeGreaterThan(0);
    expect(r.shouldFlag).toBe(false); // hidden, not flagged
  });

  it("quarantines on an operator literal substring", () => {
    const r = assessContentSanity({
      body: "Sign in to your account to continue reading this article.",
      title: "Login",
      extra_literals: [{ name: "auth_wall", substring: "sign in to your account" }],
    });
    expect(r.shouldQuarantine).toBe(true);
    expect(r.literal_substring_matches).toContain("auth_wall");
  });

  it("soft-blocks an oversize body (embed_skip, not hide)", () => {
    const big = "word ".repeat(DEFAULT_BYTES_BLOCK / 4); // > 500KB
    const r = assessContentSanity({ body: big, title: "Big Transcript" });
    expect(r.oversize).toBe(true);
    expect(r.shouldSkipEmbed).toBe(true);
    expect(r.shouldQuarantine).toBe(false);
    expect(r.flag_reason).toBe("oversized");
  });

  it("flags a markup-heavy page in the warn window (searchable)", () => {
    // Nav-blob shape: mostly links + pipes, little prose, sized into the window.
    const row = "| [link](https://example.com/x) | [more](https://example.com/y) |\n";
    const r = assessContentSanity({ body: row.repeat(1200), title: "Nav" });
    expect(r.bytes).toBeGreaterThan(50_000);
    expect(r.shouldQuarantine).toBe(false);
    expect(r.shouldSkipEmbed).toBe(false);
    expect(r.flag_reason).toBe("markup_heavy");
  });

  it("exempts code pages from the markup pass", () => {
    const row = "| [x](https://example.com/x) |\n";
    const r = assessContentSanity({
      body: row.repeat(2000),
      title: "code",
      page_kind: "code",
    });
    expect(r.markup_ratio).toBeNull();
    expect(r.shouldFlag).toBe(false);
  });
});

describe("stampSanityMarkers", () => {
  it("stamps quarantine + embed_skip for junk without mutating input", () => {
    const fm: Record<string, unknown> = { title: "x" };
    const r = assessContentSanity({ body: JUNK, title: "Attention Required!" });
    const out = stampSanityMarkers(fm, r);
    expect(isQuarantined(out)).toBe(true);
    expect(isEmbedSkipped(out)).toBe(true);
    expect(isQuarantined(fm)).toBe(false); // input untouched
  });

  it("stamps a {reason, detail} content_flag for oversize", () => {
    const big = "word ".repeat(DEFAULT_BYTES_BLOCK / 4);
    const r = assessContentSanity({ body: big, title: "Big" });
    const out = stampSanityMarkers({}, r);
    expect(isEmbedSkipped(out)).toBe(true);
    expect(isContentFlagged(out)).toBe(true);
    expect((out.content_flag as { reason: string }).reason).toBe("oversized");
  });

  it("leaves clean frontmatter unchanged", () => {
    const r = assessContentSanity({ body: CLEAN, title: "Quarterly Plan" });
    const out = stampSanityMarkers({ title: "Quarterly Plan" }, r);
    expect(out).toEqual({ title: "Quarterly Plan" });
  });
});

describe("ContentSanityBlockError", () => {
  it("carries the assessment and the junk code token", () => {
    const r = assessContentSanity({ body: JUNK, title: "Attention Required!" });
    const err = new ContentSanityBlockError(r);
    expect(err.result).toBe(r);
    expect(err.message).toContain("PAGE_JUNK_PATTERN");
  });
});

describe("indexDocument content-sanity wiring", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-sanity-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.MEMEX_SANITY_DISPOSITION;
    delete process.env.MEMEX_NO_SANITY;
  });

  async function frontmatterOf(sourcePath: string): Promise<Record<string, unknown>> {
    const r = await storage
      .engine()
      .query<{ frontmatter: Record<string, unknown> }>(
        "SELECT frontmatter FROM documents WHERE source_path = $1",
        [sourcePath],
      );
    return r.rows[0]?.frontmatter ?? {};
  }

  it("hides scraper junk (quarantine + embed_skip) by default", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/junk.md", text: JUNK },
      { embedFn, inferFrontmatter: false },
    );
    const fm = await frontmatterOf("/junk.md");
    expect(isQuarantined(fm)).toBe(true);
    expect(isEmbedSkipped(fm)).toBe(true);
  });

  it("throws on junk when disposition=reject", async () => {
    process.env.MEMEX_SANITY_DISPOSITION = "reject";
    await expect(
      indexDocument(
        storage,
        { sourcePath: "/junk2.md", text: JUNK },
        { embedFn, inferFrontmatter: false },
      ),
    ).rejects.toBeInstanceOf(ContentSanityBlockError);
  });

  it("indexes clean content with no markers", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/clean.md", text: CLEAN },
      { embedFn, inferFrontmatter: false },
    );
    const fm = await frontmatterOf("/clean.md");
    expect(isQuarantined(fm)).toBe(false);
    expect(isEmbedSkipped(fm)).toBe(false);
    expect(isContentFlagged(fm)).toBe(false);
  });

  it("kill switch MEMEX_NO_SANITY=1 skips the gate", async () => {
    process.env.MEMEX_NO_SANITY = "1";
    await indexDocument(
      storage,
      { sourcePath: "/junk3.md", text: JUNK },
      { embedFn, inferFrontmatter: false },
    );
    const fm = await frontmatterOf("/junk3.md");
    expect(isQuarantined(fm)).toBe(false);
  });
});
