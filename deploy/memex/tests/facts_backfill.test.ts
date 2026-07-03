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
