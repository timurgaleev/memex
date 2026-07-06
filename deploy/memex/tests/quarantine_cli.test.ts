/**
 * `memex quarantine list|clear|scan` — operator surface over the
 * content-sanity markers. Seeds a clean doc + a scraper-junk doc that
 * predates the gate, then: scan dry-run counts it, scan --apply stamps it
 * (and drops its embeddings), list shows it, clear refuses while still junk,
 * clear --force releases it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuarantine } from "../src/commands/quarantine.ts";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { deterministicEmbed } from "./det-embed.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-quarantine-test-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => (console.log = orig) };
}

beforeAll(async () => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  const storage = new Storage({ dbPath: join(cfgDir, "brain.pglite") });
  await storage.init();
  try {
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_clean",
        sourcePath: "notes/clean.md",
        title: "Clean note",
        frontmatter: {},
        embeddingModel: "det",
      },
      [
        {
          text: "a perfectly normal note about gardening",
          entities: [],
          embedding: deterministicEmbed("a perfectly normal note about gardening"),
        },
      ],
    );
    // Scraper junk indexed BEFORE the gate existed — carries an embedding.
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_junk",
        sourcePath: "notes/junk.md",
        title: "Some scraped page",
        frontmatter: {},
        embeddingModel: "det",
      },
      [
        {
          text: "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d",
          entities: [],
          embedding: deterministicEmbed("cloudflare interstitial"),
        },
      ],
    );
  } finally {
    await storage.close();
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function junkState(): Promise<{ fm: Record<string, unknown>; embeddings: number }> {
  const storage = new Storage({ dbPath: join(cfgDir, "brain.pglite") });
  await storage.init();
  try {
    const d = await storage
      .engine()
      .query<{ frontmatter: Record<string, unknown> }>(
        "SELECT frontmatter FROM documents WHERE id = 'doc_junk'",
      );
    const e = await storage
      .engine()
      .query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM embeddings WHERE chunk_id LIKE 'doc_junk%'",
      );
    return { fm: d.rows[0]!.frontmatter, embeddings: e.rows[0]!.n };
  } finally {
    await storage.close();
  }
}

describe("memex quarantine", () => {
  it("scan dry-run counts the pre-gate junk without stamping", async () => {
    const cap = capture();
    let code: number;
    try {
      code = await runQuarantine({ sub: "scan", json: true, configPath: cfgPath });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const out = JSON.parse(cap.lines.join("\n"));
    expect(out.applied).toBe(false);
    expect(out.quarantined).toBe(1);
    const s = await junkState();
    expect("quarantine" in s.fm).toBe(false);
    expect(s.embeddings).toBe(1);
  });

  it("scan --apply stamps markers and drops the junk doc's embeddings", async () => {
    const code = await runQuarantine({
      sub: "scan",
      apply: true,
      json: true,
      configPath: cfgPath,
    });
    expect(code).toBe(0);
    const s = await junkState();
    expect("quarantine" in s.fm).toBe(true);
    expect("embed_skip" in s.fm).toBe(true);
    expect(s.embeddings).toBe(0);
  });

  it("list shows the quarantined doc", async () => {
    const cap = capture();
    try {
      await runQuarantine({ sub: "list", json: true, configPath: cfgPath });
    } finally {
      cap.restore();
    }
    const out = JSON.parse(cap.lines.join("\n"));
    expect(out.count).toBe(1);
    expect(out.rows[0].source_path).toBe("notes/junk.md");
    expect(out.rows[0].marker).toBe("quarantine");
  });

  it("clear refuses while the content still assesses as junk", async () => {
    const code = await runQuarantine({
      sub: "clear",
      target: "notes/junk.md",
      configPath: cfgPath,
    });
    expect(code).toBe(1);
    const s = await junkState();
    expect("quarantine" in s.fm).toBe(true);
  });

  it("clear --force drops the markers", async () => {
    const code = await runQuarantine({
      sub: "clear",
      target: "notes/junk.md",
      force: true,
      json: true,
      configPath: cfgPath,
    });
    expect(code).toBe(0);
    const s = await junkState();
    expect("quarantine" in s.fm).toBe(false);
    expect("embed_skip" in s.fm).toBe(false);
    expect("content_flag" in s.fm).toBe(false);
  });
});
