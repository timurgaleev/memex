/**
 * ChatGPT data export (`conversations.json`). Each conversation is a tree:
 * `mapping` holds every node, `parent`/`children` link them, and a regenerated
 * answer is a sibling branch. `current_node` names the leaf the user last saw,
 * so walking parent pointers up from it yields exactly the chosen branch.
 * Sorting the whole mapping by time would interleave abandoned answers.
 */
import {
  asRecord,
  toEpochMs,
  type AdapterResult,
  type TranscriptAdapter,
  type TranscriptMessage,
  type TranscriptSession,
} from "./types.ts";

type Node = Record<string, unknown>;

const TEXT_CONTENT_TYPES = new Set(["text", "multimodal_text"]);

function nodeMessage(node: Node): Record<string, unknown> | null {
  return asRecord(node["message"]);
}

function messageTime(node: Node): number | null {
  const m = nodeMessage(node);
  return m ? toEpochMs(m["create_time"]) : null;
}

/** The leaf with the newest message time; the last one seen on a tie. */
function latestLeaf(mapping: Record<string, unknown>): string | null {
  let best: string | null = null;
  let bestTs = -Infinity;
  for (const [id, raw] of Object.entries(mapping)) {
    const node = asRecord(raw);
    if (!node || !nodeMessage(node)) continue;
    const children = Array.isArray(node["children"]) ? node["children"] : [];
    if (children.some((c) => typeof c === "string" && asRecord(mapping[c]) !== null)) continue;
    const ts = messageTime(node) ?? -1;
    if (ts >= bestTs) {
      bestTs = ts;
      best = id;
    }
  }
  return best;
}

/** Root-to-leaf path ending at `leaf`. Stops at a missing parent (orphan) or
 *  a node already visited (cycle) instead of throwing. */
function branchTo(mapping: Record<string, unknown>, leaf: string): Node[] {
  const path: Node[] = [];
  const seen = new Set<string>();
  let cur: string | null = leaf;
  while (cur !== null && !seen.has(cur)) {
    const node = asRecord(mapping[cur]);
    if (!node) break;
    seen.add(cur);
    path.push(node);
    const parent = node["parent"];
    cur = typeof parent === "string" ? parent : null;
  }
  return path.reverse();
}

function messageText(message: Record<string, unknown>): string | null {
  const content = asRecord(message["content"]);
  if (!content) return null;
  const type = content["content_type"];
  if (typeof type !== "string" || !TEXT_CONTENT_TYPES.has(type)) return null;
  const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
  const text = parts
    .filter((p): p is string => typeof p === "string")
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function isHidden(message: Record<string, unknown>): boolean {
  const meta = asRecord(message["metadata"]);
  return meta?.["is_visually_hidden_from_conversation"] === true;
}

function toMessage(node: Node): TranscriptMessage | "skip" | null {
  const message = nodeMessage(node);
  // The synthetic root carries no message at all; it is not a dropped turn.
  if (!message) return null;
  const author = asRecord(message["author"]);
  const role = author?.["role"];
  if (role !== "user" && role !== "assistant") return "skip";
  if (isHidden(message)) return "skip";
  // An assistant turn addressed to a tool is a tool call, not an answer.
  const recipient = message["recipient"];
  if (typeof recipient === "string" && recipient !== "all") return "skip";
  const text = messageText(message);
  if (text === null) return "skip";
  const id = typeof message["id"] === "string" ? message["id"] : typeof node["id"] === "string" ? node["id"] : "";
  return {
    id,
    role,
    speaker: role === "user" ? "User" : "ChatGPT",
    text,
    ts: toEpochMs(message["create_time"]),
  };
}

function conversationId(conv: Record<string, unknown>): string | null {
  for (const k of ["conversation_id", "id"]) {
    const v = conv[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function parseChatGptExport(items: readonly unknown[]): AdapterResult {
  const sessions: TranscriptSession[] = [];
  const skipped: AdapterResult["skipped"] = [];
  let skippedMessages = 0;
  items.forEach((raw, index) => {
    const conv = asRecord(raw);
    const mapping = conv ? asRecord(conv["mapping"]) : null;
    if (!conv || !mapping) {
      skipped.push({ index, reason: "no mapping" });
      return;
    }
    const id = conversationId(conv);
    if (id === null) {
      skipped.push({ index, reason: "no conversation id" });
      return;
    }
    const current = conv["current_node"];
    const leaf =
      typeof current === "string" && asRecord(mapping[current]) !== null ? current : latestLeaf(mapping);
    if (leaf === null) {
      skipped.push({ index, id, reason: "no messages" });
      return;
    }
    const messages: TranscriptMessage[] = [];
    for (const node of branchTo(mapping, leaf)) {
      const m = toMessage(node);
      if (m === "skip") skippedMessages++;
      else if (m !== null) messages.push(m);
    }
    if (messages.length === 0) {
      skipped.push({ index, id, reason: "no user or assistant text" });
      return;
    }
    const title = typeof conv["title"] === "string" && conv["title"].trim() ? conv["title"].trim() : null;
    sessions.push({
      format: "chatgpt",
      id,
      title,
      startedAt: toEpochMs(conv["create_time"]) ?? messages.find((m) => m.ts !== null)?.ts ?? null,
      messages,
    });
  });
  return { sessions, skipped, skippedMessages };
}

export const chatGptAdapter: TranscriptAdapter = {
  format: "chatgpt",
  detect: (items) =>
    items.some((it) => {
      const r = asRecord(it);
      return r !== null && asRecord(r["mapping"]) !== null && "current_node" in r;
    }),
  parse: parseChatGptExport,
};
