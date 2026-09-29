/**
 * The unclosed-`[Source:` scan must stay linear in line length.
 *
 * `[Source:` repeated is the adversarial shape for the old spelling,
 * `/\[Source:[^\]]*$/`: every `[Source:` is a fresh start position, and from
 * each one the unbounded `[^\]]*` walks the whole rest of the line before `$`
 * fails. Measured through `lintContent` at 156 ms for 64 K chars, 630 ms for
 * 128 K, 2.9 s for 256 K and 11.7 s for 512 K — squaring cleanly, on a path
 * where nothing caps line length. One line in one page is enough to hold the
 * linter for a minute.
 *
 * The replacement asks the same question from the other end (nothing after the
 * line's last `]` can be closed), so unlike a length bound it keeps the rule's
 * reach: a very long unclosed citation is exactly what this rule exists to
 * catch, and the last case here pins that down.
 *
 * The ceiling is deliberately loose. Linear runs this in single-digit
 * milliseconds; quadratic needs the better part of a minute. A slow CI box
 * cannot manufacture a miss that large.
 */
import { describe, expect, it } from "bun:test";
import { lintContent } from "../src/core/lint.ts";

const CEILING_MS = 15_000;

const brokenCitations = (content: string): number =>
  lintContent(content, "f.md").filter((i) => i.rule === "broken-citation").length;

describe("unclosed-citation scan cost", () => {
  it("stays linear on a 1 MB line of citation openers", () => {
    const body = "[Source:".repeat(125_000);
    expect(body.length).toBe(1_000_000);

    const started = performance.now();
    const found = brokenCitations(body);
    const elapsed = performance.now() - started;

    // The line really is unclosed — the assertion that the scan did the work
    // rather than bailing out early.
    expect(found).toBe(1);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear when the line is closed at the very end", () => {
    // The costlier half for the old regex: every start walks to the trailing
    // `]`, then `$` fails and the whole walk is given back one position at a
    // time.
    const body = "[Source:".repeat(125_000) + "]";

    const started = performance.now();
    const found = brokenCitations(body);
    const elapsed = performance.now() - started;

    expect(found).toBe(0);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still flags an unclosed citation and spares a closed one", () => {
    expect(brokenCitations("## Sources\n\n[Source: some report\nwithout the bracket\n")).toBe(1);
    expect(brokenCitations("[Source: a report]\n")).toBe(0);
    // A citation wrapped onto the next line closes there — not an issue.
    expect(brokenCitations("[Source: a long report\n  continued]\n")).toBe(0);
    // Only the unclosed opener on a line with both is reported.
    expect(brokenCitations("[Source: closed] then [Source: open\n")).toBe(1);
  });

  it("flags a long unclosed citation — the scan is not length-bounded", () => {
    // A bounded class (`[^\]]{0,512}$`) would run fast and silently stop
    // reporting here. Nothing about a citation caps its length, so the rule
    // must still fire well past any such bound.
    expect(brokenCitations(`[Source: ${"x".repeat(5_000)}`)).toBe(1);
    expect(brokenCitations(`[Source: ${"x".repeat(5_000)}]`)).toBe(0);
  });
});
