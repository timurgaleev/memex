/**
 * The ChatGPT adapter follows the branch the user last saw: `current_node`
 * up through parent pointers. Abandoned regenerations never reach a session.
 */
import { describe, expect, it } from "bun:test";
import { parseChatGptExport } from "../src/core/transcripts/chatgpt.ts";

type N = { id: string; parent: string | null; children: string[]; message: unknown };

function msg(id: string, role: string, text: string, t: number | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: { role },
    create_time: t,
    content: { content_type: "text", parts: [text] },
    recipient: "all",
    ...extra,
  };
}

function conv(nodes: N[], current: string | null, extra: Record<string, unknown> = {}) {
  const mapping: Record<string, N> = {};
  for (const n of nodes) mapping[n.id] = n;
  return { id: "c-1", title: "Regenerated", create_time: 1_700_000_000, mapping, current_node: current, ...extra };
}

const T = 1_700_000_000;

/** root → question → two answers (the second a regeneration) → follow-up on the second. */
function regenerated(current: string | null) {
  return conv(
    [
      { id: "root", parent: null, children: ["q"], message: null },
      { id: "q", parent: "root", children: ["a1", "a2"], message: msg("q", "user", "What is RRF?", T + 1) },
      { id: "a1", parent: "q", children: [], message: msg("a1", "assistant", "ABANDONED first answer", T + 2) },
      { id: "a2", parent: "q", children: ["f"], message: msg("a2", "assistant", "Chosen second answer", T + 3) },
      { id: "f", parent: "a2", children: [], message: msg("f", "user", "Thanks", T + 4) },
    ],
    current,
  );
}

describe("parseChatGptExport", () => {
  it("keeps only the branch current_node points at", () => {
    const r = parseChatGptExport([regenerated("f")]);
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0]!;
    expect(s.messages.map((m) => m.id)).toEqual(["q", "a2", "f"]);
    expect(s.messages.map((m) => m.text).join("\n")).not.toContain("ABANDONED");
    expect(s.messages[1]!.speaker).toBe("ChatGPT");
    expect(s.messages[0]!.ts).toBe((T + 1) * 1000);
    expect(s.startedAt).toBe(T * 1000);
  });

  it("falls back to the newest leaf when current_node is missing or dangling", () => {
    for (const current of [null, "no-such-node"]) {
      const s = parseChatGptExport([regenerated(current)]).sessions[0]!;
      expect(s.messages.map((m) => m.id)).toEqual(["q", "a2", "f"]);
    }
  });

  it("stops at an orphan parent pointer without throwing", () => {
    const c = conv(
      [
        { id: "a", parent: "gone", children: ["b"], message: msg("a", "user", "orphaned start", T) },
        { id: "b", parent: "a", children: [], message: msg("b", "assistant", "reply", T + 1) },
      ],
      "b",
    );
    expect(parseChatGptExport([c]).sessions[0]!.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("terminates on a parent cycle", () => {
    const c = conv(
      [
        { id: "x", parent: "y", children: ["y"], message: msg("x", "user", "x", T) },
        { id: "y", parent: "x", children: ["x"], message: msg("y", "assistant", "y", T + 1) },
      ],
      "y",
    );
    expect(parseChatGptExport([c]).sessions[0]!.messages.map((m) => m.id)).toEqual(["x", "y"]);
  });

  it("skips and counts system, tool, hidden and non-text messages", () => {
    const c = conv(
      [
        { id: "s", parent: null, children: ["h"], message: msg("s", "system", "You are helpful", T) },
        {
          id: "h",
          parent: "s",
          children: ["u"],
          message: msg("h", "user", "context", T, { metadata: { is_visually_hidden_from_conversation: true } }),
        },
        { id: "u", parent: "h", children: ["call"], message: msg("u", "user", "run it", T + 1) },
        { id: "call", parent: "u", children: ["tool"], message: msg("call", "assistant", "{\"q\":1}", T + 2, { recipient: "python" }) },
        { id: "tool", parent: "call", children: ["code"], message: msg("tool", "tool", "42", T + 3) },
        {
          id: "code",
          parent: "tool",
          children: ["ans"],
          message: { ...msg("code", "assistant", "", T + 4), content: { content_type: "code", text: "print(1)" } },
        },
        { id: "ans", parent: "code", children: [], message: msg("ans", "assistant", "It is 42", T + 5) },
      ],
      "ans",
    );
    const r = parseChatGptExport([c]);
    expect(r.sessions[0]!.messages.map((m) => m.id)).toEqual(["u", "ans"]);
    expect(r.skippedMessages).toBe(5);
  });

  it("never invents a time for a message that has none", () => {
    const c = conv(
      [
        { id: "a", parent: null, children: ["b"], message: msg("a", "user", "no clock", null) },
        { id: "b", parent: "a", children: [], message: msg("b", "assistant", "still none", null) },
      ],
      "b",
      { create_time: null },
    );
    const s = parseChatGptExport([c]).sessions[0]!;
    expect(s.messages.map((m) => m.ts)).toEqual([null, null]);
    expect(s.startedAt).toBeNull();
  });

  it("reports conversations it cannot read instead of failing", () => {
    const r = parseChatGptExport([{ title: "no mapping" }, conv([], null)]);
    expect(r.sessions).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(["no mapping", "no messages"]);
  });
});
