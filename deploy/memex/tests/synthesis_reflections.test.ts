/**
 * Reflections phase — hermetic (injected SonnetFn, no Bedrock). Covers the
 * flag gate, transcript → reflection-page write with evidence citation, the
 * sanitizeForPrompt `.text` unwrap regression guard, and the anti-loop
 * exclusion that keeps synthesis-written pages out of the facts-backfill
 * selector (paid synthetic recursion).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { reflectionsPhase } from "../src/core/synthesis/reflections.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 200, outputTokens: 80 },
  };
};

// A body long enough (>= 200 chars) to clear the transcript floor.
function transcriptBody(i: number): string {
  return (
    `Entry ${i}: spent the afternoon turning the deadline over in my head, ` +
    "weighing whether to ask for more time or push through the weekend. " +
    "Kept circling back to the same knot of anxiety about letting the team down."
  );
}

async function seedTranscripts(n: number): Promise<string[]> {
  const slugs: string[] = [];
  for (let i = 1; i <= n; i++) {
    const slug = `notes/journal-2026-06-0${i}`;
    await putPage(storage, {
      slug,
      type: "note",
      title: `Journal ${i}`,
      markdown_body: transcriptBody(i),
      source_id: "default",
    });
    slugs.push(slug);
  }
  return slugs;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-reflections-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_REFLECTIONS;
  delete process.env.MEMEX_REFLECTIONS_BUDGET_USD;
});

describe("reflectionsPhase", () => {
  it("is default-OFF without the flag and no injected sonnetFn", async () => {
    delete process.env.MEMEX_REFLECTIONS;
    await seedTranscripts(3);
    const r = await reflectionsPhase(storage, {});
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("MEMEX_REFLECTIONS");
  });

  it("writes a reflection page from structured output, citing transcripts", async () => {
    const slugs = await seedTranscripts(3);
    const payload = JSON.stringify([
      {
        topic_slug: "deadline-anxiety",
        title: "Recurring deadline anxiety",
        body: `The deadline keeps pulling my focus, see [[${slugs[0]}]].`,
        evidence: slugs,
      },
    ]);
    const r = await reflectionsPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.reflectionsWritten).toBe(1);

    // The prompt must carry the actual transcript prose — regression guard for
    // the sanitizeForPrompt `.text` unwrap (a bare object renders "[object Object]").
    expect(lastPrompt).toContain("deadline");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, "reflections/deadline-anxiety");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Recurring deadline anxiety");
    expect(page!.markdown_body).toContain(`[[${slugs[0]}]]`);
  });

  it("drops a reflection that cites no valid transcript slug", async () => {
    await seedTranscripts(3);
    const payload = JSON.stringify([
      {
        topic_slug: "phantom",
        title: "Phantom reflection",
        body: "cites nothing real",
        evidence: ["notes/does-not-exist"],
      },
    ]);
    const r = await reflectionsPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.reflectionsWritten).toBe(0);
    expect(await getPage(storage, "reflections/phantom")).toBeNull();
  });

  it("spends nothing when MEMEX_REFLECTIONS_BUDGET_USD=0 (no Sonnet call)", async () => {
    process.env.MEMEX_REFLECTIONS_BUDGET_USD = "0";
    await seedTranscripts(3);
    let calls = 0;
    const counting: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet("[]")(input);
    };
    const r = await reflectionsPhase(storage, { sonnetFn: counting });
    expect(calls).toBe(0);
    expect(r.ran).toBe(false);
    expect(r.budgetExhausted).toBe(true);
    expect(r.reflectionsWritten).toBe(0);
    expect(r.reason).toContain("budget");
  });
});

describe("anti-loop: synthesis pages excluded from facts-backfill", () => {
  it("does not consider reflections/ or patterns/ pages", async () => {
    // One real transcript (eligible) plus two synthesis-written pages that must
    // be skipped, so we never pay to re-derive our own output.
    await putPage(storage, {
      slug: "notes/real-transcript",
      type: "note",
      markdown_body: transcriptBody(1),
    });
    await putPage(storage, {
      slug: "reflections/deadline-anxiety",
      type: "note",
      markdown_body: transcriptBody(2),
      written_by: "reflection",
    });
    await putPage(storage, {
      slug: "patterns/deadline-anxiety",
      type: "note",
      markdown_body: transcriptBody(3),
      written_by: "patterns",
    });

    const noFacts: SonnetFn = async () => ({
      text: JSON.stringify({ facts: [] }),
      modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: noFacts });
    expect(r.ran).toBe(true);
    // Only the real transcript is eligible; the two synthesis pages are excluded.
    expect(r.pagesConsidered).toBe(1);
  });
});
