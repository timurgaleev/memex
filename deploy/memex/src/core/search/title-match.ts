/**
 * title-match.ts — title-phrase matching for the title boost.
 *
 * Title-superstring matching. The disease it cures: a query that is literally
 * a phrase from a page's title ("memex master plan" → page titled "Memex —
 * master plan") matching a weak body chunk instead of being recognized as a
 * title hit. Names of things deserve weight.
 *
 * Pure + zero-I/O so the production boost, the evidence classifier, and the
 * unit tests share ONE definition (no drift). Deterministic text matching, so
 * unlike score thresholds there is no score-scale concern here (a multiplier is
 * scale-invariant; see `resolveTitleBoost` below).
 *
 * Guard rails (avoid promoting generic pages on stopword-y queries):
 *   - require >= MIN_CONTENT_TOKENS non-stopword tokens in the query, OR an
 *     exact normalized full-title match (so a deliberate 1-word title still hits);
 *   - match at TOKEN BOUNDARIES (contiguous token run), never raw substring, so
 *     "art" doesn't match "Bartholomew";
 *   - stopwords ("the", "a", "of", …) don't count toward the content-token floor.
 */

const MIN_CONTENT_TOKENS = 2;

/** Default title-phrase boost multiplier (scale-invariant ratio). */
export const DEFAULT_TITLE_BOOST = 1.25;

// Small, deliberately conservative English stopword set. CJK has no whitespace
// stopword notion here; CJK queries fall through to the exact-match path.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with",
  "at", "by", "from", "as", "is", "it", "this", "that", "my", "your",
]);

/**
 * Normalize text to a token array: lowercase, NFKC, split on any run of
 * non-alphanumeric (Unicode-aware for letters/numbers), drop empties. CJK
 * characters are letters under \p{L}, so a CJK title collapses to one token
 * per contiguous run — fine for the exact-match path.
 */
export function tokenizeTitle(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Content tokens = tokens that aren't stopwords. */
function contentTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/** True iff `needle` appears as a contiguous token run inside `haystack`. */
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Decide whether `query` is a title-phrase match for `title`.
 *
 * Returns true when EITHER:
 *   (a) the normalized query token sequence is a contiguous run inside the
 *       normalized title AND the query has >= MIN_CONTENT_TOKENS content tokens; OR
 *   (b) the normalized query equals the full normalized title exactly (covers
 *       deliberate single-word titles / chosen names).
 *
 * Order-insensitive matching is intentionally NOT done — a title-phrase signal
 * should reflect the author's phrasing; bag-of-words matching is what the
 * vector/keyword arms already provide.
 */
export function isTitlePhraseMatch(query: string, title: string | null | undefined): boolean {
  if (!title) return false;
  const qTokens = tokenizeTitle(query);
  const tTokens = tokenizeTitle(title);
  if (qTokens.length === 0 || tTokens.length === 0) return false;

  // (b) exact full-title match (covers 1-word chosen names).
  if (qTokens.length === tTokens.length && qTokens.every((t, i) => t === tTokens[i])) {
    return true;
  }

  // (a) contiguous phrase match, gated by content-token floor.
  const qContent = contentTokens(qTokens);
  if (qContent.length < MIN_CONTENT_TOKENS) return false;
  return containsTokenRun(tTokens, qTokens);
}

/**
 * Resolve the title-boost factor from `MEMEX_TITLE_BOOST` (default 1.25, ON).
 * A multiplier is scale-invariant, so it applies cleanly onto memex's RRF
 * score. A value <= 1.0 disables the boost
 * (the multiplier becomes a no-op). Malformed env → throw (fail-loud), matching
 * the recency-decay parse contract.
 */
export class TitleBoostParseError extends Error {}

export function resolveTitleBoost(
  envValue: string | undefined = process.env["MEMEX_TITLE_BOOST"],
): number {
  if (envValue === undefined || envValue.trim() === "") return DEFAULT_TITLE_BOOST;
  const raw = envValue.trim();
  // Strict numeric: reject trailing junk (parseFloat("1.2x") would yield 1.2).
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new TitleBoostParseError(`invalid MEMEX_TITLE_BOOST: ${JSON.stringify(envValue)}`);
  }
  const factor = Number.parseFloat(raw);
  if (!Number.isFinite(factor) || factor < 0) {
    throw new TitleBoostParseError(`invalid MEMEX_TITLE_BOOST: ${JSON.stringify(envValue)}`);
  }
  // A factor in (0, 1) is a no-op, not a penalty: the boost only ever
  // multiplies UP (the apply site gates on `> 1.0`), so a fractional value is
  // silently inert. Warn so an operator who set `0.8` expecting a mild boost
  // isn't surprised by zero effect. 0 (explicit disable) and 1.0 (neutral) are
  // intentional and stay quiet.
  if (factor > 0 && factor < 1.0) {
    console.warn(
      `MEMEX_TITLE_BOOST=${raw} is < 1.0 and has no effect (the title boost only ` +
        `multiplies up; use >= 1.0 to boost, or 0 to disable).`,
    );
  }
  return factor;
}

// Title-boost factor memoized once per process (fail-loud parse on first use),
// so the ranking path AND the query-cache key read the SAME value. Without a
// single source they could diverge: rankingSignature() re-reading the env while
// ranking uses a memoized value would key as a new boost but rank with the old
// one. A new value requires a process restart (env is set at container boot) —
// same contract as the recency-decay map.
let _titleBoost: number | null = null;
export function getTitleBoost(): number {
  return (_titleBoost ??= resolveTitleBoost());
}

// Exported for unit tests.
export const __test__ = { tokenizeTitle, contentTokens, containsTokenRun, STOPWORDS, MIN_CONTENT_TOKENS };
