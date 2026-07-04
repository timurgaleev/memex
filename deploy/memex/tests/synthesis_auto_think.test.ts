/**
 * Auto-think phase — hermetic (injected SonnetFn + pagesFn, no Bedrock). Covers
 * the flag gate, the no-questions skip, a think-answer → draft-page write, and
 * the [object Object] regression guard on the forwarded think prompt.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage } from "../src/core/pages.ts";
import { autoThinkPhase } from "../src/core/synthesis/auto-think.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 300, outputTokens: 90 },
  };
};

const fakePages = (content: string): ((q: string, k: number) => Promise<SearchHit[]>) =>
  async () => [
    {
      chunkId: "c1",
      documentId: "d1",
      sourcePath: "notes/roadmap.md",
      title: "Roadmap",
      content,
      score: 1,
      intent: "other",
    } as unknown as SearchHit,
  ];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-autothink-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_AUTO_THINK;
  delete process.env.MEMEX_AUTO_THINK_QUESTIONS;
});

describe("autoThinkPhase", () => {
  it("is default-OFF without the flag and no injected sonnetFn", async () => {
    delete process.env.MEMEX_AUTO_THINK;
    const r = await autoThinkPhase(storage, { questions: ["What is unresolved?"] });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("MEMEX_AUTO_THINK");
  });

  it("skips when no questions are configured", async () => {
    const r = await autoThinkPhase(storage, { sonnetFn: fakeSonnet("{}"), questions: [] });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("no questions");
  });

  it("runs a question and persists the answer as a draft page", async () => {
    const answer = JSON.stringify({ answer: "The roadmap defers auth to Q3.", citations: [], gaps: ["No dated milestone"] });
    const r = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet(answer),
      pagesFn: fakePages("Auth is planned but not yet scheduled on the roadmap."),
      embedFn: null,
      questions: ["What is the status of auth?"],
      cooldownHours: 0,
    });
    expect(r.ran).toBe(true);
    expect(r.draftsWritten).toBe(1);

    // The think prompt forwarded to Sonnet must carry the retrieved page content.
    expect(lastPrompt).toContain("Auth is planned");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, "drafts/think/what-is-the-status-of-auth");
    expect(page).not.toBeNull();
    expect(page!.type).toBe("draft");
    expect(page!.markdown_body).toContain("defers auth to Q3");
    expect(page!.markdown_body).toContain("What is the status of auth?");
  });

  it("does not persist an empty synthesis", async () => {
    const r = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet("not json at all"),
      pagesFn: fakePages("some context"),
      embedFn: null,
      questions: ["A question with no answer"],
      cooldownHours: 0,
    });
    expect(r.draftsWritten).toBe(0);
    expect(await getPage(storage, "drafts/think/a-question-with-no-answer")).toBeNull();
  });

  it("respects the cooldown once a draft exists", async () => {
    const answer = JSON.stringify({ answer: "First pass.", citations: [], gaps: [] });
    const first = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet(answer),
      pagesFn: fakePages("ctx"),
      embedFn: null,
      questions: ["Standing question"],
      cooldownHours: 0,
    });
    expect(first.draftsWritten).toBe(1);

    const second = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet(answer),
      pagesFn: fakePages("ctx"),
      embedFn: null,
      questions: ["Standing question"],
      cooldownHours: 24,
    });
    expect(second.ran).toBe(false);
    expect(second.reason).toContain("cooldown");
  });
});
