/**
 * Ingest-time frontmatter inference (the reference's per-file pure step, now in
 * memex's indexer instead of a recurring cycle phase). Verify skip-on-existing,
 * title/date derivation, the prepend, and that indexDocument carries it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inferFrontmatter,
  applyInference,
  extractDateFromFilename,
  extractTitleFromFilename,
} from "../src/core/frontmatter-inference.ts";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

describe("inferFrontmatter (pure)", () => {
  it("skips content that already has a frontmatter header", () => {
    const r = inferFrontmatter("notes/x.md", "---\ntitle: X\n---\nbody");
    expect(r.skipped).toBe(true);
  });

  it("derives title from the first H1, else the filename; type defaults to note", () => {
    expect(inferFrontmatter("notes/random.md", "# Real Title\n\nbody").title).toBe("Real Title");
    expect(inferFrontmatter("notes/my-note.md", "no heading here").title).toBe("My Note");
    expect(inferFrontmatter("notes/x.md", "body").type).toBe("note");
  });

  it("extracts a YYYY-MM-DD date from the filename", () => {
    expect(extractDateFromFilename("2026-03-20 Meeting.md")).toBe("2026-03-20");
    expect(extractTitleFromFilename("2026-03-20 Community Day.md")).toBe("Community Day");
  });

  it("applyInference prepends a header to headerless content", () => {
    const { content, inferred } = applyInference("notes/a.md", "# Hi\n\nbody");
    expect(inferred.skipped).toBeFalsy();
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("title: Hi");
    expect(content).toContain("body");
  });
});

describe("indexDocument carries inferred frontmatter", () => {
  let tmp: string;
  let storage: Storage;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-fminfer-ingest-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a headerless doc gets a title in documents.title at ingest", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/notes/headerless.md", text: "# Inferred Title\n\nbody one\n\nbody two" },
      { embedFn: detEmbed },
    );
    const r = await storage.engine().query<{ t: string | null }>(
      "SELECT title AS t FROM documents WHERE source_path = $1",
      ["/notes/headerless.md"],
    );
    expect(r.rows[0]?.t).toBe("Inferred Title");
  });

  it("inferFrontmatter:false leaves headerless content alone", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/notes/raw.md", text: "plain body no heading" },
      { embedFn: detEmbed, inferFrontmatter: false },
    );
    // no throw; doc indexed without an inferred header
    const r = await storage.engine().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM documents WHERE source_path = $1",
      ["/notes/raw.md"],
    );
    expect(r.rows[0]?.n).toBe(1);
  });
});
