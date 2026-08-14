/**
 * Push-based context — pure entity-salience extractor.
 *
 * Zero-LLM, zero-DB. Scans conversation turn text for candidate entity
 * surface-forms (capitalized token runs, @handles) worth resolving against the
 * brain. The volunteer layer runs this before touching the DB, so it must be
 * fast (one regex pass per turn) and precision-biased: a false candidate costs
 * a wasted resolve and, worse, a misleading volunteered pointer.
 *
 * DELIBERATE limits (documented, not bugs):
 *   - Proper-case + ASCII biased. Misses lowercase names ("dana") and many
 *     non-Latin scripts.
 *   - extractCandidates is single-turn. extractCandidatesFromWindow widens
 *     extraction across the last N turns (assistant-introduced entities and
 *     "what about her?" follow-ups whose antecedent was NAMED in the window now
 *     resolve); true pronoun coreference remains out of scope.
 *
 * Resolution lives in reflex.ts; this module only decides WHAT to look up.
 * memex note: dedupe key is memex's `normalizeAlias` (page-aliases.ts) so the
 * candidate norm matches the resolver's lookup key exactly.
 */

import { normalizeAlias } from "../page-aliases.ts";

export interface EntityCandidate {
  /** Surface form for the pointer label, e.g. "Dana Reed" or "@dana". */
  display: string;
  /** Text fed to normalizeAlias / slugify for resolution (no @, no possessive). */
  query: string;
}

/** Max candidates per window — bounds downstream DB work regardless of cap. */
export const MAX_CANDIDATES = 12;

/**
 * HARD stopwords — function words that are never an entity, even capitalized
 * mid-sentence. Compared in lowercase.
 */
const STOPWORDS = new Set<string>([
  // pronouns
  "i", "i'm", "i've", "i'll", "you", "you're", "he", "she", "it", "it's", "we",
  "we're", "they", "they're", "me", "him", "her", "us", "them", "my", "your",
  "his", "their", "our", "mine", "yours", "hers", "theirs", "ours", "this",
  "that", "these", "those", "who", "whom",
  // articles / determiners / conjunctions / prepositions (common openers)
  "the", "a", "an", "and", "or", "but", "so", "if", "as", "at", "by", "for",
  "in", "of", "on", "to", "up", "with", "from", "into", "over", "than", "then",
  "also", "just",
  // question words / auxiliaries
  "what", "when", "where", "why", "how", "which", "whose",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "do", "does", "did", "is", "are", "am", "was", "were", "be", "been", "being",
  "has", "have", "had",
  // greetings / discourse markers / polite openers
  "hi", "hey", "hello", "thanks", "thank", "please", "yes", "no", "ok", "okay",
  "sure", "maybe", "well", "oh", "let", "let's", "lets",
]);

/**
 * SOFT common words — frequent non-entity words that DO get capitalized at
 * sentence start. Dropped only when a single-token candidate appears solely at
 * sentence start (and is never seen capitalized mid-sentence, a strong name
 * signal). Compared lowercase.
 */
const COMMON_WORDS = new Set<string>([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "today", "tomorrow", "yesterday", "now", "soon", "later", "tonight",
  "morning", "afternoon", "evening", "week", "month", "year", "meeting",
  "call", "note", "task", "here", "there", "every", "some", "any", "all",
  "one", "two", "three", "first", "last", "next", "new", "old", "good", "bad",
  "great", "nice", "thing", "something", "anything",
]);

const HANDLE_RE = /@(\w{2,})/g;
// Capitalized token runs: an uppercase-initial word, up to 4 tokens total.
// A token allows internal letters/digits/apostrophes/hyphens, plus internal
// dots ONLY when followed by a letter (so "U.S." keeps its dot but a
// sentence-ending "Apple." does NOT glue into the next sentence's word).
const CAP_TOKEN = "\\p{Lu}[\\p{L}0-9'\\u2019\\-]*(?:\\.\\p{L}[\\p{L}0-9'\\u2019\\-]*)*";
const CAP_RUN_RE = new RegExp(`${CAP_TOKEN}(?:\\s+${CAP_TOKEN}){0,3}`, "gu");

/** Strip a trailing possessive ("Dana's" -> "Dana", "Jones'" -> "Jones"). */
function stripPossessive(s: string): string {
  return s.replace(/['\u2019]s$/i, "").replace(/['\u2019]$/, "");
}

/** True when the match at `idx` is the first non-space char of text/sentence. */
function isAtSentenceStart(text: string, idx: number): boolean {
  let i = idx - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === undefined || !/\s/.test(ch)) break;
    i--;
  }
  if (i < 0) return true; // start of text
  const prev = text[i];
  if (prev === undefined) return true;
  // sentence-ending punctuation (or a list bullet / opening bracket) precedes
  return /[.!?:;\n\r\u2022\-(["\u201C]/.test(prev);
}

function isPureNumber(s: string): boolean {
  return /^\d[\d.,]*$/.test(s);
}

/**
 * Extract candidate entity surface-forms from one turn's text. Deterministic,
 * precision-biased, capped at MAX_CANDIDATES. Deduped on normalizeAlias()
 * (so "Dana" and "dana" collapse), first display wins.
 */
export function extractCandidates(text: string): EntityCandidate[] {
  if (!text || typeof text !== "string") return [];

  interface Acc {
    display: string;
    query: string;
    multiToken: boolean;
    seenMidSentence: boolean;
    order: number;
  }
  const acc = new Map<string, Acc>();
  let order = 0;

  const consider = (rawDisplay: string, rawQuery: string, midSentence: boolean) => {
    const display = rawDisplay.trim();
    const query = stripPossessive(rawQuery.trim());
    if (!query) return;
    const norm = normalizeAlias(query);
    if (!norm) return;
    const existing = acc.get(norm);
    if (existing) {
      if (midSentence) existing.seenMidSentence = true;
      return;
    }
    acc.set(norm, {
      display,
      query,
      multiToken: /\s/.test(query),
      seenMidSentence: midSentence,
      order: order++,
    });
  };

  // 1. @handles — strong signal; resolved as aliases. Display keeps the @.
  for (const m of text.matchAll(HANDLE_RE)) {
    const handle = m[1];
    if (handle === undefined) continue;
    // handles are intentional references — treat as mid-sentence (never dropped
    // on the sentence-start heuristic).
    consider(`@${handle}`, handle, true);
  }

  // 2. Capitalized token runs.
  for (const m of text.matchAll(CAP_RUN_RE)) {
    const surface = m[0];
    const idx = m.index ?? 0;
    consider(surface, surface, !isAtSentenceStart(text, idx));
  }

  // 3. Filter for precision.
  const out: EntityCandidate[] = [];
  for (const c of Array.from(acc.values()).sort((a, b) => a.order - b.order)) {
    const lc = c.query.toLowerCase();
    // Single bare tokens get the strict filters; multi-token runs are inherently
    // high-signal and skip the soft list.
    if (!c.multiToken) {
      if (c.query.length < 2) continue; // single char
      if (isPureNumber(c.query)) continue; // "2026"
      if (STOPWORDS.has(lc)) continue; // hard: never an entity
      // soft: common word AND only seen at sentence start -> drop. If it also
      // appeared capitalized mid-sentence, keep it (likely a real name).
      if (COMMON_WORDS.has(lc) && !c.seenMidSentence) continue;
    }
    out.push({ display: c.display, query: c.query });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

// -- Rolling-window extraction (push-based context) ------------------------

export interface WindowTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * A window candidate with the salience metadata the volunteer layer's
 * confidence boost reads: how many turns mentioned it, whether the NEWEST turn
 * did, and whether the USER (vs only the assistant) ever said it.
 */
export interface WindowEntityCandidate extends EntityCandidate {
  /** Number of distinct turns that mentioned this candidate. */
  occurrences: number;
  /** Mentioned in the newest (last) turn of the window. */
  inNewestTurn: boolean;
  /** Mentioned in at least one USER turn (assistant-only mentions rank lower). */
  userMention: boolean;
}

/**
 * Extract candidates across the last N turns (oldest -> newest). Pure,
 * zero-LLM: runs the per-turn extractor on each turn and merges by the
 * normalizeAlias form. Ordering is salience-aware — recency of last mention,
 * cross-turn frequency, and a user-role boost — so when the merged set exceeds
 * MAX_CANDIDATES, the dropped tail is the stalest assistant-only chatter, not
 * the entity the user just named.
 */
export function extractCandidatesFromWindow(
  turns: WindowTurn[],
): WindowEntityCandidate[] {
  if (!turns?.length) return [];
  interface WAcc extends WindowEntityCandidate {
    lastTurnIdx: number;
    order: number;
  }
  const acc = new Map<string, WAcc>();
  let order = 0;
  const lastIdx = turns.length - 1;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn?.text) continue;
    for (const c of extractCandidates(turn.text)) {
      const norm = normalizeAlias(c.query);
      if (!norm) continue;
      const existing = acc.get(norm);
      if (existing) {
        existing.occurrences += 1;
        existing.lastTurnIdx = i;
        existing.inNewestTurn = existing.inNewestTurn || i === lastIdx;
        if (turn.role === "user" && !existing.userMention) {
          // First USER-said surface form beats an assistant-introduced one
          // for the display label.
          existing.display = c.display;
          existing.userMention = true;
        }
      } else {
        acc.set(norm, {
          display: c.display,
          query: c.query,
          occurrences: 1,
          lastTurnIdx: i,
          inNewestTurn: i === lastIdx,
          userMention: turn.role === "user",
          order: order++,
        });
      }
    }
  }

  // Salience weight: recency dominates, then frequency, then user-role.
  // Deterministic tie-break on first-seen order.
  const weight = (c: WAcc) =>
    (c.lastTurnIdx + 1) / turns.length +
    Math.min(c.occurrences, 4) * 0.1 +
    (c.userMention ? 0.15 : 0);
  return Array.from(acc.values())
    .sort((a, b) => weight(b) - weight(a) || a.order - b.order)
    .slice(0, MAX_CANDIDATES)
    .map(({ lastTurnIdx: _l, order: _o, ...rest }) => rest);
}
