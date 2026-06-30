/**
 * Conversation / chat-transcript parser — deterministic, regex-only, no LLM.
 *
 * Turns an exported chat log (iMessage, Slack, Telegram, WhatsApp, Discord,
 * IRC, or a plain "Speaker: text" transcript) into structured messages
 * `{ speaker, timestamp, text }`. memex already ingests transcript docs as
 * flat markdown chunks; this is the brain-only primitive that gives a
 * per-(speaker, timestamp, text) structure for timeline + per-person facts.
 *
 * Adapted from the reference's conversation-parser: the pure pattern core only.
 * The reference's optional LLM polish / LLM fallback are deliberately NOT
 * ported — memex is Nova-only and a deterministic parser is the retrieval
 * brain's job. Patterns are a curated subset covering the common export
 * formats; add entries to BUILTIN_PATTERNS as new formats appear.
 */

export interface ConversationMessage {
  speaker: string;
  /** ISO-8601 UTC. Time-only formats use `dateContext` (else 1970-01-01). */
  timestamp: string;
  text: string;
}

interface PatternEntry {
  id: string;
  regex: RegExp;
  /** O(1) prefix screen before the (costlier) full regex. */
  quickReject?: RegExp;
  speaker: number;
  text: number;
  /** Full inline date `YYYY-MM-DD` capture group, when the format has one. */
  dateGroup?: number;
  hourGroup?: number;
  minuteGroup?: number;
  ampmGroup?: number;
}

const SPEAKER_CLEAN = /^[^\p{L}\p{N}]+\s*/u;

function cleanSpeaker(raw: string): string {
  return raw.replace(SPEAKER_CLEAN, "").trim() || raw.trim();
}

const BUILTIN_PATTERNS: readonly PatternEntry[] = [
  {
    // **Alice** (2024-03-15 9:00 AM): hello   (iMessage / Slack export)
    id: "inline-date",
    regex:
      /^\*\*(.+?)\*\*\s*\((\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\)\s*:\s*(.*)$/,
    quickReject: /^\*\*/,
    speaker: 1,
    dateGroup: 2,
    hourGroup: 3,
    minuteGroup: 4,
    ampmGroup: 5,
    text: 6,
  },
  {
    // [18:37] Alice: hi   (Telegram bracket-time)
    id: "telegram-bracket",
    regex: /^\[(\d{1,2}):(\d{2})\]\s*(.+?):\s*(.*)$/,
    quickReject: /^\[/,
    speaker: 3,
    hourGroup: 1,
    minuteGroup: 2,
    text: 4,
  },
  {
    // [2024-03-15, 18:37] Alice: hi   (WhatsApp-ish)
    id: "whatsapp",
    regex:
      /^\[?(\d{4}-\d{2}-\d{2})[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\]?\s*-?\s*(.+?):\s*(.*)$/,
    speaker: 4,
    dateGroup: 1,
    hourGroup: 2,
    minuteGroup: 3,
    text: 5,
  },
  {
    // <alice> message   (IRC)
    id: "irc",
    regex: /^<([^>]+)>\s*(.*)$/,
    quickReject: /^</,
    speaker: 1,
    text: 2,
  },
  {
    // Alice: message   (plain transcript; tried last — most permissive)
    id: "plain",
    regex: /^([A-Za-z][\w .'-]{0,40}?):\s+(.+)$/,
    speaker: 1,
    text: 2,
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Build an ISO timestamp from an inline date or the date context + time. */
function toTimestamp(
  m: RegExpMatchArray,
  entry: PatternEntry,
  dateContext: string,
): string {
  const date =
    entry.dateGroup && m[entry.dateGroup] ? m[entry.dateGroup]! : dateContext;
  if (entry.hourGroup == null || entry.minuteGroup == null) {
    return `${date}T00:00:00Z`;
  }
  let hour = Number(m[entry.hourGroup]);
  const minute = Number(m[entry.minuteGroup]);
  const ampm = entry.ampmGroup ? (m[entry.ampmGroup] ?? "").toLowerCase() : "";
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) {
    return `${date}T00:00:00Z`;
  }
  return `${date}T${pad2(hour)}:${pad2(minute)}:00Z`;
}

export interface ParseConversationOpts {
  /** Fallback `YYYY-MM-DD` for time-only formats. Default 1970-01-01. */
  dateContext?: string;
}

/**
 * Parse a chat transcript into structured messages. Each line is matched
 * against the builtin patterns in order; the first match wins. Lines that
 * match nothing are appended to the previous message's text (continuation),
 * or dropped if there is no current message. Pure, deterministic, no I/O.
 */
export function parseConversation(
  text: string,
  opts: ParseConversationOpts = {},
): ConversationMessage[] {
  const dateContext =
    opts.dateContext && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateContext)
      ? opts.dateContext
      : "1970-01-01";
  const out: ConversationMessage[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    let matched = false;
    for (const entry of BUILTIN_PATTERNS) {
      if (entry.quickReject && !entry.quickReject.test(line)) continue;
      const m = line.match(entry.regex);
      if (!m) continue;
      const speaker = cleanSpeaker(m[entry.speaker] ?? "");
      const body = (m[entry.text] ?? "").trim();
      if (!speaker) continue;
      out.push({ speaker, timestamp: toTimestamp(m, entry, dateContext), text: body });
      matched = true;
      break;
    }
    if (!matched && out.length > 0) {
      // Continuation of the previous message (a wrapped/multi-line body).
      const last = out[out.length - 1]!;
      last.text = last.text ? `${last.text}\n${line.trim()}` : line.trim();
    }
  }
  return out;
}
