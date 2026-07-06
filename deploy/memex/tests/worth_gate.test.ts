/**
 * G37 worth gate — cached Haiku significance verdicts before the Sonnet spend.
 * Hermetic: injected LlmFn / SonnetFn, no Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  filterWorthwhile,
  parseWorthVerdict,
  worthGateEnabled,
} from "../src/core/synthesis/worth-gate.ts";
import { reflectionsPhase } from "../src/core/synthesis/reflections.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import { putPage } from "../src/core/pages.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-worth-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const countingLlm = (text: string): { fn: LlmFn; calls: () => number } => {
  let n = 0;
  const fn: LlmFn = async () => {
    n += 1;
    return { text, modelId: "fake-haiku" };
  };
  return { fn, calls: () => n };
};

const WORTHY = `{"worth_processing": true, "reasons": ["new idea"]}`;
const UNWORTHY = `{"worth_processing": false, "reasons": ["routine ops"]}`;

describe("parseWorthVerdict / gate flag", () => {
  it("parses verdicts and rejects malformed output", () => {
    expect(parseWorthVerdict(WORTHY)?.worth_processing).toBe(true);
    expect(parseWorthVerdict(UNWORTHY)?.reasons).toEqual(["routine ops"]);
    expect(parseWorthVerdict("prose")).toBeNull();
    expect(parseWorthVerdict(`{"worth_processing":"yes"}`)).toBeNull();
  });
  it("is default-OFF", () => {
    expect(worthGateEnabled(undefined)).toBe(false);
    expect(worthGateEnabled("")).toBe(false);
    expect(worthGateEnabled("1")).toBe(true);
  });
});

describe("filterWorthwhile", () => {
  it("keeps worthy items, skips unworthy, and caches both", async () => {
    const judge: LlmFn = async (input) => ({
      text: input.user.includes("gold") ? WORTHY : UNWORTHY,
      modelId: "fake-haiku",
    });
    const items = [
      { ref: "notes/gold", content: "gold idea content" },
      { ref: "notes/noise", content: "noise content" },
    ];
    const r1 = await filterWorthwhile(engine, items, { llmFn: judge });
    expect(r1.kept.has("notes/gold")).toBe(true);
    expect(r1.kept.has("notes/noise")).toBe(false);
    expect(r1.judged).toBe(2);
    expect(r1.skipped).toBe(1);

    // Second pass: pure cache, no LLM calls.
    const counting = countingLlm(WORTHY);
    const r2 = await filterWorthwhile(engine, items, { llmFn: counting.fn });
    expect(counting.calls()).toBe(0);
    expect(r2.cacheHits).toBe(2);
    expect(r2.kept.has("notes/gold")).toBe(true);
    expect(r2.skipped).toBe(1);
  });

  it("re-judges when the content hash changes", async () => {
    const counting = countingLlm(WORTHY);
    await filterWorthwhile(engine, [{ ref: "r", content: "v1" }], { llmFn: counting.fn });
    await filterWorthwhile(engine, [{ ref: "r", content: "v2 changed" }], { llmFn: counting.fn });
    expect(counting.calls()).toBe(2);
  });

  it("fails open: an unjudgeable item passes and is not cached", async () => {
    const boom: LlmFn = async () => {
      throw new Error("haiku down");
    };
    const r = await filterWorthwhile(engine, [{ ref: "x", content: "y" }], { llmFn: boom });
    expect(r.kept.has("x")).toBe(true);
    expect(r.errors.length).toBe(1);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_worth_verdicts`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe("worth gate in front of the Sonnet consumers", () => {
  const neverSonnet = (): { fn: SonnetFn; calls: () => number } => {
    let n = 0;
    const fn: SonnetFn = async () => {
      n += 1;
      return {
        text: "[]",
        modelId: "eu.anthropic.claude-sonnet-4-6",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };
    return { fn, calls: () => n };
  };

  it("reflections: screens out unworthy transcripts before the Sonnet call", async () => {
    await putPage(storage, {
      slug: "notes/daily-ops",
      type: "note",
      title: "ops",
      markdown_body: "routine standup notes, check email, schedule things. ".repeat(10),
    });
    const s = neverSonnet();
    const gate = countingLlm(UNWORTHY);
    const r = await reflectionsPhase(storage, {
      sonnetFn: s.fn,
      worthGate: true,
      worthLlmFn: gate.fn,
    });
    expect(r.worthSkipped).toBe(1);
    expect(r.reason).toContain("worth gate");
    expect(s.calls()).toBe(0); // the Sonnet spend never happened
  });

  it("backfill: unworthy pages are skipped and counted", async () => {
    await putPage(storage, {
      slug: "notes/ops-log",
      type: "note",
      title: "ops log",
      markdown_body: "routine ops chatter with plenty of text to clear the length gate. ".repeat(5),
    });
    const s = neverSonnet();
    const gate = countingLlm(UNWORTHY);
    const r = await conversationFactsBackfillPhase(storage, {
      sonnetFn: s.fn,
      worthGate: true,
      worthLlmFn: gate.fn,
    });
    expect(r.ran).toBe(true);
    expect(r.worthSkipped).toBe(1);
    expect(r.pagesProcessed).toBe(0);
    expect(s.calls()).toBe(0);
  });
});
