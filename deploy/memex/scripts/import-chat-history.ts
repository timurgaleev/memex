#!/usr/bin/env bun
/**
 * import-chat-history — convert a vendor chat-export JSON into one markdown
 * page per conversation, ready for `memex index <dir>`. Deterministic: no LLM,
 * no DB, no network. Output pages carry `type: conversation` frontmatter and
 * `[HH:MM] Speaker: text` body lines — the bracket-time shape the
 * conversation parser reads.
 *
 * Input is liberal: the root may be a conversation array or an object holding
 * one; each conversation may carry a flat `messages` array or a keyed
 * `mapping`; speakers/text/timestamps are probed across the common key names.
 * Whatever doesn't parse is skipped and reported, never fatal.
 *
 * Usage: bun scripts/import-chat-history.ts <input.json> <outdir> [--dry-run]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ConvertedConversation {
  filename: string;
  markdown: string;
  title?: string;
  /** Conversation start, `YYYY-MM-DD` (UTC). Omitted when no timestamp parsed. */
  date?: string;
}

export interface SkippedConversation {
  index: number;
  reason: string;
}

export interface ConvertSummary {
  converted: ConvertedConversation[];
  skipped: SkippedConversation[];
  /** Messages dropped inside otherwise-converted conversations. */
  skippedMessages: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function firstString(
  rec: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Epoch seconds, epoch milliseconds, or a parseable date string → epoch ms. */
function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v > 1e11 ? v : v * 1000;
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const MESSAGE_TIME_KEYS = ["timestamp", "create_time", "created_at", "date", "time"] as const;

function messageEpochMs(rec: Record<string, unknown>): number | null {
  for (const k of MESSAGE_TIME_KEYS) {
    const ms = toEpochMs(rec[k]);
    if (ms !== null) return ms;
  }
  return null;
}

function extractSpeaker(rec: Record<string, unknown>): string | null {
  for (const key of ["author", "sender", "role", "from", "name"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    const obj = asRecord(v);
    if (obj) {
      const s = firstString(obj, ["name", "username", "role"]);
      if (s) return s;
    }
  }
  return null;
}

function extractText(rec: Record<string, unknown>): string | null {
  const direct = firstString(rec, ["text", "body"]);
  if (direct) return direct;
  const content = rec["content"];
  if (typeof content === "string" && content.trim()) return content.trim();
  const cObj = asRecord(content);
  const parts = Array.isArray(cObj?.["parts"])
    ? cObj["parts"]
    : Array.isArray(rec["parts"])
      ? rec["parts"]
      : null;
  if (parts) {
    const joined = parts
      .filter((p): p is string => typeof p === "string")
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  if (cObj) {
    const s = firstString(cObj, ["text", "body"]);
    if (s) return s;
  }
  return null;
}

/** Flat `messages` array, or a keyed `mapping` of nodes wrapping `message`. */
function extractMessages(conv: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["messages", "chat_messages", "msgs"]) {
    const flat = conv[key];
    if (Array.isArray(flat)) {
      return flat.map(asRecord).filter((m): m is Record<string, unknown> => m !== null);
    }
  }
  const mapping = asRecord(conv["mapping"]);
  if (mapping) {
    const out: Record<string, unknown>[] = [];
    for (const v of Object.values(mapping)) {
      const node = asRecord(v);
      if (!node) continue;
      out.push(asRecord(node["message"]) ?? node);
    }
    // Keyed mappings carry no order; sort by timestamp where present
    // (stable sort keeps insertion order for timestamp-less nodes).
    return out.sort((a, b) => (messageEpochMs(a) ?? 0) - (messageEpochMs(b) ?? 0));
  }
  return [];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function utcHHMM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function utcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Double-quote a YAML value when it contains ':' or quote characters. */
function yamlValue(v: string): string {
  // Vendor titles are untrusted: strip control chars/newlines (a newline
  // would inject frontmatter keys), then emit unquoted ONLY for a
  // conservative plain scalar — anything else (leading #/-/[/{/&/*, " #",
  // colons, quotes) is quoted. The ingesting parser strips surrounding
  // quotes but does not unescape, so inner double quotes become
  // typographic ones instead of backslash escapes.
  const clean = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (/^[\p{L}\p{N}][\p{L}\p{N} _.,()\/-]*$/u.test(clean) && !clean.includes(" #")) {
    return clean;
  }
  return `"${clean.replace(/"/g, "\u2019")}"`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const CONV_TITLE_KEYS = ["title", "name", "subject"] as const;
const CONV_TIME_KEYS = [
  "create_time",
  "created_at",
  "createTime",
  "start_time",
  "timestamp",
] as const;

interface ConvertedOne {
  title?: string;
  date?: string;
  /** Vendor conversation id — provenance for later cross-referencing. */
  conversationId?: string;
  body: string;
  skippedMessages: number;
}

function convertOne(conv: Record<string, unknown>): ConvertedOne | string {
  const title = firstString(conv, CONV_TITLE_KEYS);
  const messages = extractMessages(conv);
  if (messages.length === 0) return "no messages found";

  let startMs: number | null = null;
  for (const k of CONV_TIME_KEYS) {
    startMs = toEpochMs(conv[k]);
    if (startMs !== null) break;
  }

  const lines: string[] = [];
  let skippedMessages = 0;
  // Timestamp-less messages inherit the previous message's time — keeps the
  // line parseable and roughly in order.
  let lastTime = "00:00";
  for (const msg of messages) {
    const speaker = extractSpeaker(msg);
    const text = extractText(msg);
    if (!speaker || !text) {
      skippedMessages++;
      continue;
    }
    const ms = messageEpochMs(msg);
    if (ms !== null) {
      lastTime = utcHHMM(ms);
      if (startMs === null || ms < startMs) startMs = ms;
    }
    lines.push(`[${lastTime}] ${speaker.replace(/\s+/g, " ")}: ${text}`);
  }
  if (lines.length === 0) return "no parseable messages";

  const out: ConvertedOne = { body: lines.join("\n"), skippedMessages };
  if (title) out.title = title;
  if (startMs !== null) out.date = utcDate(startMs);
  const convId = firstString(conv, ["id", "uuid", "conversation_id"] as const);
  if (convId) out.conversationId = convId;
  return out;
}

function buildMarkdown(c: ConvertedOne): string {
  const fm = ["---", "type: conversation"];
  if (c.title) fm.push(`title: ${yamlValue(c.title)}`);
  if (c.date) fm.push(`date: ${c.date}`);
  if (c.conversationId) fm.push(`conversation_id: ${yamlValue(c.conversationId)}`);
  fm.push("---", "");
  return `${fm.join("\n")}${c.body}\n`;
}

/**
 * Convert a parsed chat-export JSON value into per-conversation markdown
 * pages. Pure — the CLI below does the file I/O.
 */
export function convertChatExport(data: unknown): ConvertSummary {
  let conversations: unknown[] = [];
  if (Array.isArray(data)) {
    conversations = data;
  } else {
    const rec = asRecord(data);
    for (const k of ["conversations", "chats", "threads"]) {
      if (rec && Array.isArray(rec[k])) {
        conversations = rec[k];
        break;
      }
    }
  }
  if (conversations.length === 0) {
    return {
      converted: [],
      skipped: [{ index: 0, reason: "no conversation array found in input" }],
      skippedMessages: 0,
    };
  }

  const converted: ConvertedConversation[] = [];
  const skipped: SkippedConversation[] = [];
  let skippedMessages = 0;
  const usedNames = new Set<string>();
  conversations.forEach((raw, index) => {
    const conv = asRecord(raw);
    if (!conv) {
      skipped.push({ index, reason: "not an object" });
      return;
    }
    const one = convertOne(conv);
    if (typeof one === "string") {
      skipped.push({ index, reason: one });
      return;
    }
    skippedMessages += one.skippedMessages;
    const base = (one.title && slugify(one.title)) || `conversation-${index + 1}`;
    let filename = `${base}.md`;
    for (let n = 2; usedNames.has(filename); n++) filename = `${base}-${n}.md`;
    usedNames.add(filename);
    const entry: ConvertedConversation = { filename, markdown: buildMarkdown(one) };
    if (one.title) entry.title = one.title;
    if (one.date) entry.date = one.date;
    converted.push(entry);
  });
  return { converted, skipped, skippedMessages };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => a !== "--dry-run");
  if (positional.length !== 2) {
    console.error("usage: bun scripts/import-chat-history.ts <input.json> <outdir> [--dry-run]");
    process.exit(2);
  }
  const [inputPath, outDir] = positional as [string, string];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (err) {
    console.error(`failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { converted, skipped, skippedMessages } = convertChatExport(data);
  if (!dryRun) {
    mkdirSync(outDir, { recursive: true });
    for (const c of converted) {
      writeFileSync(join(outDir, c.filename), c.markdown);
    }
  }
  console.log(
    `converted ${converted.length}, skipped ${skipped.length}` +
      (skippedMessages > 0 ? ` (+${skippedMessages} unparseable messages)` : "") +
      (dryRun ? " — dry-run, nothing written" : ""),
  );
  for (const s of skipped) console.log(`  skipped [${s.index}]: ${s.reason}`);
  if (!dryRun && converted.length > 0) {
    console.log(`wrote ${converted.length} page(s) to ${outDir} — ingest with: memex index ${outDir}`);
  }
}
