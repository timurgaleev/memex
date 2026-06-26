/**
 * Per-request auth identity + source-scope resolution for the MCP/REST ingress.
 *
 * memex composes this with the existing public-redaction model in
 * `mcp/dispatch.ts`: that layer already carries a single trust bit
 * (`DispatchOptions.isPublic`) which decides whether note bodies are redacted.
 * `AuthInfo` is the richer identity that the transport resolves at
 * token-verification time and threads alongside that bit. `isPublic` stays the
 * authoritative trust flag — it lives ON `AuthInfo` so identity and trust travel
 * together, and the dispatcher reads `auth.isPublic` exactly where it reads
 * `opts.isPublic` today.
 *
 * The source-scope helpers (`sourceScopeOpts` / `resolveRequestedScope`) are the
 * tenancy primitives: a single resolver every read-op routes through so a remote
 * caller can never opt out of its grant by passing `all_sources` or an
 * out-of-grant `source_id`. They are adapted to take `AuthInfo` directly rather
 * than a heavyweight operation context — memex's dispatch layer is lean and has
 * no per-op `OperationContext`, so the trust input is the explicit `isPublic`
 * flag the transport already owns.
 */

import { OperationError } from "./operation-error.ts";

export interface AuthInfo {
  /** The raw bearer/OAuth token presented by the caller. */
  token: string;
  /** Stable client identifier (OAuth client_id, or a bearer-token name). */
  clientId: string;
  /** Granted OAuth scopes (validate with `hasScope` from `core/scope.ts`). */
  scopes: string[];
  /**
   * The source this client may WRITE to (write authority). Undefined for legacy
   * tokens that predate source-scoping; engines fall back to unscoped behavior.
   */
  sourceId?: string;
  /**
   * Source ids this client may READ from (federation). Independent of
   * `sourceId`: a client can write to one source while reading a union.
   *
   * Empty `[]` means "no federated read scope beyond `sourceId`" — it MUST NOT
   * be read as "all sources". Undefined means "not populated" (back-compat:
   * fall back to the scalar `sourceId`).
   */
  allowedSources?: string[];
  /**
   * True when the caller arrived over the public ingress (`brain.<domain>/mcp`
   * via Cloudflare). This is the authoritative trust bit — it gates body
   * redaction in the dispatcher and fail-closes the scope resolvers below.
   * False for the internal-token ingress and local CLI callers.
   */
  isPublic: boolean;
}

/**
 * The effective READ sources for a caller: the federated `allowedSources` union
 * when populated, else the scalar `sourceId`, else `undefined` (unscoped — local
 * callers and pre-scoping tokens keep their existing whole-brain view).
 *
 * An empty `allowedSources: []` is treated as "no federated scope" and defers to
 * the scalar `sourceId`; it never widens to "all sources".
 */
export function effectiveReadSourceIds(
  auth: AuthInfo | undefined,
): string[] | undefined {
  const allowed = auth?.allowedSources;
  if (allowed && allowed.length > 0) return allowed;
  if (auth?.sourceId) return [auth.sourceId];
  return undefined;
}

/** The source a caller is authorized to WRITE to, or `undefined` if unscoped. */
export function effectiveWriteSourceId(
  auth: AuthInfo | undefined,
): string | undefined {
  return auth?.sourceId;
}

/**
 * Resolve the source-scope filter for a read-side op handler. Returns an opts
 * fragment ready to spread into an engine call.
 *
 * Precedence:
 *  1. `auth.allowedSources` (federated read) → `{ sourceIds: [...] }`.
 *  2. `auth.sourceId` (scalar write authority, used as read floor) →
 *     `{ sourceId: '...' }`.
 *  3. Neither set → `{}` (unscoped — local callers / pre-scoping tokens).
 *
 * Routing every read through one ladder keeps the per-site drift (the bug class
 * that leaks cross-source reads) out of the handlers.
 */
export function sourceScopeOpts(
  auth: AuthInfo | undefined,
): { sourceId?: string; sourceIds?: string[] } {
  const allowed = auth?.allowedSources;
  // An attacker-controlled `[]` MUST NOT widen scope to "all sources" — defer to
  // the scalar `sourceId` below when the federated list is empty.
  if (allowed && allowed.length > 0) return { sourceIds: allowed };
  if (auth?.sourceId) return { sourceId: auth.sourceId };
  return {};
}

/**
 * Resolve a per-call requested source scope against the caller's trust + grant.
 * FAIL-CLOSED: anything not strictly `isPublic === false` is treated as
 * untrusted/remote.
 *
 * The single resolver for every read op that accepts a per-call `source_id` /
 * `all_sources` parameter. Inlining the `__all__` branch per handler is the bug
 * class that leaks cross-source reads: a remote client could pass
 * `source_id: '__all__'` to opt out of its grant, or pass an out-of-grant
 * `source_id` that was never checked.
 *
 *   - `__all__` / `all_sources`:
 *       trusted local (isPublic === false) → `{}` (spans the whole brain)
 *       remote/public                       → the caller's grant (sourceScopeOpts)
 *   - explicit `source_id`:
 *       remote + federated grant that excludes it → permission_denied
 *       otherwise                                 → `{ sourceId }`
 *   - neither → the caller's grant (sourceScopeOpts).
 */
export function resolveRequestedScope(
  auth: AuthInfo | undefined,
  sourceIdParam: string | undefined,
  allSourcesParam = false,
): { sourceId?: string; sourceIds?: string[] } {
  const trustedLocal = auth?.isPublic === false;
  const wantsAll = allSourcesParam || sourceIdParam === "__all__";
  if (wantsAll) {
    return trustedLocal ? {} : sourceScopeOpts(auth);
  }
  if (sourceIdParam !== undefined) {
    const allowed = auth?.allowedSources;
    if (
      !trustedLocal &&
      allowed &&
      allowed.length > 0 &&
      !allowed.includes(sourceIdParam)
    ) {
      throw new OperationError(
        "permission_denied",
        `source '${sourceIdParam}' is outside your granted sources`,
        "Request access to this source, or omit source_id to read within your grant.",
      );
    }
    return { sourceId: sourceIdParam };
  }
  return sourceScopeOpts(auth);
}
