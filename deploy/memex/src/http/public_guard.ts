/**
 * Public-request guard — enforces bearer auth + write-protection on
 * requests that arrived through the public Cloudflare Tunnel ingress.
 *
 * Detection: a request from the Cloudflare edge carries a
 * `Cf-Connecting-Ip` header (the real client IP). Internal Docker
 * traffic (recipe / worker callers) hits the bridge network
 * directly and never goes through Cloudflare, so it lacks this header.
 *
 * Public-request rules:
 *   1. `/health` GET — open (used by uptime probes).
 *   2. Anything else — requires `Authorization: Bearer <token>`.
 *      Token comes from `MEMEX_PUBLIC_BEARER` env (populated by
 *      fetch-secrets.sh from the `<secrets_prefix>/memex-public-bearer`
 *      Secrets Manager entry).
 *   3. **Mutating routes are rejected by default** even with a valid
 *      bearer (POST /index, POST /friction, MCP tools/call
 *      name=index|log_friction). Set env `MEMEX_PUBLIC_WRITE=1`
 *      to opt the public route into write access — pair this with
 *      daily bearer rotation (`scripts/rotate-memex-public-bearer.sh`)
 *      so a leaked token gets invalidated within 24h.
 *
 * If the env has no bearer token AND the request is public → 503.
 * Operators MUST configure the secret before exposing the route.
 */

import { timingSafeEqual } from "node:crypto";
// Canonical definition lives in core so the MCP layer shares it without
// importing this http/ module (which would create an import cycle).
import { publicReadBodiesAllowed } from "../core/public_redaction.ts";
import { OAUTH_METADATA_PATH } from "./oauth-metadata.ts";

export interface PublicGuardOptions {
  /** Bearer token. If undefined, every public request is rejected. */
  bearerToken?: string;
}

export interface GuardDecision {
  allow: true;
  /** True iff this request came from the public Cloudflare ingress. */
  isPublic: boolean;
}

export interface GuardRejection {
  allow: false;
  status: number;
  reason: string;
}

// Defense-in-depth relic. These REST write routes were removed in A.7 —
// memex's only HTTP surface today is `GET /health` + `POST /mcp` (see
// http/server.ts), so none of these paths route to a handler anymore and
// this set can never match a real request. It is kept (not deleted) as a
// fail-closed backstop: the north-star forbids re-adding non-`/mcp` HTTP
// routes, and if that rule is ever violated by accident, a public write to
// one of these paths is rejected with 403 rather than silently served.
// MCP write-tool protection lives in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC below,
// which IS on the live path.
const FORBIDDEN_PATHS_FROM_PUBLIC = new Set([
  "/index",
  "/friction",
  "/pages/put",
  "/pages/append",
  "/pages/delete",
  "/graph/link",
  "/graph/unlink",
  "/entities/facts/add",
  "/timeline/add",
  "/jobs/submit",
  "/jobs/cancel",
]);

// Constructive knowledge-writes the public/authenticated ingress MAY perform
// when MEMEX_PUBLIC_WRITE=1. Mirrors the reference's remote-write surface:
// remote callers can ADD knowledge (pages, facts, links, tags), but the
// destructive ops (page_delete/restore/revert, unlink, remove_tag,
// purge_deleted_pages, forget_fact) stay local-only — the reference keeps hard
// deletes "Local CLI only (not exposed over HTTP MCP)" too. These appear in the
// public tools/list and are reachable ONLY while the flag is on; with the flag
// off they are forbidden exactly as before.
const PUBLIC_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "index",
  "page_put",
  "page_append",
  "add_fact",
  "add_timeline_event",
  "add_tag",
  "link",
]);

const FORBIDDEN_MCP_TOOLS_FROM_PUBLIC: ReadonlySet<string> = new Set([
  // Destructive writes — never reachable from public, even with the write flag.
  "log_friction",
  "page_delete",
  "page_restore",
  "page_revert",
  "unlink",
  "remove_tag",
  // get_chunks returns raw chunk CONTENT — the public ingress redacts content
  // everywhere else, so it must be internal-only (a read, but a content read).
  "get_chunks",
  // get_tags returns author-authored tag labels (can encode private terms, e.g.
  // a client name) — a new free-text class on the public path; internal-only,
  // consistent with the privacy-max redaction posture.
  "get_tags",
  // resolve_slugs + relational_recall surface PAGE slugs (people/<name>,
  // companies/<name>) — exactly the author-written identifiers the public search
  // path deliberately suppresses (page:// hits are filtered on public ingress).
  // Internal-only so they can't re-expose / enumerate the private slug + typed
  // relationship graph through the public bearer.
  "resolve_slugs",
  "relational_recall",
  // Wave-1 reads that surface page slugs/titles or fact free-text — the same
  // author-written identifiers/content the public path suppresses everywhere
  // else. get_links exposes the slug graph; find_* + get_recent_salience list
  // page slugs/titles; recall returns fact text + an entity slug. Internal-only,
  // consistent with resolve_slugs / relational_recall / get_chunks.
  "get_links",
  "find_orphans",
  "find_experts",
  "find_contradictions",
  "find_trajectory",
  "get_recent_salience",
  "find_anomalies",
  "recall",
  // forget_fact + purge_deleted_pages are WRITES; query returns full SearchHit
  // bodies (the content public search redacts). All internal-only.
  "forget_fact",
  "purge_deleted_pages",
  "query",
  // code_callers/code_callees/code_def/code_refs/code_blast/code_flow surface
  // indexed source paths + symbol names — private repo structure; internal-only,
  // consistent with the slug/content set.
  "code_callers",
  "code_callees",
  "code_def",
  "code_refs",
  "code_blast",
  "code_flow",
  // volunteer_context surfaces page slugs/titles + synopses (the same
  // author-written identifiers/content the public path suppresses); internal-only.
  "volunteer_context",
  // advisor surfaces operational state (pending migrations, job queue, embed
  // coverage, internal-auth config) — private infra, internal-only.
  "advisor",
  // Synthesized content is LLM-derived FROM the user's private notes — list it
  // only internally, same posture as the note surfaces it summarizes.
  "list_concepts",
  "list_takes",
  "get_calibration_profile",
  // Take aggregates + on-demand fact extraction expose the same private-note-
  // derived signal as the reads above; extract_facts can even re-derive a
  // page's fact text (and spends Bedrock), so it must never be public.
  "takes_scorecard",
  "takes_calibration",
  "extract_facts",
  // Returns author-written slugs + titles of ingested transcripts — same
  // slug-listing privacy posture as find_orphans / get_recent_salience.
  "get_recent_transcripts",
  "jobs_submit",
  "jobs_cancel",
]);

/**
 * When `MEMEX_PUBLIC_WRITE=1` is set in the runtime env, the
 * public route accepts write traffic too. Read-once at module init
 * — flip the env + restart the container to change.
 */
function publicWriteAllowed(): boolean {
  const v = (process.env["MEMEX_PUBLIC_WRITE"] ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}


function isPublicRequest(req: Request): boolean {
  // Public ingress is detected by Cloudflare's `Cf-Connecting-Ip`
  // header. An empty value is treated as still-public (a defence
  // against an attacker setting the header to "" hoping we treat them
  // as internal); only a missing header counts as internal.
  return req.headers.get("Cf-Connecting-Ip") !== null;
}

/**
 * Internal-route auth — requests that the public guard waves through
 * as "internal" must still carry a matching shared token. Without
 * this check, any peer on the docker bridge (compromised sibling
 * container or future host bind on :18790) could write to the index
 * via POST /index with no auth at all. The shared secret is loaded
 * from `MEMEX_INTERNAL_TOKEN` env (populated by fetch-secrets.sh
 * from `<secrets_prefix>/memex-internal-token`).
 *
 * Fail-closed: when the token is configured but a request lacks the
 * matching `Authorization: Bearer <internal-token>` header, the
 * request is rejected with 401. When the env var is unset the gate
 * is open (legacy single-node installs); operators are urged to
 * configure the secret.
 */
export interface InternalAuthOptions {
  internalToken?: string;
}

export function evaluateInternalAuth(
  req: Request,
  opts: InternalAuthOptions,
): GuardDecision | GuardRejection {
  if (!opts.internalToken || opts.internalToken.length === 0) {
    // Legacy fall-through. Loud warning logged once at startup; do
    // not also log per request (would spam at MCP traffic rates).
    return { allow: true, isPublic: false };
  }
  const auth = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${opts.internalToken}`;
  if (!timingSafeEqualStrings(auth, expected)) {
    return {
      allow: false,
      status: 401,
      reason: "internal endpoint requires X-Authorization shared token",
    };
  }
  return { allow: true, isPublic: false };
}

export function evaluatePublicGuard(
  req: Request,
  url: URL,
  opts: PublicGuardOptions,
): GuardDecision | GuardRejection {
  const isPublic = isPublicRequest(req);
  if (!isPublic) {
    return { allow: true, isPublic: false };
  }

  // Public — apply guard.
  if (url.pathname === "/health" && req.method === "GET") {
    // Open probe. No bearer required.
    return { allow: true, isPublic: true };
  }

  // OAuth 2.1 authorization-server discovery (RFC 8414). A client must reach
  // this BEFORE it holds any credential, so it is open exactly like /health.
  if (url.pathname === OAUTH_METADATA_PATH && req.method === "GET") {
    return { allow: true, isPublic: true };
  }

  // Admin surface — carries its OWN cookie + magic-link auth (http/admin.ts),
  // so the public bearer guard lets it through; the admin handler enforces the
  // session / bootstrap token / nonce on every route itself.
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return { allow: true, isPublic: true };
  }

  if (
    FORBIDDEN_PATHS_FROM_PUBLIC.has(url.pathname) &&
    !publicWriteAllowed()
  ) {
    return {
      allow: false,
      status: 403,
      reason: `route ${url.pathname} is internal-only (set MEMEX_PUBLIC_WRITE=1 to opt in)`,
    };
  }

  if (!opts.bearerToken || opts.bearerToken.length === 0) {
    return {
      allow: false,
      status: 503,
      reason: "public bearer token not configured",
    };
  }

  const auth = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${opts.bearerToken}`;
  if (!timingSafeEqualStrings(auth, expected)) {
    return {
      allow: false,
      status: 401,
      reason: "missing or invalid bearer token",
    };
  }

  return { allow: true, isPublic: true };
}

/**
 * Constant-time string comparison. A simple `a !== b` short-circuits on
 * the first differing byte, leaking the prefix-match length to a
 * timing-sensitive attacker — relevant because the public bearer is
 * fronted by Cloudflare. We compare two equal-length Buffers via
 * Node's timingSafeEqual; if the lengths differ we still do a dummy
 * compare so the timing remains uniform.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  // Bearer tokens are ASCII (URL-safe random alphanumerics), so UTF-8
  // byte length == char count. Buffer.from is constant-time-ish per
  // input byte; the dummy compare below masks the secret's length.
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Burn cycles against a buffer matching the SECRET's length, not
    // the attacker's. Attacker can vary their own input length but the
    // mismatch path's compute is always proportional to |b|.
    const dummy = Buffer.alloc(bBuf.length);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * MCP tools/call extra check — even with a valid bearer, mutating tools are
 * rejected from public requests by default. `MEMEX_PUBLIC_WRITE=1` opens ONLY
 * the constructive PUBLIC_WRITE_TOOLS (index / page_put / page_append /
 * add_fact / add_timeline_event / add_tag / link). The always-internal set
 * (destructive writes + privacy-sensitive content/identifier reads) stays
 * forbidden regardless of the flag.
 */
export function isPublicMcpToolForbidden(toolName: string): boolean {
  if (FORBIDDEN_MCP_TOOLS_FROM_PUBLIC.has(toolName)) return true;
  if (PUBLIC_WRITE_TOOLS.has(toolName)) return !publicWriteAllowed();
  return false;
}

export const PUBLIC_GUARD_INTERNALS = {
  isPublicRequest,
  FORBIDDEN_PATHS_FROM_PUBLIC,
  FORBIDDEN_MCP_TOOLS_FROM_PUBLIC,
  PUBLIC_WRITE_TOOLS,
  publicReadBodiesAllowed,
};
