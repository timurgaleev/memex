/**
 * Fenced-code extraction: ```lang fences in a markdown page are chunked by the
 * code chunker and persisted with chunk_source='fenced_code'; unsupported-tag
 * fences stay as prose.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFencedCode } from "../src/core/chunkers/fenced-code.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { Storage } from "../src/core/storage.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = (t: string) => Promise.resolve(deterministicEmbed(t));

describe("extractFencedCode", () => {
  it("extracts supported-language fences and skips the rest", () => {
    const md = [
      "# Doc",
      "",
      "```typescript",
      "export function alpha() { return 1; }",
      "```",
      "",
      "```ruby",
      "def foo; end",
      "```",
      "",
      "```",
      "no info string",
      "```",
    ].join("\n");
    const blocks = extractFencedCode(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lang).toBe("typescript");
    expect(blocks[0]?.source).toContain("alpha");
  });

  it("respects MEMEX_MAX_FENCES_PER_PAGE", () => {
    const prev = process.env.MEMEX_MAX_FENCES_PER_PAGE;
    process.env.MEMEX_MAX_FENCES_PER_PAGE = "1";
    try {
      const md = "```ts\nconst a=1;\n```\n\n```ts\nconst b=2;\n```";
      expect(extractFencedCode(md)).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.MEMEX_MAX_FENCES_PER_PAGE;
      else process.env.MEMEX_MAX_FENCES_PER_PAGE = prev;
    }
  });
});

describe("indexDocument fenced-code chunks", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-fenced-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  afterAll(() => _resetParsersForTests());

  it("persists a fenced_code chunk for a supported fence", async () => {
    const body = [
      "# How to import",
      "",
      "Use the engine like so:",
      "",
      "```typescript",
      "export function loadEngine() { return makeEngine(); }",
      "```",
    ].join("\n");
    await indexDocument(
      storage,
      { sourcePath: "/howto.md", text: body },
      { embedFn, inferFrontmatter: false },
    );
    const r = await storage.engine().query<{
      chunk_source: string | null;
      language: string | null;
      symbol_name: string | null;
    }>(
      `SELECT c.chunk_source, c.language, c.symbol_name FROM chunks c
         JOIN documents d ON c.document_id = d.id
        WHERE d.source_path = $1 AND c.chunk_source = 'fenced_code'`,
      ["/howto.md"],
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
    expect(r.rows[0]?.language).toBe("typescript");
    expect(r.rows.some((x) => x.symbol_name === "loadEngine")).toBe(true);
  });

  it("does not create fenced chunks for an unsupported-tag fence", async () => {
    const body = "# Doc\n\n```ruby\ndef foo; end\n```\n";
    await indexDocument(
      storage,
      { sourcePath: "/ruby.md", text: body },
      { embedFn, inferFrontmatter: false },
    );
    const r = await storage.engine().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunks c
         JOIN documents d ON c.document_id = d.id
        WHERE d.source_path = $1 AND c.chunk_source = 'fenced_code'`,
      ["/ruby.md"],
    );
    expect(r.rows[0]?.n).toBe(0);
  });
});
