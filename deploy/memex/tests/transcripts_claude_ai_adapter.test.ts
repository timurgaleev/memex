import { describe, expect, it } from "bun:test";
import { parseClaudeAiExport } from "../src/core/transcripts/claude-ai.ts";

describe("parseClaudeAiExport", () => {
  it("maps senders, joins content blocks, keeps per-message uuids and skips empty turns", () => {
    const r = parseClaudeAiExport([
      {
        uuid: "conv-1",
        name: "Planning",
        created_at: "2026-05-01T09:00:00Z",
        chat_messages: [
          { uuid: "m1", sender: "human", text: "Plan the week", created_at: "2026-05-01T09:00:05Z", content: [] },
          {
            uuid: "m2",
            sender: "assistant",
            text: "",
            created_at: "2026-05-01T09:00:09Z",
            content: [
              { type: "text", text: "Monday: review." },
              { type: "tool_use", name: "search" },
              { type: "text", text: "Tuesday: ship." },
            ],
          },
          { uuid: "m3", sender: "human", text: "   ", content: [] },
          { uuid: "m4", sender: "system", text: "ignored" },
        ],
      },
    ]);
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0]!;
    expect(s.format).toBe("claude-ai");
    expect(s.id).toBe("conv-1");
    expect(s.title).toBe("Planning");
    expect(s.messages.map((m) => [m.id, m.role, m.speaker])).toEqual([
      ["m1", "user", "User"],
      ["m2", "assistant", "Claude"],
    ]);
    expect(s.messages[1]!.text).toBe("Monday: review.\n\nTuesday: ship.");
    expect(s.messages[0]!.ts).toBe(Date.parse("2026-05-01T09:00:05Z"));
    expect(r.skippedMessages).toBe(2);
  });

  it("skips a conversation with no readable turns and says why", () => {
    const r = parseClaudeAiExport([{ uuid: "empty", chat_messages: [] }, { name: "no uuid", chat_messages: [] }]);
    expect(r.sessions).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(["no user or assistant text", "no conversation uuid"]);
  });
});
