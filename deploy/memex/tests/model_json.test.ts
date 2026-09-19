/**
 * The shared decoder for structured model replies, and the gate that keeps
 * every structured parser on it.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseModelJson } from "../src/core/llm/json-output.ts";

describe("parseModelJson", () => {
  it("reads bare, fenced, prose-wrapped and trailing-junk replies", () => {
    expect(parseModelJson('{"a":1}', "{")).toEqual({ a: 1 });
    expect(parseModelJson('Here you go:\n```json\n{"a":1}\n```\nThanks', "{")).toEqual({ a: 1 });
    expect(parseModelJson('```JSON\n[1,2]\n```', "[")).toEqual([1, 2]);
    expect(parseModelJson('Sure. {"a":1} Hope that helps!', "{")).toEqual({ a: 1 });
    expect(parseModelJson("[1,2] is the list.", "[")).toEqual([1, 2]);
  });

  it("reads an unclosed fence and skips thinking", () => {
    expect(parseModelJson('```json\n{"a":1}', "{")).toEqual({ a: 1 });
    expect(parseModelJson('<thinking>maybe {"no":true}</thinking>{"a":2}', "{")).toEqual({ a: 2 });
  });

  it("falls back to the whole text when the fence holds something else", () => {
    expect(parseModelJson('```\nnot json\n```\n{"a":3}', "{")).toEqual({ a: 3 });
  });

  it("reads only what a strict caller was sent", () => {
    const outsideFence = '```\nnot json\n```\n{"verdict":"conversational"}';
    expect(parseModelJson(outsideFence, "{")).toEqual({ verdict: "conversational" });
    expect(parseModelJson(outsideFence, "{", { strict: true })).toBeUndefined();
    const afterThinking = '<thinking>{"verdict":"academic"}</thinking>{"verdict":"conversational"}';
    expect(parseModelJson(afterThinking, "{", { strict: true })).toBeUndefined();
  });

  it("returns undefined when nothing parses", () => {
    expect(parseModelJson("no json here", "{")).toBeUndefined();
    expect(parseModelJson('{"a":', "{")).toBeUndefined();
    expect(parseModelJson('{"a":1}', "[")).toBeUndefined();
  });

  it("stays linear on adversarial replies", () => {
    const time = (n: number) => {
      const s = `${"```".repeat(n)}${"{".repeat(n)}${"<thinking>".repeat(n)}`;
      const t = performance.now();
      parseModelJson(s, "{");
      return performance.now() - t;
    };
    time(1000);
    const small = Math.max(time(20_000), 0.5);
    const big = time(80_000);
    // Linear: 4x the input costs ~4x; quadratic would be ~16x.
    expect(big / small).toBeLessThan(10);
  });
});

/**
 * Every source file that parses a model's structured reply goes through the
 * shared decoder. The exempt files parse with a shape of their own, each for a
 * stated reason; the list may only shrink.
 */
const EXEMPT: Record<string, string> = {
  "core/facts-extract.ts": "its own candidate list, salvage of truncated arrays and a malformed-status contract",
  "core/facts-classify.ts": "bounded verdict-object regex fallback for a one-object reply",
  "core/synthesis/reflections.ts": "bounded array regex tuned to the reflections token cap",
  "core/search/graph-rerank.ts": "takes the FIRST bracketed span, not the last, by design",
  "core/synthesis/atoms.ts": "isWellFormedEmptyExtraction keeps an exact-[] rule stricter than the decoder",
  "core/synthesis/takes.ts": "isWellFormedEmptyExtraction keeps an exact-[] rule stricter than the decoder",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("structured parsers", () => {
  it("use the shared decoder", () => {
    const src = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const file of walk(src)) {
      const rel = file.slice(src.length + 1);
      if (rel === "core/llm/json-output.ts" || EXEMPT[rel]) continue;
      const text = readFileSync(file, "utf8");
      // A model-reply parser: slices JSON out of text by a fence, a greedy
      // bracket regex, or an opener index, and hands it to JSON.parse.
      const fence = /```\(\?:json\)|```json/.test(text);
      const greedy = /\[\\s\\S\]\*/.test(text);
      const opener = /indexOf\(["'][{[]["']\)/.test(text);
      if ((fence || greedy || opener) && /JSON\.parse\(/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
