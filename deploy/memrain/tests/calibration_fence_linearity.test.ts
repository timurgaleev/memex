/**
 * Stripping the ``` fence off a bias-tags reply must stay linear.
 *
 * An opener followed by a long whitespace run and no closing fence is the
 * adversarial shape for the old spelling, ``` /```(?:json)?\s*([\s\S]*?)```/ ```:
 * `[\s\S]*?` accepts whitespace too, so every length of the `\s*` re-walked the
 * rest of the text hunting for a closer that is not there. Measured through
 * `parseBiasTags` at 256 ms for 32 K chars, 1.03 s for 64 K, 3.96 s for 128 K
 * and 15.5 s for 256 K — squaring cleanly.
 *
 * The live caller caps the reply at `maxTokens: 120`, so in production this was
 * a sub-millisecond parse. That cap lives at a call site, though, and this
 * parser is exported, so the cost is fixed here rather than left resting on a
 * caller's argument.
 *
 * The fix deletes the `\s*`, which the lazy body already subsumes: the accepted
 * language is unchanged and the leading whitespace it used to keep out of the
 * capture is removed by the `.trim()` that follows. The last case pins that
 * down.
 *
 * The ceiling is deliberately loose. Linear runs this in well under a second;
 * quadratic needs minutes.
 */
import { describe, expect, it } from "bun:test";
import { parseBiasTags } from "../src/core/synthesis/calibration.ts";

const CEILING_MS = 15_000;

describe("bias-tags fence strip cost", () => {
  it("stays linear on a 1 MB whitespace run behind an unclosed fence", () => {
    const text = "```" + " ".repeat(1_000_000) + "x";

    const started = performance.now();
    const tags = parseBiasTags(text);
    const elapsed = performance.now() - started;

    // No closing fence and no array: the parse really ran and found nothing.
    expect(tags).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear on a 1 MB newline run behind an unclosed fence", () => {
    const text = "```json" + "\n".repeat(1_000_000) + "x";

    const started = performance.now();
    const tags = parseBiasTags(text);
    const elapsed = performance.now() - started;

    expect(tags).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still unwraps every fence spelling and keeps the kebab-case gate", () => {
    const expected = ["over-confident-macro", "late-on-hiring"];
    expect(parseBiasTags('```json\n["over-confident-macro","BAD TAG","late-on-hiring"]\n```'))
      .toEqual(expected);
    expect(parseBiasTags('```\n["over-confident-macro","late-on-hiring"]\n```'))
      .toEqual(expected);
    expect(parseBiasTags('```json["over-confident-macro","late-on-hiring"]```'))
      .toEqual(expected);
    expect(parseBiasTags('```   \n\n ["over-confident-macro","late-on-hiring"] \n```'))
      .toEqual(expected);
    // Unfenced payloads and junk behave as before.
    expect(parseBiasTags('["over-confident-macro","late-on-hiring"]')).toEqual(expected);
    expect(parseBiasTags("no tags here")).toEqual([]);
    expect(parseBiasTags("")).toEqual([]);
  });
});
