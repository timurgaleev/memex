/**
 * PII scrubber for eval-capture rows.
 *
 * The bar is "good enough for a single-user RDS reachable only by the
 * operator" — not GDPR-compliant universal PII detection. We mask the
 * high-value accidental leaks (an email pasted into chat, a phone
 * number) while leaving topic words alone so eval-replay still
 * measures ranking quality, not "how well does keyword search retrieve
 * `[email]`".
 *
 * Order matters: longer / more specific patterns run first so a credit
 * card doesn't get partly-eaten by a phone-number regex.
 *
 * Categories masked:
 *   - email           → [email]
 *   - Bearer token    → [token]  (Authorization: Bearer <opaque>)
 *   - JWT             → [token]  (three base64url segments joined by '.')
 *   - phone (intl)    → [phone]
 *   - phone (national 7+ digits, hyphenated/spaced) → [phone]
 *   - IBAN (EU)       → [iban]
 *   - credit card     → [card]
 *   - IPv4 / IPv6     → [ip]
 *
 * Categories NOT masked (intentionally — break eval signal):
 *   - names of people, project codenames, file paths
 *   - dates, ISO timestamps
 *   - URLs (pattern is too entangled with technical terms; reconsider
 *     if Gmail body ingestion lands)
 */

export interface ScrubResult {
  /** Masked text. */
  text: string;
  /** Counts per category — surfaced for telemetry/test assertions. */
  counts: Record<string, number>;
}

interface Pattern {
  name: string;
  regex: RegExp;
  placeholder: string;
}

// Each `regex` is anchored with word-ish boundaries so we don't gobble
// surrounding context. Keep `g` flag — replaceAll uses it.
const PATTERNS: Pattern[] = [
  {
    name: "email",
    // Conservative: ASCII local part, dot in domain, 2+ char TLD.
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: "[email]",
  },
  {
    // Bearer runs before JWT so `Bearer <jwt>` masks whole; the token
    // charset excludes the `[`/`]` a prior placeholder would leave.
    name: "bearer",
    regex: /\b(?:bearer|Bearer)\s+[A-Za-z0-9._~+/-]{10,}=*/g,
    placeholder: "[token]",
  },
  {
    // JWT: three base64url segments, distinctive `eyJ` header prefix.
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    placeholder: "[token]",
  },
  {
    name: "iban",
    // Two-letter country code + 2 check digits + 11–30 alphanumerics.
    // Permits the optional space-separated grouping common in printed form.
    regex: /\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]{2,4}){2,7}\b/g,
    placeholder: "[iban]",
  },
  {
    name: "card",
    // 13–19 digits in 4-digit groups separated by space or dash, OR a
    // run of 13-19 contiguous digits. Skips Luhn — the false-positive
    // cost is minor (a long unrelated number gets masked) and the
    // false-negative cost (a real card slips through) is the one we
    // care about reducing.
    regex:
      /\b(?:\d[ -]?){12,18}\d\b/g,
    placeholder: "[card]",
  },
  {
    name: "phone",
    // International (+ then 7-15 digits with optional spacing/hyphens).
    regex: /\+\d[\d\s-]{6,14}\d/g,
    placeholder: "[phone]",
  },
  {
    name: "phone",
    // National (7+ digits with at least one separator) — matches
    // 030 1234 5678, (089) 123-4567, etc. We require ≥1 space/hyphen
    // to avoid eating standalone numeric IDs. Negative lookahead
    // skips ISO-8601 dates (`YYYY-MM-DD`) which would otherwise look
    // like a 4-2-2 phone group.
    regex:
      /\b(?!\d{4}-\d{2}-\d{2}\b)\d{2,4}[ -]\d{2,4}[ -]\d{2,5}\b/g,
    placeholder: "[phone]",
  },
  {
    name: "ip",
    // IPv4. Loose — doesn't validate octet ranges; that's fine for masking.
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    placeholder: "[ip]",
  },
  {
    name: "ip",
    // IPv6. Match the common forms (full + ::-collapsed). Conservative
    // about minimum 2 groups so we don't catch bare hex.
    regex:
      /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{0,4}\b/g,
    placeholder: "[ip]",
  },
];

export function scrubPii(input: string): ScrubResult {
  if (typeof input !== "string" || input.length === 0) {
    return { text: input ?? "", counts: {} };
  }
  const counts: Record<string, number> = {};
  let text = input;
  for (const p of PATTERNS) {
    let hits = 0;
    text = text.replace(p.regex, () => {
      hits++;
      return p.placeholder;
    });
    if (hits > 0) {
      counts[p.name] = (counts[p.name] ?? 0) + hits;
    }
  }
  return { text, counts };
}

/**
 * Convenience — returns just the masked text. Use this in hot paths
 * where the count detail isn't needed.
 */
export function scrub(input: string): string {
  return scrubPii(input).text;
}
