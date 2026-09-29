/**
 * Conversation / chat-transcript parser — deterministic, regex-only, no LLM.
 *
 * Turns an exported chat log (iMessage, Slack, Telegram, WhatsApp, Discord,
 * IRC, or a plain "Speaker: text" transcript) into structured messages
 * `{ speaker, timestamp, text }`. memex already ingests transcript docs as
 * flat markdown chunks; this is the brain-only primitive that gives a
 * per-(speaker, timestamp, text) structure for timeline + per-person facts.
 *
 * The pure pattern core only — no optional LLM polish / LLM fallback: memex
 * routes utility work through Claude Haiku (Bedrock) and a deterministic parser
 * is the retrieval brain's job. Patterns are a curated subset covering the
 * common export formats; add entries to BUILTIN_PATTERNS as new formats appear.
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

const SPEAKER_CLEAN = /^[^\p{L}\p{N}]+/u;

function cleanSpeaker(raw: string): string {
  return raw.replace(SPEAKER_CLEAN, "").trim() || raw.trim();
}

const BUILTIN_PATTERNS: readonly PatternEntry[] = [
  {
    // **Alice** (2024-03-15 9:00 AM): hello   (iMessage / Slack export)
    id: "inline-date",
    regex:
      // Measured linear through parseConversation: 0.5 ms at 128 K, ratio 1.75-2.10
      // on a doubling. The lazy speaker run ends at the first `**`, and every
      // whitespace run downstream is separated from the next by a literal the
      // whitespace class cannot match, so no two quantifiers share a character.
      // eslint-disable-next-line regexp/no-super-linear-backtracking
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
    // The speaker run is bounded to 41 — the same cap the `plain` entry below
    // already puts on a speaker name (`[a-z][\w .'-]{0,40}`). Unbounded, the
    // leading `\s*` and the lazy speaker run trade whitespace with each other:
    // `[12:34]` + a 16 K space run and no colon measured 63 ms, ratio 3.75-4.39
    // on a doubling (quadratic). Bounded it is 40x the whitespace run, i.e.
    // linear. Only a speaker longer than 41 chars parses differently.
    // The one the rule still flags — the trailing `:\s*(.*)$` — measured linear
    // at 0.1 ms for a 128 K body run, ratio 1.32-1.88 on a doubling: `(.*)$`
    // cannot fail on a line that holds no newline, so the `\s*` never gives back.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    regex: /^\[(\d{1,2}):(\d{2})\]\s*(.{1,41}?):\s*(.*)$/,
    quickReject: /^\[/,
    speaker: 3,
    hourGroup: 1,
    minuteGroup: 2,
    text: 4,
  },
  {
    // [2024-03-15, 18:37] Alice: hi   (WhatsApp-ish)
    id: "whatsapp",
    // Two fixes over the naive form. The separator is written `(?:\s*-)?\s*`
    // instead of `\s*-?\s*` so a whitespace run has exactly one way to be
    // split, and the speaker run carries the same 41-char cap as `plain`.
    // Naive, both unbounded, this was CUBIC: a date header plus a 16 K space
    // run and no colon measured 363 s, ratio 7.08-7.70 on a doubling.
    // The one the rule still flags — the trailing `:\s*(.*)$` — measured linear
    // at 0.1 ms for a 128 K body run, ratio 1.45-1.95 on a doubling: `(.*)$`
    // cannot fail on a line that holds no newline, so the `\s*` never gives back.
    regex:
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      /^\[?(\d{4}-\d{2}-\d{2})[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\]?(?:\s*-)?\s*(.{1,41}?):\s*(.*)$/,
    speaker: 4,
    dateGroup: 1,
    hourGroup: 2,
    minuteGroup: 3,
    text: 5,
  },
  {
    // <alice> message   (IRC)
    id: "irc",
    // Measured linear through parseConversation: 0.1 ms at 128 K, ratio
    // 1.53-1.88 on a doubling. `[^>]+` stops at the first `>`, and the tail
    // `\s*(.*)$` can never fail — `.*` runs to the end of a line that, by
    // construction, holds no newline — so nothing forces the `\s*` to give back.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    regex: /^<([^>]+)>\s*(.*)$/,
    quickReject: /^</,
    speaker: 1,
    text: 2,
  },
  {
    // Alice: message   (plain transcript; tried last — most permissive)
    id: "plain",
    // Measured linear through parseConversation: 0.1 ms at 128 K, ratio
    // 0.85-1.89 on a doubling. The speaker is capped at 41 chars, so the only
    // unbounded runs are `\s+` and `.+`, and `(.+)$` cannot fail once `\s+`
    // gives back a single character.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    regex: /^([a-z][\w .'-]{0,40}):\s+(.+)$/i,
    speaker: 1,
    text: 2,
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// - **Alice** (Mon 11:18) — header of a block-format export where the message
// body follows on indented lines. Optional weekday word, optional am/pm.
// The am/pm marker carries its own leading whitespace — `(?:\s*(AM|PM…))?`
// rather than `\s*(AM|PM…)?\s*` — so the run before the closing paren has one
// way to be split instead of n. With the two `\s*` adjacent, a header with a
// 16 K space run before a non-paren measured 105 ms, ratio 3.15-5.31 on a
// doubling (quadratic), and this pattern is tested against every line twice.
const BLOCK_HEADER =
  /^[-*]\s+\*\*(.+?)\*\*\s*\(\s*(?:[A-Za-z]{2,9},?\s+)?(\d{1,2}):(\d{2})(?:\s*(AM|PM|am|pm))?\s*\)\s*$/;

/**
 * Collapse block-format transcripts — a `- **Name** (Mon 11:18)` header line
 * followed by indented body lines — into the single-line `[HH:MM] Name: body`
 * shape the builtin patterns already parse (12h converted to 24h). Trailing
 * indented body lines are left in place so the continuation fold picks them
 * up. Strict no-op: input with no block header is returned byte-identical.
 */
function normalizeBlockTranscript(text: string): string {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => BLOCK_HEADER.test(l))) return text;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(BLOCK_HEADER);
    if (!m) {
      out.push(lines[i]!);
      continue;
    }
    let hour = Number(m[2]);
    const ampm = (m[4] ?? "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    let firstBody = "";
    if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
      firstBody = lines[i + 1]!.trim();
      i++;
    }
    out.push(`[${pad2(hour)}:${m[3]}] ${m[1]!.trim()}: ${firstBody}`);
  }
  return out.join("\n");
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
  for (const rawLine of normalizeBlockTranscript(text).split(/\r?\n/)) {
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
