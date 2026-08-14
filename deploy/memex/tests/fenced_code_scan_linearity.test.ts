/**
 * The fenced-code scan must stay linear in page length.
 *
 * Two shapes made it quadratic, and both are cheap to write:
 *
 *  1. "```a\n" repeated. Every line opens a fence and no line ever closes one,
 *     so the lazy body walks to the end of the page from each of the n/5 line
 *     starts. Measured 27 s at 500 KB and 107 s at 1 MB, x4 per doubling.
 *  2. "````ts\n```py\nx\n```\n" repeated. Here a closer does exist, but not for
 *     the four-backtick run — the matcher only reaches the three-backtick one
 *     by giving group 1 back a character, and it pays a full walk to the end of
 *     the page for the four-backtick attempt first. 370 ms at 125 KB, 23.7 s at
 *     1 MB, x4 per doubling. Filtering openers alone does not catch this one;
 *     the run has to be resolved before the match, not during it.
 *
 * `MEMEX_MAX_FENCES_PER_PAGE` does not help — it caps blocks that were found,
 * and neither page finds any.
 *
 * The ceiling below is deliberately loose. Linear runs both in tens of
 * milliseconds; quadratic needs half a minute or more. Anything in between is a
 * real regression, and a slow CI box cannot manufacture a 1000x miss.
 */
import { describe, expect, it } from "bun:test";
import { extractFencedCode } from "../src/core/chunkers/fenced-code.ts";

const CEILING_MS = 15_000;

function elapsed(body: string): { out: ReturnType<typeof extractFencedCode>; ms: number } {
  const started = performance.now();
  const out = extractFencedCode(body);
  return { out, ms: performance.now() - started };
}

describe("fenced-code scan cost", () => {
  it("stays linear on 1 MB of openers that never close", () => {
    const body = "```a\n".repeat(200_000);
    expect(body.length).toBe(1_000_000);

    const { out, ms } = elapsed(body);

    // Nothing in that page is a fence — the assertion that the scan did the
    // work rather than bailing early.
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it("stays linear on 1 MB of four-backtick openers with only three-backtick closers", () => {
    const unit = "````ts\n```py\nx\n```\n";
    const body = unit.repeat(Math.floor(1_000_000 / unit.length));
    expect(body.length).toBeGreaterThan(990_000);

    const { out, ms } = elapsed(body);

    // The four-backtick opener only closes by shortening its run, which leaves
    // the info tag empty, so nothing is extracted.
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it("still extracts ordinary fences, and only supported tags", () => {
    const body = [
      "# Doc",
      "",
      "```typescript",
      "export function alpha() { return 1; }",
      "```",
      "",
      "```ruby",
      "def foo; end",
      "```",
      "",
      "~~~sql",
      "SELECT 1;",
      "~~~",
    ].join("\n");

    expect(extractFencedCode(body)).toEqual([
      { lang: "typescript", source: "export function alpha() { return 1; }\n" },
      { lang: "sql", source: "SELECT 1;\n" },
    ]);
  });

  it("settles on the longest run that actually closes, and consumes what it spans", () => {
    // This is the invariant that replaced group 1's backtracking. A four-
    // backtick opener with a four-backtick closer keeps its tag...
    expect(extractFencedCode("````ts\nconst a=1;\n````\n")).toEqual([
      { lang: "typescript", source: "const a=1;\n" },
    ]);
    // ...but with only a three-backtick closer available it shortens the run,
    // which empties the tag, and the span through that closer is consumed — so
    // the fence nested inside it is not extracted either.
    expect(extractFencedCode("````ts\nconst a=1;\n```\ntail\n")).toEqual([]);
    expect(extractFencedCode("````\n```ts\nconst a=1;\n```\n````\n")).toEqual([]);
  });

  it("keeps a fence that opens after openers of a run that never closes", () => {
    // Skipping an opener that cannot close must not skip the page behind it.
    // The tilde openers have no tilde closer anywhere, so each is passed over;
    // the backtick fence after them still has to be found.
    const body = "~~~a\n".repeat(5_000) + "```ts\nconst a=1;\n```\n";
    expect(extractFencedCode(body)).toEqual([
      { lang: "typescript", source: "const a=1;\n" },
    ]);
  });
});
