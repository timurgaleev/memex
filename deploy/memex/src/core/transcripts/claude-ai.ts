/**
 * Claude.ai data export (`conversations.json`): a flat, already-ordered
 * `chat_messages` list per conversation. Newer exports carry the text in
 * `content[]` blocks, older ones in `text`.
 */
import {
  asRecord,
  toEpochMs,
  type AdapterResult,
  type TranscriptAdapter,
  type TranscriptMessage,
  type TranscriptSession,
} from "./types.ts";

function blockText(message: Record<string, unknown>): string {
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  const fromBlocks = content
    .map(asRecord)
    .filter((b): b is Record<string, unknown> => b !== null && b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string)
    .join("\n\n")
    .trim();
  if (fromBlocks.length > 0) return fromBlocks;
  return typeof message["text"] === "string" ? message["text"].trim() : "";
}

export function parseClaudeAiExport(items: readonly unknown[]): AdapterResult {
  const sessions: TranscriptSession[] = [];
  const skipped: AdapterResult["skipped"] = [];
  let skippedMessages = 0;
  items.forEach((raw, index) => {
    const conv = asRecord(raw);
    const list = conv && Array.isArray(conv["chat_messages"]) ? conv["chat_messages"] : null;
    if (!conv || !list) {
      skipped.push({ index, reason: "no chat_messages" });
      return;
    }
    const id = typeof conv["uuid"] === "string" && conv["uuid"].trim() ? conv["uuid"].trim() : null;
    if (id === null) {
      skipped.push({ index, reason: "no conversation uuid" });
      return;
    }
    const messages: TranscriptMessage[] = [];
    for (const rawMsg of list) {
      const m = asRecord(rawMsg);
      const sender = m?.["sender"];
      const role = sender === "human" ? "user" : sender === "assistant" ? "assistant" : null;
      const text = m ? blockText(m) : "";
      if (!m || role === null || text.length === 0) {
        skippedMessages++;
        continue;
      }
      messages.push({
        id: typeof m["uuid"] === "string" ? m["uuid"] : "",
        role,
        speaker: role === "user" ? "User" : "Claude",
        text,
        ts: toEpochMs(m["created_at"]),
      });
    }
    if (messages.length === 0) {
      skipped.push({ index, id, reason: "no user or assistant text" });
      return;
    }
    const title = typeof conv["name"] === "string" && conv["name"].trim() ? conv["name"].trim() : null;
    sessions.push({
      format: "claude-ai",
      id,
      title,
      startedAt: toEpochMs(conv["created_at"]) ?? messages.find((m) => m.ts !== null)?.ts ?? null,
      messages,
    });
  });
  return { sessions, skipped, skippedMessages };
}

export const claudeAiAdapter: TranscriptAdapter = {
  format: "claude-ai",
  detect: (items) =>
    items.some((it) => {
      const r = asRecord(it);
      return r !== null && Array.isArray(r["chat_messages"]) && typeof r["uuid"] === "string";
    }),
  parse: parseClaudeAiExport,
};
