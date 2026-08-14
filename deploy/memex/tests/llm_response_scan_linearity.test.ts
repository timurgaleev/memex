/**
 * The scans that read a model's reply must stay linear in the reply's length.
 *
 * Every function here is handed raw LLM output. We do not write that text, we
 * only cap the request's `maxTokens` — so a model that streams a long run of
 * one character is enough to trigger the worst case, and a provider swap or a
 * `maxTokens` bump moves the cap without anyone touching these parsers.
 *
 * Three shapes were quadratic before the bound:
 *
 *  - `` ```(?:json)?\s*([\s\S]*?)``` `` — `\s*` had n ways to split a run of
 *    whitespace and the lazy body walked to the end of the reply for each one.
 *    Measured through parseAtomsResponse on `"```" + "\n"*n + "x"`: 2 K =
 *    1.2 ms, 4 K = 3.9 ms, 8 K = 15.8 ms, 16 K = 61 ms — ratio ~4.0 per
 *    doubling, extrapolating to about four minutes at 1 MB. `\s*` was redundant
 *    (the capture is trimmed on the next line), so dropping it costs nothing.
 *
 *  - `/\{[\s\S]*\}/` and `/\[[\s\S]*\]/` — with no closing delimiter the body
 *    walked to the end from every opener. 2 K = 1.5 ms to 16 K = 92.8 ms for
 *    the brace form, ratio ~4.0. Both mean "first opener to last closer", which
 *    is `indexOf` + `lastIndexOf`, one forward scan and one backward scan.
 *
 * The ceilings below are deliberately loose. Linear runs these inputs in
 * milliseconds; quadratic needs minutes. Anything in between is a real
 * regression, and a slow CI box cannot manufacture a 1000x miss.
 */
import { describe, expect, it } from "bun:test";
import { parseAtomsResponse, isWellFormedEmptyExtraction } from "../src/core/synthesis/atoms";
import { parseWorthVerdict } from "../src/core/synthesis/worth-gate";

const CEILING_MS = 15_000;
const BIG = 1_000_000;

describe("atoms fence scan cost", () => {
  it("stays linear on a 1 MB whitespace run behind an unclosed fence", () => {
    // The trailing `x` matters: without it `raw.trim()` deletes the run and the
    // scan never sees the input under test.
    const raw = "```" + "\n".repeat(BIG) + "x";

    const started = performance.now();
    const atoms = parseAtomsResponse(raw);
    const elapsed = performance.now() - started;

    expect(atoms).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear in the empty-extraction check on the same input", () => {
    const raw = "```" + "\n".repeat(BIG) + "x";

    const started = performance.now();
    const wellFormed = isWellFormedEmptyExtraction(raw);
    const elapsed = performance.now() - started;

    // Not a clean `[]`, so it must stay retryable rather than tombstone the doc.
    expect(wellFormed).toBe(false);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still reads a fenced array, with or without the language tag and padding", () => {
    expect(parseAtomsResponse('```json\n[{"title":"T","atom_type":"insight","body":"a thing happened","concepts":["x"]}]\n```')).toHaveLength(1);
    expect(parseAtomsResponse('```\n[{"title":"T","atom_type":"insight","body":"a thing happened","concepts":["x"]}]\n```')).toHaveLength(1);
    expect(parseAtomsResponse('```json   [{"title":"T","atom_type":"insight","body":"a thing happened","concepts":["x"]}]   ```')).toHaveLength(1);
    expect(parseAtomsResponse('[{"title":"T","atom_type":"insight","body":"a thing happened","concepts":["x"]}]')).toHaveLength(1);
  });

  it("still tells a clean empty array from prose that merely contains one", () => {
    expect(isWellFormedEmptyExtraction("```json\n[]\n```")).toBe(true);
    expect(isWellFormedEmptyExtraction("```\n\n\n[]\n\n\n```")).toBe(true);
    expect(isWellFormedEmptyExtraction("[]")).toBe(true);
    expect(isWellFormedEmptyExtraction("Unable to parse the source; returning fallback []")).toBe(false);
  });
});

describe("worth-gate verdict scan cost", () => {
  it("stays linear on a 1 MB run of unclosed braces", () => {
    const raw = "{".repeat(BIG);

    const started = performance.now();
    const verdict = parseWorthVerdict(raw);
    const elapsed = performance.now() - started;

    expect(verdict).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still takes the first brace to the last, prose on both sides", () => {
    expect(parseWorthVerdict('{"worth_processing":true,"reasons":["a"]}')).toEqual({
      worth_processing: true,
      reasons: ["a"],
    });
    expect(
      parseWorthVerdict('Here is my answer:\n{"worth_processing":false,"reasons":["b"]}\nHope that helps.'),
    ).toEqual({ worth_processing: false, reasons: ["b"] });
    // Nested braces: the span has to run to the LAST `}`, not the first.
    expect(parseWorthVerdict('{"worth_processing":true,"reasons":[],"meta":{"k":1}}')).toEqual({
      worth_processing: true,
      reasons: [],
    });
    expect(parseWorthVerdict("no json here")).toBeNull();
    expect(parseWorthVerdict("{")).toBeNull();
    expect(parseWorthVerdict("}{")).toBeNull();
  });
});
