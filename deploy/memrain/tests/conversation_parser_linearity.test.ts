/**
 * Transcript parsing must stay linear in line length.
 *
 * `parseConversation` runs every builtin pattern against every line of a file
 * the operator hands it, and nothing upstream caps a line. Three of those
 * patterns used to let two quantifiers share the same whitespace:
 *
 *   - telegram-bracket: `\]\s*(.+?):` — 63 ms for a 16 K space run, ratio
 *     3.75-4.39 on a doubling (quadratic).
 *   - whatsapp: `\s*-?\s*(.+?):` — 363 s for the same 16 K run, ratio
 *     7.08-7.70 on a doubling (CUBIC).
 *   - the block-format header: `\s*(AM|PM)?\s*\)` — 105 ms at 16 K, ratio
 *     3.15-5.31, and it is matched against every line twice.
 *
 * A one-line transcript with a long run of spaces and no colon is the whole
 * attack, and it costs the writer nothing. The ceilings below are deliberately
 * loose: linear runs each of these in tens of milliseconds, the old shapes
 * needed minutes to hours, and a slow CI box cannot manufacture that gap.
 */
import { describe, expect, it } from "bun:test";
import { parseConversation } from "../src/core/conversation-parser.ts";

const CEILING_MS = 10_000;
const RUN = 1_000_000;

function timed(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe("conversation parser scan cost", () => {
  it("stays linear on a 1 MB space run behind a telegram timestamp", () => {
    const line = `[12:34]${" ".repeat(RUN)}abc`;
    let out: ReturnType<typeof parseConversation> = [];
    const elapsed = timed(() => (out = parseConversation(line)));
    // Nothing in that line is a message — the proof the scan did the work
    // rather than bailing out early.
    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear on a 1 MB space run behind a whatsapp date header", () => {
    const line = `[2024-03-15 12:34]${" ".repeat(RUN)}abc`;
    let out: ReturnType<typeof parseConversation> = [];
    const elapsed = timed(() => (out = parseConversation(line)));
    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear on a 1 MB space run inside a block-format header", () => {
    const line = `- **a** (12:34${" ".repeat(RUN)}x`;
    let out: ReturnType<typeof parseConversation> = [];
    const elapsed = timed(() => (out = parseConversation(line)));
    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still parses every builtin format", () => {
    const out = parseConversation(
      [
        "**Dave** (2024-03-15 9:00 AM): morning",
        "[18:37] Alice: hi there",
        "[2024-03-15, 18:37] Bob: hello",
        "2024-03-15 18:37 - Carol: hey",
        "<eve> irc line",
        "Frank: plain line",
        "- **Grace** (Mon 11:18)",
        "    the indented body",
      ].join("\n"),
    );
    expect(out).toEqual([
      { speaker: "Dave", timestamp: "2024-03-15T09:00:00Z", text: "morning" },
      { speaker: "Alice", timestamp: "1970-01-01T18:37:00Z", text: "hi there" },
      { speaker: "Bob", timestamp: "2024-03-15T18:37:00Z", text: "hello" },
      { speaker: "Carol", timestamp: "2024-03-15T18:37:00Z", text: "hey" },
      { speaker: "eve", timestamp: "1970-01-01T00:00:00Z", text: "irc line" },
      { speaker: "Frank", timestamp: "1970-01-01T00:00:00Z", text: "plain line" },
      { speaker: "Grace", timestamp: "1970-01-01T11:18:00Z", text: "the indented body" },
    ]);
  });

  it("keeps the whatsapp separator's optional dash and its spacing", () => {
    const out = parseConversation(
      [
        "2024-03-15 18:37   -   Carol: spaced dash",
        "2024-03-15,18:37-Dan:no spaces",
        "[2024-03-15, 18:37:22] - Erin: with seconds",
      ].join("\n"),
    );
    expect(out.map((m) => [m.speaker, m.text])).toEqual([
      ["Carol", "spaced dash"],
      ["Dan", "no spaces"],
      ["Erin", "with seconds"],
    ]);
  });

  it("caps a speaker at the 41 chars the plain pattern already allows", () => {
    // The bound is the one deliberate narrowing that bought the linearity: a
    // name at the cap still parses, one char over falls through to the
    // continuation fold instead of starting a new message.
    const atCap = "a".repeat(41);
    const overCap = "a".repeat(42);
    expect(parseConversation(`[12:34] ${atCap}: hi`)).toEqual([
      { speaker: atCap, timestamp: "1970-01-01T12:34:00Z", text: "hi" },
    ]);
    expect(parseConversation(`[12:34] ${overCap}: hi`)).toEqual([]);
  });
});
