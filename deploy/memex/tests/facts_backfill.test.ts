/**
 * Item 2 — conversation-facts backfill cycle phase. Default-OFF; when driven
 * with an injected fake Sonnet it extracts facts from prose pages that have no
 * facts-extract facts yet, and skips them once they do (idempotency without a
 * schema watermark).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  conversationFactsBackfillPhase,
  backfillEnabled,
} from "../src/core/cycle/conversation-facts-backfill.ts";
import { FACTS_EXTRACT_VERSION } from "../src/core/facts-extract.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

const LONG_BODY =
  "Met Alice today. She confirmed she prefers tea and is moving to Gotham " +
  "next month to lead the Acme rollout.";

function fakeSonnet(): SonnetFn {
  return async () => ({
    text: JSON.stringify({
      facts: [
        {
          fact: "prefers tea",
          kind: "preference",
          entity: "people/alice",
          confidence: 0.8,
          notability: "medium",
        },
      ],
    }),
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 100, outputTokens: 30 },
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-backfill-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("backfillEnabled", () => {
  it("is OFF by default", () => {
    expect(backfillEnabled(undefined)).toBe(false);
    expect(backfillEnabled("1")).toBe(true);
  });
});

describe("conversationFactsBackfillPhase", () => {
  it("is a no-op when disabled and no model is injected", async () => {
    const r = await conversationFactsBackfillPhase(storage);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("MEMEX_FACTS_BACKFILL");
  });

  it("backfills an eligible page then skips it on re-run", async () => {
    await putPage(storage, {
      slug: "notes/alice-sync",
      type: "note",
      markdown_body: LONG_BODY,
    });
    // An entity page must be ineligible (wrong type) — it should be ignored.
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      markdown_body: LONG_BODY,
    });

    const first = await conversationFactsBackfillPhase(storage, {
      sonnetFn: fakeSonnet(),
    });
    expect(first.ran).toBe(true);
    expect(first.pagesConsidered).toBe(1); // only the note, not the person page
    expect(first.pagesProcessed).toBe(1);
    expect(first.factsWritten).toBe(1);

    // Re-run: the note now has a facts-extract fact, so it is no longer considered.
    const second = await conversationFactsBackfillPhase(storage, {
      sonnetFn: fakeSonnet(),
    });
    expect(second.pagesConsidered).toBe(0);
    expect(second.factsWritten).toBe(0);
  });

  it("stops at the brain-wide page cap", async () => {
    for (let i = 0; i < 3; i++) {
      await putPage(storage, {
        slug: `notes/n${i}`,
        type: "note",
        markdown_body: LONG_BODY,
      });
    }
    const r = await conversationFactsBackfillPhase(storage, {
      sonnetFn: fakeSonnet(),
      maxPages: 2,
    });
    expect(r.pagesConsidered).toBe(2);
    expect(r.pagesProcessed).toBe(2);
  });
});

describe("zero-yield memo (facts_backfill_scans)", () => {
  function countingSonnet(text: () => string): { fn: SonnetFn; calls: () => number } {
    let n = 0;
    return {
      fn: async () => {
        n += 1;
        return {
          text: text(),
          modelId: "eu.anthropic.claude-sonnet-4-6",
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
      calls: () => n,
    };
  }
  const EMPTY = () => JSON.stringify({ facts: [] });

  async function scanRows(): Promise<{ source_id: string; slug: string; extractor_version: string }[]> {
    const r = await storage.engine().query<{ source_id: string; slug: string; extractor_version: string }>(
      "SELECT source_id, slug, extractor_version FROM facts_backfill_scans ORDER BY source_id, slug",
    );
    return r.rows;
  }

  it("memoizes a zero-yield page so the next run makes no model call", async () => {
    await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    const m = countingSonnet(EMPTY);

    const first = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
    expect(first.zeroYieldRecorded).toBe(1);
    expect(first.errors).toEqual([]);
    expect(await scanRows()).toEqual([
      { source_id: "default", slug: "notes/quiet", extractor_version: FACTS_EXTRACT_VERSION },
    ]);

    const second = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
    expect(second.pagesConsidered).toBe(0);
    expect(second.zeroYieldRecorded).toBe(0);
  });

  it("re-opens a memoized page once its body changes", async () => {
    await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    const m = countingSonnet(EMPTY);
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);

    await putPage(storage, {
      slug: "notes/quiet",
      type: "note",
      markdown_body: `${LONG_BODY} Later she also mentioned the Q3 budget review.`,
    });
    const third = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(2);
    expect(third.zeroYieldRecorded).toBe(1);
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(2);
  });

  it("never memoizes an unreadable answer, so it is retried", async () => {
    await putPage(storage, { slug: "notes/garbled", type: "note", markdown_body: LONG_BODY });
    const m = countingSonnet(() => "I could not find any structured facts here, sorry.");

    const first = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(first.zeroYieldRecorded).toBe(0);
    expect(first.errors.map((e) => e.message)).toEqual(["extraction absorbed: parse_failure"]);
    expect(await scanRows()).toEqual([]);

    const callsAfterFirst = m.calls();
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBeGreaterThan(callsAfterFirst);
  });

  it("a memo under another source does not suppress the page", async () => {
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      ["tenant_b", "__tenant_b__"],
    );
    const put = await putPage(storage, {
      slug: "notes/shared-name",
      type: "note",
      markdown_body: LONG_BODY,
      source_id: "tenant_b",
    });
    await storage.engine().query(
      `INSERT INTO facts_backfill_scans (source_id, slug, content_hash, extractor_version, outcome)
       VALUES ('default', 'notes/shared-name', $1, $2, 'zero_yield')`,
      [put.content_hash, FACTS_EXTRACT_VERSION],
    );
    const m = countingSonnet(EMPTY);
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
    expect(r.zeroYieldRecorded).toBe(1);
    expect((await scanRows()).map((row) => row.source_id)).toEqual(["default", "tenant_b"]);
  });

  it("writes no memo for a page that yields facts", async () => {
    await putPage(storage, { slug: "notes/alice-sync", type: "note", markdown_body: LONG_BODY });
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: fakeSonnet() });
    expect(r.factsWritten).toBe(1);
    expect(r.zeroYieldRecorded).toBe(0);
    expect(await scanRows()).toEqual([]);
  });

  it("a memo from another extractor version does not suppress the page", async () => {
    const put = await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    await storage.engine().query(
      `INSERT INTO facts_backfill_scans (source_id, slug, content_hash, extractor_version, outcome)
       VALUES ('default', 'notes/quiet', $1, '0', 'zero_yield')`,
      [put.content_hash],
    );
    const m = countingSonnet(EMPTY);
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
  });

  it("the migration is idempotent across a second init", async () => {
    await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    await conversationFactsBackfillPhase(storage, { sonnetFn: countingSonnet(EMPTY).fn });
    await storage.close();
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    expect((await scanRows()).length).toBe(1);
  });
});
