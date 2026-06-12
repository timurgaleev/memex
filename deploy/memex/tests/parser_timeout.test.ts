/**
 * Tree-sitter per-parse wall-clock budget (#8 code-chunk safety).
 *
 * `resolveParseTimeoutMs` config logic (pure) + `parseWithBudget`, which runs
 * a parse under a wall-clock budget via tree-sitter's progressCallback so a
 * pathological file can't hang the WASM parser indefinitely (the parse is
 * cancelled → returns null → chunkCode throws → sweep-code skips the file).
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  _resetParsersForTests,
  getParser,
  ParseTimeoutError,
  parseWithBudget,
  resolveParseTimeoutMs,
} from "../src/core/chunkers/parsers.ts";
import { chunkCode } from "../src/core/chunkers/code.ts";

afterAll(() => {
  delete process.env.MEMEX_PARSE_TIMEOUT_MS;
  _resetParsersForTests();
});

describe("resolveParseTimeoutMs", () => {
  it("defaults to 5000ms", () => {
    expect(resolveParseTimeoutMs(undefined)).toBe(5000);
    expect(resolveParseTimeoutMs("")).toBe(5000);
  });

  it("honors an override; 0 disables the cap", () => {
    expect(resolveParseTimeoutMs("250")).toBe(250);
    expect(resolveParseTimeoutMs("0")).toBe(0);
  });

  it("clamps a positive sub-1ms value to 1 (does not floor to disabled)", () => {
    expect(resolveParseTimeoutMs("0.5")).toBe(1);
  });

  it("throws (fails loud) on a malformed value", () => {
    expect(() => resolveParseTimeoutMs("nope")).toThrow(/MEMEX_PARSE_TIMEOUT_MS/);
    expect(() => resolveParseTimeoutMs("-5")).toThrow(/MEMEX_PARSE_TIMEOUT_MS/);
  });
});

const BIG_TS = Array.from(
  { length: 6000 },
  (_, i) => `export function f${i}(): number { return ${i}; }`,
).join("\n");

describe("parseWithBudget", () => {
  it("parses normal source within budget (no cancellation)", async () => {
    const parser = await getParser("typescript");
    const tree = parseWithBudget(parser, `export function ok(): number { return 1; }\n`);
    expect(tree.rootNode.hasError).toBe(false);
  });

  it("chunkCode still extracts symbols under the budget", async () => {
    const r = await chunkCode(
      `export function alpha(): number { return 1; }\n`,
      "alpha.ts",
      "typescript",
    );
    expect(r.symbols.map((s) => s.name)).toEqual(["alpha"]);
  });

  it("throws ParseTimeoutError on overrun, then RECOVERS the cached parser", async () => {
    _resetParsersForTests();
    const parser = await getParser("typescript");
    // 1ms budget vs a 6000-function source: the periodic progress check trips
    // the deadline and cancels the parse.
    process.env.MEMEX_PARSE_TIMEOUT_MS = "1";
    expect(() => parseWithBudget(parser, BIG_TS)).toThrow(ParseTimeoutError);

    // The cancelled parser MUST be usable again (parseWithBudget reset it):
    // a clean parse must not inherit a spurious hasError from the abort.
    delete process.env.MEMEX_PARSE_TIMEOUT_MS;
    const tree = parseWithBudget(parser, `export function ok(): number { return 1; }\n`);
    expect(tree.rootNode.hasError).toBe(false);
  });
});
