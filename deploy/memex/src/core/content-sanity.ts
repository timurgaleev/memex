/**
 * Content-sanity gate — the deterministic, free WRITER that stamps the
 * quarantine / content_flag / embed_skip markers the read side already honors
 * (`quarantine.ts`, `embed-skip.ts`, `search/content-flag.ts`, `visibility.ts`).
 *
 * Without this writer nothing marks scraper junk, oversize dumps, or
 * markup-heavy boilerplate — it all enters the vector index unimpeded. This
 * module closes that gap at the single ingest chokepoint (`indexer.ts`
 * `indexDocument`, which every path routes through).
 *
 * Two failure modes, treated differently:
 *   - **Scraper junk** (built-in pattern OR operator literal) → HIDE. The
 *     caller stamps the `quarantine` marker (visibility filter drops it from
 *     search) and `embed_skip` (so no Titan spend is wasted on a hidden page).
 *     When the operator opts into `reject` disposition the caller throws a
 *     `ContentSanityBlockError` instead — an explicit, non-default error path.
 *   - **Oversize** (bytes > block threshold WITHOUT a junk match) → SOFT-BLOCK.
 *     The caller stamps `embed_skip` (the page lands, stays keyword-searchable,
 *     never embeds) plus a `content_flag` so the agent sees why it is not in the
 *     vector arm. Legitimate large content (long transcripts) is preserved.
 *   - **Markup-heavy** (markup ratio over threshold, warn-tier window, non-code)
 *     → FLAG. The caller stamps `content_flag: {reason: 'markup_heavy', ...}`.
 *     The page stays fully searchable; the agent just gets a "looks like
 *     boilerplate" warning. Conservative on purpose — a false positive costs a
 *     one-line note, not a vanished page.
 *
 * The assessor is a PURE function (no DB, no FS, no env) so unit tests don't
 * touch process state. The env resolvers and the frontmatter stamper live here
 * too but stay side-effect-free; the throw-vs-hide disposition decision is the
 * CALLER's (indexer's) so the assessor never surprises a consumer.
 */

import { readFileSync } from "node:fs";

/** Bytes of body scanned for pattern matches. Junk interstitials carry their
 *  telltale text at the top, so an O(2KB) head-slice covers the realistic
 *  cases regardless of page size. */
export const SCAN_HEAD_BYTES = 2048;

/** Above this the page still lands, but crosses into the markup prose-check
 *  window. Override via `MEMEX_PAGE_WARN_BYTES`. */
export const DEFAULT_BYTES_WARN = 50_000;

/** Above this the page lands but is never embedded (soft-block). Override via
 *  `MEMEX_PAGE_BLOCK_BYTES`. */
export const DEFAULT_BYTES_BLOCK = 500_000;

/** Above this markup ratio the page is flagged (not hidden). Override via
 *  `MEMEX_MAX_MARKUP_RATIO`. */
export const DEFAULT_MAX_MARKUP_RATIO = 0.85;

/** Stable token embedded in junk-reason messages so error/audit surfaces can
 *  group hard-blocks under one code. */
export const PAGE_JUNK_PATTERN_CODE = "PAGE_JUNK_PATTERN";

export type SanityTripReason =
  | "oversize_warn"
  | "oversize_block"
  | "high_markup"
  | "junk_pattern"
  | "literal_substring";

export interface JunkPattern {
  /** Stable snake_case identifier surfaced in reason messages + markers. */
  name: string;
  /** Case-insensitive regex, cost bounded by SCAN_HEAD_BYTES. */
  pattern: RegExp;
  /** Scope. Defaults to 'both' (title AND body head-slice). */
  applies_to?: "body" | "title" | "both";
}

export interface OperatorLiteral {
  name: string;
  /** Literal substring, case-insensitive. Regex meta-characters stay literal. */
  substring: string;
  applies_to?: "body" | "title" | "both";
}

export interface ContentSanityResult {
  /** UTF-8 byte length of the scanned body. */
  bytes: number;
  /** True when bytes exceed the block threshold. */
  oversize: boolean;
  junk_pattern_matches: string[];
  literal_substring_matches: string[];
  /** Prose char count after markup-strip; null when the prose pass didn't run. */
  prose_chars: number | null;
  /** Markup:total ratio in [0, 1]; null when the prose pass didn't run. */
  markup_ratio: number | null;
  reasons: SanityTripReason[];
  reason_messages: string[];
  /** High-confidence junk fired → hide (or reject). */
  shouldQuarantine: boolean;
  /** Fuzzy/oversize "warn but keep usable" tier fired. */
  shouldFlag: boolean;
  /** Which flag tier: markup_heavy | oversized. Null when shouldFlag is false. */
  flag_reason: "markup_heavy" | "oversized" | null;
  /** Oversize without quarantine → write with embed_skip. */
  shouldSkipEmbed: boolean;
}

/** Built-in scraper-junk pattern set. Hand-vetted, compiled once. */
export const BUILT_IN_JUNK_PATTERNS: ReadonlyArray<JunkPattern> = Object.freeze([
  // Cloudflare interstitials — the dominant scraper-junk class.
  {
    name: "cloudflare_attention_required",
    pattern: /attention required.*cloudflare/i,
    applies_to: "both",
  },
  {
    // Both signals required — "just a moment..." alone fires on legitimate
    // writing; the challenge URL is the discriminator.
    name: "cloudflare_just_a_moment",
    pattern: /just a moment\.\.\.[\s\S]{0,500}cdn-cgi\/challenge-platform/i,
    applies_to: "body",
  },
  {
    name: "cloudflare_ray_id",
    pattern: /cloudflare ray id:/i,
    applies_to: "body",
  },
  {
    name: "cloudflare_checking_browser",
    pattern: /checking your browser before/i,
    applies_to: "both",
  },
  {
    name: "cf_browser_verification",
    pattern: /cf[-_]browser[-_]verification/i,
    applies_to: "both",
  },
  {
    name: "enable_javascript_cookies",
    pattern: /enable javascript and cookies to continue/i,
    applies_to: "both",
  },
  // Generic 403 / blocked-access pages.
  {
    name: "access_denied",
    pattern: /^\s*access denied\b/im,
    applies_to: "both",
  },
  // CAPTCHA gates.
  {
    name: "captcha_required",
    pattern: /verify you are (a )?human|captcha required|please complete the security check/i,
    applies_to: "both",
  },
  // Bare error-page titles. Anchored so a thoughtful page ABOUT 404s or one
  // titled "How to Handle Access Denied Errors" won't trip.
  {
    name: "error_page_title",
    pattern: /^(403|404|500|502|503|error \d{3}|page not found|forbidden|access denied|service unavailable|robot check|verify you are human)\s*$/i,
    applies_to: "title",
  },
  // Cloudflare challenge title (companion to the body-scoped pattern above).
  {
    name: "cloudflare_challenge_title",
    pattern: /^just a moment\.{0,3}$/i,
    applies_to: "title",
  },
]);

/**
 * Tagged error the caller throws on hard-block (reject disposition). Message
 * embeds the reason messages (already prefixed with the stable code token) so a
 * classifier can pick it up without a structured field.
 */
export class ContentSanityBlockError extends Error {
  readonly code = PAGE_JUNK_PATTERN_CODE;
  readonly result: ContentSanityResult;

  constructor(result: ContentSanityResult) {
    super(`Content rejected by sanity gate: ${result.reason_messages.join("; ")}`);
    this.name = "ContentSanityBlockError";
    this.result = result;
  }
}

export interface ProseAssessment {
  prose_chars: number;
  total_chars: number;
  markup_ratio: number;
}

// Code (fenced + inline) is stripped FIRST and excluded from the denominator
// entirely — a code-heavy doc must not read as high-markup. Remaining strips
// count toward markup.
const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
// Keep anchor text, drop the URL: [text](url) -> text
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const MD_STRUCT_RE = /^[ \t]*(#{1,6}\s|[-*+]\s|>\s|\|.*\||[-=]{3,}\s*$|\d+\.\s)/gm;
const MD_EMPHASIS_RE = /[*_~]{1,3}/g;
const TABLE_PIPE_RE = /\|/g;

/**
 * Pure prose-vs-markup heuristic. Strips code (excluded from the ratio), then
 * measures how much of the REMAINING content is markup syntax vs sentences.
 * Returns a ratio in [0, 1]; high = boilerplate/nav shape. Not a parser.
 */
export function assessProse(body: string): ProseAssessment {
  const noCode = body.replace(FENCED_CODE_RE, " ").replace(INLINE_CODE_RE, " ");
  const total_chars = noCode.replace(/\s+/g, "").length;
  if (total_chars === 0) {
    return { prose_chars: 0, total_chars: 0, markup_ratio: 0 };
  }
  // Order matters: images before links (image syntax is a superset).
  const prose = noCode
    .replace(MD_IMAGE_RE, " ")
    .replace(MD_LINK_RE, "$1")
    .replace(HTML_TAG_RE, " ")
    .replace(MD_STRUCT_RE, " ")
    .replace(TABLE_PIPE_RE, " ")
    .replace(MD_EMPHASIS_RE, " ");
  const prose_chars = prose.replace(/\s+/g, "").length;
  const ratio = Math.min(1, Math.max(0, (total_chars - prose_chars) / total_chars));
  return { prose_chars, total_chars, markup_ratio: ratio };
}

/**
 * Assess a document body + title against the size, junk-pattern, and prose
 * surfaces. Pure — same inputs always produce the same outputs. The caller
 * decides disposition from the boolean verdicts.
 */
export function assessContentSanity(opts: {
  /** Body scanned + measured (post-chunk join, frontmatter excluded). */
  body: string;
  /** Document title — some patterns key on title alone. */
  title: string;
  bytes_warn?: number;
  bytes_block?: number;
  max_markup_ratio?: number;
  /** Master switch for the prose/markup pass. Default true. */
  prose_check_enabled?: boolean;
  /** `'code'` pages are exempt from the prose pass (they read as high-markup). */
  page_kind?: string;
  /** Operator literal substrings evaluated alongside the built-ins. */
  extra_literals?: ReadonlyArray<OperatorLiteral>;
}): ContentSanityResult {
  const bytes_warn = opts.bytes_warn ?? DEFAULT_BYTES_WARN;
  const bytes_block = opts.bytes_block ?? DEFAULT_BYTES_BLOCK;
  const max_markup_ratio = opts.max_markup_ratio ?? DEFAULT_MAX_MARKUP_RATIO;
  const prose_check_enabled = opts.prose_check_enabled !== false;

  const body = opts.body ?? "";
  const bytes = Buffer.byteLength(body, "utf-8");
  const oversize = bytes > bytes_block;

  const bodyHead = body.slice(0, SCAN_HEAD_BYTES);
  const bodyHeadLower = bodyHead.toLowerCase();
  // Defensive coercion: a malformed YAML title could arrive non-string. Never
  // throw on a bad title.
  const title = String(opts.title ?? "");
  const titleLower = title.toLowerCase();

  const junk_pattern_matches: string[] = [];
  for (const p of BUILT_IN_JUNK_PATTERNS) {
    const scope = p.applies_to ?? "both";
    let matched = false;
    if (scope === "title" || scope === "both") {
      if (p.pattern.test(title)) matched = true;
    }
    if (!matched && (scope === "body" || scope === "both")) {
      if (p.pattern.test(bodyHead)) matched = true;
    }
    if (matched) junk_pattern_matches.push(p.name);
  }

  const literal_substring_matches: string[] = [];
  if (opts.extra_literals) {
    for (const lit of opts.extra_literals) {
      const scope = lit.applies_to ?? "both";
      const needle = lit.substring.toLowerCase();
      if (needle.length === 0) continue;
      let matched = false;
      if (scope === "title" || scope === "both") {
        if (titleLower.includes(needle)) matched = true;
      }
      if (!matched && (scope === "body" || scope === "both")) {
        if (bodyHeadLower.includes(needle)) matched = true;
      }
      if (matched) literal_substring_matches.push(lit.name);
    }
  }

  // Prose/markup pass — ONLY in the warn-tier window, only when enabled, only
  // for non-code pages. Tiny legit pages never enter it, so they can't be
  // flagged on low prose; oversize pages take the soft-block path instead.
  let prose_chars: number | null = null;
  let markup_ratio: number | null = null;
  let high_markup = false;
  const inProseWindow = bytes > bytes_warn && bytes <= bytes_block;
  if (prose_check_enabled && inProseWindow && opts.page_kind !== "code") {
    const prose = assessProse(body);
    prose_chars = prose.prose_chars;
    markup_ratio = prose.markup_ratio;
    high_markup = markup_ratio > max_markup_ratio;
  }

  const shouldQuarantine =
    junk_pattern_matches.length > 0 || literal_substring_matches.length > 0;
  // When BOTH oversize and junk fire, quarantine wins (no embed either way).
  const shouldSkipEmbed = oversize && !shouldQuarantine;
  const shouldFlag = !shouldQuarantine && (high_markup || shouldSkipEmbed);
  const flag_reason: "markup_heavy" | "oversized" | null = !shouldFlag
    ? null
    : high_markup
      ? "markup_heavy"
      : "oversized";

  const reasons: SanityTripReason[] = [];
  const reason_messages: string[] = [];
  if (oversize) {
    reasons.push("oversize_block");
    reason_messages.push(
      `PAGE_OVERSIZED: body ${bytes} bytes exceeds ${bytes_block} byte block threshold`,
    );
  } else if (bytes > bytes_warn) {
    reasons.push("oversize_warn");
    reason_messages.push(
      `PAGE_OVERSIZE_WARN: body ${bytes} bytes exceeds ${bytes_warn} byte warn threshold`,
    );
  }
  if (high_markup) {
    reasons.push("high_markup");
    reason_messages.push(
      `PAGE_MARKUP_HEAVY: markup ratio ${markup_ratio!.toFixed(2)} exceeds ${max_markup_ratio} (flag, not hide)`,
    );
  }
  if (junk_pattern_matches.length > 0) {
    reasons.push("junk_pattern");
    reason_messages.push(
      `${PAGE_JUNK_PATTERN_CODE}: matched built-in pattern(s): ${junk_pattern_matches.join(", ")}`,
    );
  }
  if (literal_substring_matches.length > 0) {
    reasons.push("literal_substring");
    reason_messages.push(
      `${PAGE_JUNK_PATTERN_CODE}: matched operator literal(s): ${literal_substring_matches.join(", ")}`,
    );
  }

  return {
    bytes,
    oversize,
    junk_pattern_matches,
    literal_substring_matches,
    prose_chars,
    markup_ratio,
    reasons,
    reason_messages,
    shouldQuarantine,
    shouldFlag,
    flag_reason,
    shouldSkipEmbed,
  };
}

// --- Env resolvers + frontmatter stamper -----------------------------------

/** Kill switch. The gate runs unless `MEMEX_NO_SANITY` is set truthy. */
export function sanityGateEnabled(
  raw: string | undefined = process.env["MEMEX_NO_SANITY"],
): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return !(v === "1" || v === "true");
}

/**
 * How to dispose of high-confidence junk. Default `quarantine` (hide + skip
 * embed, non-fatal). `reject` makes the caller throw `ContentSanityBlockError`
 * — the explicit hard-block error path.
 */
export function sanityDisposition(
  raw: string | undefined = process.env["MEMEX_SANITY_DISPOSITION"],
): "quarantine" | "reject" {
  return (raw ?? "").trim().toLowerCase() === "reject" ? "reject" : "quarantine";
}

/** Positive-integer env override, else the default. */
function resolveBytes(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Load the operator's junk-substring list from the file named by
 * `MEMEX_SANITY_LITERALS_FILE` (one case-insensitive literal per line; blank
 * lines and `#` comments skipped). Each becomes an OperatorLiteral scanned in
 * BOTH title and body, so a site-specific boilerplate string the built-in
 * patterns miss still quarantines. Fail-open: an unset var or an unreadable file
 * yields no literals — this must never break ingest. Memoized per (path) so the
 * file is read once, not on every page.
 */
let _literalsCache: { path: string; literals: OperatorLiteral[] } | null = null;
export function resolveOperatorLiterals(
  path: string | undefined = process.env["MEMEX_SANITY_LITERALS_FILE"],
): OperatorLiteral[] {
  const p = (path ?? "").trim();
  if (!p) return [];
  if (_literalsCache?.path === p) return _literalsCache.literals;
  let literals: OperatorLiteral[] = [];
  try {
    const raw = readFileSync(p, "utf-8");
    literals = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((substring, i) => ({
        name: `operator_literal_${i + 1}`,
        substring,
        applies_to: "both" as const,
      }));
  } catch {
    literals = []; // unreadable/missing → no literals, ingest continues
  }
  _literalsCache = { path: p, literals };
  return literals;
}

/** Resolve effective thresholds from the env (call-site override for tests). */
export function resolveSanityThresholds(env: NodeJS.ProcessEnv = process.env): {
  bytes_warn: number;
  bytes_block: number;
  max_markup_ratio: number;
} {
  const ratio = Number((env["MEMEX_MAX_MARKUP_RATIO"] ?? "").trim());
  return {
    bytes_warn: resolveBytes(env["MEMEX_PAGE_WARN_BYTES"], DEFAULT_BYTES_WARN),
    bytes_block: resolveBytes(env["MEMEX_PAGE_BLOCK_BYTES"], DEFAULT_BYTES_BLOCK),
    max_markup_ratio:
      Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_MAX_MARKUP_RATIO,
  };
}

/**
 * Return a NEW frontmatter object with the sanity markers stamped from a
 * result. Immutable — never mutates the input. Marker VALUES are diagnostic
 * `{reason, detail}` objects; the read side keys on existence for
 * quarantine/embed_skip and on `content_flag.reason`/`.detail` for the WARN
 * channel, so the shapes here match `search/content-flag.ts`.
 *
 * Precedence mirrors the read side: quarantine (hide) also stamps embed_skip so
 * no Titan spend is wasted on a hidden page; oversize soft-block stamps
 * embed_skip + a content_flag; markup-heavy stamps a content_flag only.
 */
export function stampSanityMarkers(
  frontmatter: Record<string, unknown>,
  result: ContentSanityResult,
): Record<string, unknown> {
  if (result.shouldQuarantine) {
    const reason =
      result.junk_pattern_matches.length > 0 ? "junk_pattern" : "literal_substring";
    const detail = [...result.junk_pattern_matches, ...result.literal_substring_matches].join(
      ", ",
    );
    return {
      ...frontmatter,
      quarantine: { reason, detail },
      embed_skip: { reason, detail },
    };
  }
  if (result.shouldSkipEmbed) {
    const detail = `body ${result.bytes} bytes exceeds block threshold`;
    return {
      ...frontmatter,
      embed_skip: { reason: "oversized", detail },
      content_flag: { reason: "oversized", detail },
    };
  }
  if (result.shouldFlag && result.flag_reason === "markup_heavy") {
    const detail =
      result.markup_ratio !== null
        ? `markup ratio ${result.markup_ratio.toFixed(2)} exceeds threshold`
        : "markup-heavy";
    return {
      ...frontmatter,
      content_flag: { reason: "markup_heavy", detail },
    };
  }
  return frontmatter;
}
