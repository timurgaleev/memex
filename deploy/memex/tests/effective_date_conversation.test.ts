/**
 * effective-date content-date parser + conversation/chat transcript parser.
 * Pure functions, no DB / no LLM.
 */
import { describe, expect, it } from "bun:test";
import { resolveEffectiveDate } from "../src/core/effective-date.ts";
import { parseConversation } from "../src/core/conversation-parser.ts";

describe("resolveEffectiveDate", () => {
  it("prefers frontmatter date, then event_date, then published", () => {
    expect(resolveEffectiveDate({ date: "2024-03-15" })).toBe("2024-03-15T00:00:00.000Z");
    expect(resolveEffectiveDate({ event_date: "2024-01-02" })).toBe("2024-01-02T00:00:00.000Z");
    expect(resolveEffectiveDate({ published: "2023-12-31" })).toBe("2023-12-31T00:00:00.000Z");
    // date wins over event_date
    expect(resolveEffectiveDate({ date: "2024-03-15", event_date: "2020-01-01" })).toBe(
      "2024-03-15T00:00:00.000Z",
    );
  });

  it("falls back to a YYYY-MM-DD in the filename", () => {
    expect(resolveEffectiveDate({}, "daily/2024-06-30-standup.md")).toBe(
      "2024-06-30T00:00:00.000Z",
    );
  });

  it("returns null for no date and never throws on garbage", () => {
    expect(resolveEffectiveDate({ date: "not a date" }, "no-date.md")).toBeNull();
    expect(resolveEffectiveDate(null, null)).toBeNull();
    expect(resolveEffectiveDate({})).toBeNull();
  });

  it("accepts epoch seconds and milliseconds (incl. pre-2001 ms)", () => {
    expect(resolveEffectiveDate({ date: 1_710_460_800 })).toBe("2024-03-15T00:00:00.000Z");
    // 1998 as epoch-ms (8.8e11) must read as ms, not be multiplied to the future.
    // Underscores keep this off the 12-consecutive-digit PII heuristic.
    expect(resolveEffectiveDate({ date: 883_612_800_000 })).toBe("1998-01-01T00:00:00.000Z");
  });
});

describe("parseConversation", () => {
  it("parses iMessage/Slack inline-date lines", () => {
    const msgs = parseConversation("**Alice** (2024-03-15 9:00 AM): hello\n**Bob** (2024-03-15 12:00 PM): noon");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ speaker: "Alice", timestamp: "2024-03-15T09:00:00Z", text: "hello" });
    expect(msgs[1]?.timestamp).toBe("2024-03-15T12:00:00Z");
  });

  it("parses Telegram bracket-time with a date context", () => {
    const msgs = parseConversation("[18:37] Alice: hi there", { dateContext: "2024-03-15" });
    expect(msgs[0]).toEqual({ speaker: "Alice", timestamp: "2024-03-15T18:37:00Z", text: "hi there" });
  });

  it("parses IRC and plain transcript lines", () => {
    const irc = parseConversation("<alice> irc message");
    expect(irc[0]?.speaker).toBe("alice");
    expect(irc[0]?.text).toBe("irc message");
    const plain = parseConversation("Bob: just a plain line");
    expect(plain[0]).toEqual({ speaker: "Bob", timestamp: "1970-01-01T00:00:00Z", text: "just a plain line" });
  });

  it("folds an unmatched continuation line into the previous message", () => {
    const msgs = parseConversation("Alice: first line\n  wrapped continuation");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toBe("first line\nwrapped continuation");
  });

  it("parses block-format transcripts (header + indented body lines)", () => {
    const doc = [
      "- **Alice** (Mon 11:18)",
      "    morning standup notes",
      "    second body line",
      "- **Bob** (Mon 1:05 PM)",
      "    afternoon reply",
    ].join("\n");
    const msgs = parseConversation(doc, { dateContext: "2024-03-18" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      speaker: "Alice",
      timestamp: "2024-03-18T11:18:00Z",
      text: "morning standup notes\nsecond body line",
    });
    expect(msgs[1]).toEqual({
      speaker: "Bob",
      timestamp: "2024-03-18T13:05:00Z",
      text: "afternoon reply",
    });
  });

  it("handles AM/PM midnight + noon correctly", () => {
    const mid = parseConversation("**X** (2024-03-15 12:00 AM): midnight");
    expect(mid[0]?.timestamp).toBe("2024-03-15T00:00:00Z");
    const noon = parseConversation("**X** (2024-03-15 12:00 PM): noon");
    expect(noon[0]?.timestamp).toBe("2024-03-15T12:00:00Z");
  });
});
