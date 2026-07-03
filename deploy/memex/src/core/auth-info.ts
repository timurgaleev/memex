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

/**
 * Reserved source id that matches NO real source. It is the fail-closed
 * sentinel: when an authenticated PUBLIC principal presents no read grant and
 * the fail-closed policy is on, its read scope resolves to `[SENTINEL]` so every
 * `sourceIds`-filtered read (`... WHERE source_id = ANY($n)`) matches zero rows.
 *
 * Why a sentinel rather than an empty array: the read helpers gate their scope
 * filter on `sourceIds && sourceIds.length` (v1.58), so an empty `[]` SKIPS the
 * filter and silently widens back to whole-brain — a fail-closed BYPASS. A
 * one-element array of an unownable id keeps the filter engaged and no-matches,
 * flowing through every read handler unchanged.
 */
export const NO_SOURCE_SENTINEL = "__memex_no_source__";

/**
 * Is the fail-closed multi-tenant read policy enabled? Default OFF — only an
 * explicit `MEMEX_TENANT_FAIL_CLOSED=1` (or `=true`) opts in. Off, the ingress
 * resolver is byte-for-byte {@link effectiveReadSourceIds}, so the daily
 * static-bearer path is untouched.
 */
export function tenantFailClosedEnabled(): boolean {
  const v = process.env["MEMEX_TENANT_FAIL_CLOSED"];
  return v === "1" || v === "true";
}

/**
 * Ingress-side read scope with an OPTIONAL fail-closed floor.
 *
 * Resolves the base scope via {@link effectiveReadSourceIds}. When the caller
 * holds a grant it is honored verbatim. When they hold none (`base === undefined`)
 * the policy branches on whether the caller is an AUTHENTICATED principal:
 *
 *   - `failClosed` on AND `auth` present (`auth !== undefined`)
 *       → `[NO_SOURCE_SENTINEL]` (reads NOTHING — an authenticated caller with no
 *         source grant must not fall through to the redacted whole-brain). This
 *         covers an OAuth tenant (`isPublic === false`) as well as an authenticated
 *         public caller — a scopeless registered client is NOT whole-brain-trusted.
 *   - otherwise → `undefined` (UNCHANGED whole-brain): this is the static public
 *       bearer and the trusted-local path, both of which present `auth === undefined`.
 *       The discriminator is `auth === undefined`, so the daily Claude Code
 *       static-bearer path is never scoped.
 */
export function effectiveReadSourceIdsForIngress(
  auth: AuthInfo | undefined,
  opts?: { failClosed?: boolean },
): string[] | undefined {
  const base = effectiveReadSourceIds(auth);
  if (base !== undefined) return base;
  if (opts?.failClosed === true && auth !== undefined) {
    return [NO_SOURCE_SENTINEL];
  }
  return undefined;
}

/** The source a caller is authorized to WRITE to, or `undefined` if unscoped. */
export function effectiveWriteSourceId(
  auth: AuthInfo | undefined,
): string | undefined {
  return auth?.sourceId;
}

/**
 * Ingress-side WRITE scope with an OPTIONAL fail-closed floor — the write-path
 * mirror of {@link effectiveReadSourceIdsForIngress}.
 *
 * Resolves the base write source via {@link effectiveWriteSourceId}. When the
 * caller holds a write grant it is returned verbatim. When they hold none
 * (`base === undefined`) the policy branches on whether the caller is an
 * AUTHENTICATED principal:
 *
 *   - `failClosed` on AND `auth` present (`auth !== undefined`)
 *       → `NO_SOURCE_SENTINEL` — the dispatcher MUST reject the write with
 *         permission_denied rather than let it default to the 'default' tenant
 *         (an orphaned/no-write-source OAuth principal must not write anywhere).
 *   - otherwise → `undefined` (UNCHANGED unscoped write): the static public
 *       bearer and the trusted-local path, both of which present `auth === undefined`.
 *       Same discriminator as the read helper, so the daily static-bearer path is
 *       never scoped.
 */
export function effectiveWriteSourceIdForIngress(
  auth: AuthInfo | undefined,
  opts?: { failClosed?: boolean },
): string | undefined {
  const base = effectiveWriteSourceId(auth);
  if (base !== undefined) return base;
  if (opts?.failClosed === true && auth !== undefined) {
    return NO_SOURCE_SENTINEL;
  }
  return undefined;
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
  // SECURITY: "trusted" means the static-bearer / trusted-local / internal path,
  // which presents NO authInfo (`auth === undefined`). An OAuth tenant has
  // `isPublic === false` too, so keying on isPublic would let a tenant pose as
  // trusted-local and request any source (IDOR). A tenant is ALWAYS scoped to its
  // grant here.
  const trustedLocal = auth === undefined;
  const wantsAll = allSourcesParam || sourceIdParam === "__all__";
  if (wantsAll) {
    return trustedLocal ? {} : sourceScopeOpts(auth);
  }
  if (sourceIdParam !== undefined) {
    if (!trustedLocal) {
      // Fail-closed: a scoped caller may only name a source inside its grant.
      // An empty/absent grant matches nothing, so a caller with no allowed
      // sources is rejected rather than passed through verbatim.
      const allowed = auth?.allowedSources ?? [];
      const own = auth?.sourceId;
      const permitted =
        allowed.includes(sourceIdParam) || sourceIdParam === own;
      if (!permitted) {
        throw new OperationError(
          "permission_denied",
          `source '${sourceIdParam}' is outside your granted sources`,
          "Request access to this source, or omit source_id to read within your grant.",
        );
      }
    }
    return { sourceId: sourceIdParam };
  }
  return sourceScopeOpts(auth);
}
