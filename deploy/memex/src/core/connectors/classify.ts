/**
 * Map a provider response to what it means for the run. Pure: the status code,
 * the response headers and the first bytes of the body are all it looks at, so
 * each class can be pinned by a recorded response.
 *
 * GitHub answers a secondary rate limit with a 403, the same code as a real
 * permission failure; the rate-limit headers and the message tell them apart.
 * A 200 carrying HTML is a challenge or captive-portal page, not data. Body
 * checks are substring searches over a bounded prefix, never a regex.
 */
import type { ResponseClass } from "./types.ts";

/** How much of a body the classifier reads. */
export const CLASSIFY_BODY_PREFIX = 2048;

export interface HeaderLookup {
  get(name: string): string | null;
}

function isRateLimit403(headers: HeaderLookup, lowerBody: string): boolean {
  if (headers.get("x-ratelimit-remaining")?.trim() === "0") return true;
  if (headers.get("retry-after") !== null) return true;
  return lowerBody.includes("rate limit");
}

function looksLikeHtml(headers: HeaderLookup, body: string): boolean {
  const type = (headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/html")) return true;
  return body.trimStart().startsWith("<");
}

export function classifyResponse(status: number, headers: HeaderLookup, body: string): ResponseClass {
  const prefix = body.slice(0, CLASSIFY_BODY_PREFIX);
  if (status === 401) return "auth_required";
  if (status === 429) return "rate_limited";
  if (status === 403) {
    if (isRateLimit403(headers, prefix.toLowerCase())) return "rate_limited";
    return looksLikeHtml(headers, prefix) ? "challenge" : "forbidden";
  }
  if (status >= 500) return "server_error";
  if (status >= 200 && status < 300) return looksLikeHtml(headers, prefix) ? "challenge" : "ok";
  // A redirect (the client never follows one off the fixed origin), a 404 —
  // GitHub's answer for a private repository the token cannot see — and every
  // other 4xx: the request as sent will not succeed on a retry, so the
  // operator has to act on the target or the grant.
  return "forbidden";
}
