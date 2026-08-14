/**
 * The take, verdict, judgment and rerank parsers must stay linear in the
 * length of the model reply they are handed.
 *
 * None of this text is ours. We cap the request's `maxTokens` and nothing else,
 * so a model that emits a long run of one character — the ordinary shape of a
 * truncated or degenerate reply — is enough to hit the worst case, and a
 * provider swap or a `maxTokens` bump moves that cap without anyone touching
 * these functions.
 *
 * Two shapes were quadratic before the fix:
 *
 *  - `` ```(?:json)?\s*([\s\S]*?)``` `` — the greedy whitespace run and the
 *    lazy body split the same characters n+1 ways, so an opener whose closing
 *    fence never arrives re-walks the tail once per split. Measured through
 *    `parseTakesResponse` on `"```" + "\n" x n + "x"`: 0.9 ms at 2 K, 3.7 ms at
 *    4 K, 14.7 ms at 8 K, 59.7 ms at 16 K — 4.0x per doubling, which is minutes
 *    at a megabyte. The other three parsers measured the same. `\s*` was
 *    redundant (every caller trims the capture on the next line), so it came
 *    out and the sites now read 0.7 ms at 1 MB.
 *
 *  - `/\[[\s\S]*?\]/` in `parseRerankOrder` — with no `]` in the reply the lazy
 *    body walked to the end from every `[`: 1.2 ms at 2 K to 75.3 ms at 16 K,
 *    a 62x rise across an 8x input. It means "first `[` to the first `]` after
 *    it", which is two `indexOf` calls.
 *
 * The ceiling below is deliberately loose. Linear runs a megabyte in under a
 * millisecond; quadratic needs minutes. Anything in between is a real
 * regression, and a slow CI box cannot manufacture a 10000x miss.
 */
import { describe, expect, it } from "bun:test";
import {
  parseTakesResponse,
  parseVerdictResponse,
  isWellFormedEmptyExtraction,
} from "../src/core/synthesis/takes.ts";
import { parseJudgment } from "../src/core/synthesis/contradictions.ts";
import { parseVoiceJudgeOutput } from "../src/core/synthesis/voice-gate.ts";
import { parseRerankOrder } from "../src/core/search/graph-rerank.ts";

const CEILING_MS = 15_000;
const BIG = 1_000_000;

/** The trailing `x` is load-bearing: without it `raw.trim()` deletes the run
 *  and the scan under test never sees the input. */
const UNCLOSED_FENCE = "```" + "\n".repeat(BIG) + "x";

function timed<T>(fn: () => T): [T, number] {
  const started = performance.now();
  const out = fn();
  return [out, performance.now() - started];
}

describe("fenced-reply scan cost", () => {
  it("parseTakesResponse stays linear on a 1 MB unclosed fence", () => {
    const [takes, elapsed] = timed(() => parseTakesResponse(UNCLOSED_FENCE));
    expect(takes).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("isWellFormedEmptyExtraction stays linear on the same reply", () => {
    const [wellFormed, elapsed] = timed(() => isWellFormedEmptyExtraction(UNCLOSED_FENCE));
    // Not a clean `[]`, so the extraction must stay retryable.
    expect(wellFormed).toBe(false);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("parseVerdictResponse stays linear on the same reply", () => {
    const [verdict, elapsed] = timed(() => parseVerdictResponse(UNCLOSED_FENCE));
    expect(verdict).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("parseJudgment stays linear on the same reply", () => {
    const [judgment, elapsed] = timed(() => parseJudgment(UNCLOSED_FENCE));
    expect(judgment).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("parseVoiceJudgeOutput stays linear on the same reply", () => {
    const [verdict, elapsed] = timed(() => parseVoiceJudgeOutput(UNCLOSED_FENCE));
    // An unparseable judge reply falls back to the template, never to a pass.
    expect(verdict.verdict).toBe("academic");
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("parseRerankOrder stays linear on the same reply", () => {
    const [order, elapsed] = timed(() => parseRerankOrder(UNCLOSED_FENCE, 10));
    expect(order).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });
});

describe("fenced-reply scan correctness", () => {
  const TAKE =
    '{"claim_text":"rates fall by Q3","kind":"prediction","weight":0.6,"domain":"macro"}';

  it("still reads a fenced array with or without the tag, padding, or fence", () => {
    expect(parseTakesResponse(`\`\`\`json\n[${TAKE}]\n\`\`\``)).toHaveLength(1);
    expect(parseTakesResponse(`\`\`\`\n[${TAKE}]\n\`\`\``)).toHaveLength(1);
    expect(parseTakesResponse(`\`\`\`json   [${TAKE}]   \`\`\``)).toHaveLength(1);
    expect(parseTakesResponse(`[${TAKE}]`)).toHaveLength(1);
  });

  it("still tells a clean empty array from prose that merely contains one", () => {
    expect(isWellFormedEmptyExtraction("```json\n[]\n```")).toBe(true);
    expect(isWellFormedEmptyExtraction("```\n\n\n[]\n\n\n```")).toBe(true);
    expect(isWellFormedEmptyExtraction("[]")).toBe(true);
    expect(isWellFormedEmptyExtraction("Unable to parse the source; returning fallback []")).toBe(
      false,
    );
  });

  it("still reads a fenced verdict object, padded or bare", () => {
    const body = '{"verdict":"correct","confidence":0.9,"reasoning":"it happened"}';
    expect(parseVerdictResponse(`\`\`\`json\n${body}\n\`\`\``)?.verdict).toBe("correct");
    expect(parseVerdictResponse(`\`\`\`   \n\n${body}\n \`\`\``)?.verdict).toBe("correct");
    expect(parseVerdictResponse(body)?.verdict).toBe("correct");
  });
});

describe("rerank bracket-span scan", () => {
  it("stays linear on a 1 MB run of unclosed brackets", () => {
    const [order, elapsed] = timed(() => parseRerankOrder("[".repeat(BIG), 10));
    expect(order).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still takes the first `[` to the first `]` after it", () => {
    expect(parseRerankOrder("[2,0,1]", 3)).toEqual([2, 0, 1]);
    expect(parseRerankOrder("Ranked: [2,0,1]. Hope that helps.", 3)).toEqual([2, 0, 1]);
    expect(parseRerankOrder("```json\n[1,0]\n```", 2)).toEqual([1, 0]);
    // Leading `]` characters cannot start a span, and the first `[` still wins.
    expect(parseRerankOrder("]] [0,1] [9]", 2)).toEqual([0, 1]);
    // The span stops at the FIRST `]`, so a nested array is not swallowed.
    expect(parseRerankOrder("[[0,1]]", 2)).toEqual([]);
    expect(parseRerankOrder("[0,1", 2)).toEqual([]);
    expect(parseRerankOrder("no array here", 2)).toEqual([]);
  });
});
