/**
 * Credential / connection-info redaction for internal log + audit sinks.
 *
 * memex connects via MEMEX_POSTGRES_URL — a password-bearing DSN. A raw
 * postgres-js connection error can carry that DSN (or a bare host/IP /
 * `password=…`) into a log line or the audit JSONL. `publicSafeErrorMessage`
 * only suppresses on the PUBLIC boundary; these helpers scrub error text that
 * stays INTERNAL (operator logs, audit file). Pure, idempotent, hot-path-safe.
 */

const PG_URL_RE = /^(postgres(?:ql)?:\/\/)([^@/?]*@)?([^?]*)(\?.*)?$/i;

/** Replace userinfo in a postgres DSN with `***`; preserves host/port/db/query. */
export function redactPgUrl(url: unknown): string {
  if (typeof url !== "string" || !url) return "<redacted-url>";
  const match = url.match(PG_URL_RE);
  if (!match) return "<redacted-url>";
  const [, scheme, userinfo, hostPart, query] = match;
  const userPart = userinfo ? "***@" : "";
  return `${scheme}${userPart}${hostPart}${query ?? ""}`;
}

// Connection-info patterns scrubbed from free-text (typically error messages).
// Order matters only for readability; each is independent and /g.
const PATTERNS: { kind: string; re: RegExp }[] = [
  // Whole postgres DSN embedded in text → strip userinfo, keep the rest.
  { kind: "pgurl", re: /postgres(?:ql)?:\/\/[^\s'"]+/gi },
  { kind: "password", re: /password=[^\s'"&]+/gi },
  { kind: "user", re: /\buser=[^\s'"&]+/gi },
  // Bare IPv4 not part of a version/word context (PG error shape).
  { kind: "ipv4", re: /(?<![\w.@-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.@-])/g },
];

/** Redact connection info from arbitrary text. Pure + idempotent. */
export function redactConnectionInfo(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    if (kind === "pgurl") {
      out = out.replace(re, (m) => redactPgUrl(m));
    } else {
      out = out.replace(re, `<REDACTED:${kind}>`);
    }
  }
  return out;
}

/** Recursively redact postgres DSNs nested in a structured value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return /postgres(?:ql)?:\/\//i.test(value)
      ? (redactPgUrl(value) as unknown as T)
      : (redactConnectionInfo(value) as unknown as T);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
