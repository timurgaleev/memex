/**
 * OAuth 2.1 provider — hash-only token + client store over the SQL engine.
 *
 * This is infrastructure, not brain retrieval: it talks to the raw Engine
 * (PGLite or Postgres) rather than the higher-level indexer/search layers.
 * The HTTP transport wraps these methods — every public method takes plain
 * data and returns plain objects (no Request/Response coupling), so the
 * ingress layer owns redirects, status codes, and header parsing.
 *
 * Supports:
 *  - Client registration (CLI helper + Dynamic Client Registration)
 *  - Authorization-code flow with PKCE (browser-based clients)
 *  - Client-credentials flow (machine-to-machine)
 *  - Refresh-token rotation
 *  - Token revocation
 *  - Legacy access_tokens fallback for the pre-OAuth bearer path
 *
 * Secrets and tokens are stored as SHA-256 hashes only; the plaintext
 * value is returned to the caller exactly once at issuance and never
 * persisted.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import {
  hasScope,
  parseScopeString,
  assertAllowedScopes,
} from "./scope.ts";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest. Tokens and client secrets are stored hashed. */
function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Generate an opaque token with a human-readable prefix. */
function generateToken(prefix: string): string {
  return prefix + randomBytes(32).toString("hex");
}

/**
 * True when the error is Postgres "undefined column" (SQLSTATE 42703) for
 * the named column. Lets a query degrade gracefully on a brain whose schema
 * predates a given column instead of failing the whole request.
 */
function isUndefinedColumnError(err: unknown, column: string): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? "";
  if (code === "42703") {
    return message.includes(column);
  }
  // PGLite surfaces this as a plain message without the SQLSTATE code.
  return (
    message.includes("does not exist") && message.includes(column)
  );
}

/**
 * Coerce an OAuth timestamp column (Unix epoch seconds, BIGINT) into a JS
 * number, or undefined for SQL NULL. postgres.js returns BIGINT as a string
 * when prepared statements are disabled (PgBouncer transaction mode), so the
 * comparison sites must normalize. Throws on non-finite so a corrupt row
 * fails loud at the boundary rather than letting `NaN` ride past validation.
 */
export function coerceTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `coerceTimestamp: non-finite timestamp value ${JSON.stringify(value)}`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// token_endpoint_auth_method validation (RFC 7591 §2)
// ---------------------------------------------------------------------------

export type TokenEndpointAuthMethod =
  | "client_secret_post"
  | "client_secret_basic"
  | "none";

export const ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS =
  new Set<TokenEndpointAuthMethod>([
    "client_secret_post",
    "client_secret_basic",
    "none",
  ]);

export class InvalidTokenEndpointAuthMethodError extends Error {
  readonly code = "invalid_token_endpoint_auth_method";
  constructor(value: unknown) {
    super(
      `Invalid token_endpoint_auth_method: ${JSON.stringify(value)}. ` +
        `Expected one of: ${Array.from(
          ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS,
        ).join(", ")}.`,
    );
    this.name = "InvalidTokenEndpointAuthMethodError";
  }
}

/**
 * Validate a token_endpoint_auth_method at the registration boundary.
 * Returns `client_secret_post` for empty input (RFC 7591 default). Applied
 * on write only — stored rows with legacy values keep working on read.
 */
export function validateTokenEndpointAuthMethod(
  value: unknown,
): TokenEndpointAuthMethod {
  if (value === undefined || value === null || value === "") {
    return "client_secret_post";
  }
  if (typeof value !== "string") {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  if (
    !ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS.has(value as TokenEndpointAuthMethod)
  ) {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  return value as TokenEndpointAuthMethod;
}

/**
 * Validate a redirect_uri (RFC 6749 §3.1.2.1). Production URIs must be HTTPS;
 * the only plaintext exceptions are loopback hosts, which are unreachable from
 * the network. Used by the DCR path; the CLI path trusts the operator.
 */
function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid redirect_uri: not a parseable URL: ${uri}`);
  }
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopback) return;
  throw new Error(
    `redirect_uri must use https:// (or http://localhost for loopback): ${uri}`,
  );
}

// ---------------------------------------------------------------------------
// Public data shapes (transport-neutral)
// ---------------------------------------------------------------------------

/** Stored/returned client record. `client_secret` is the SHA-256 hash on
 *  read, and the freshly-minted plaintext exactly once at registration. */
export interface OAuthClientInfo {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

/** Token-endpoint success payload (RFC 6749 §5.1). */
export interface OAuthTokens {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/** Parameters the ingress collects from the /authorize request. */
export interface AuthorizationParams {
  codeChallenge: string;
  redirectUri: string;
  scopes?: string[];
  state?: string;
  resource?: URL;
}

/** Resolved identity carried alongside an authenticated request. The
 *  `sourceId` (write scope) + `allowedSources` (federated read set) fields
 *  feed the tenancy axis downstream. */
export interface AuthInfo {
  token: string;
  clientId: string;
  clientName?: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
  sourceId?: string;
  allowedSources?: string[];
}

export interface TokenRevocationRequest {
  token: string;
  token_type_hint?: string;
}

export class InvalidTokenError extends Error {
  readonly code = "invalid_token";
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

// ---------------------------------------------------------------------------
// Legacy permissions.source_id parsing
// ---------------------------------------------------------------------------

/**
 * Map a legacy access_tokens `permissions.source_id` grant onto the
 * (sourceId, allowedSources) pair. A scalar string is both the write source
 * and the sole read source; an array is a federated read set anchored on its
 * first element. Anything else falls back to the historical 'default' floor.
 */
function parseLegacyTokenScope(grant: unknown): {
  sourceId: string;
  allowedSources?: string[];
} {
  if (typeof grant === "string" && grant.length > 0) {
    return { sourceId: grant, allowedSources: [grant] };
  }
  if (Array.isArray(grant)) {
    const sources = grant.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (sources.length > 0) {
      return { sourceId: sources[0] as string, allowedSources: sources };
    }
  }
  return { sourceId: "default" };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface OAuthProviderOptions {
  engine: Engine;
  /** Default access-token TTL in seconds (default: 3600). */
  tokenTtl?: number;
  /** Default refresh-token TTL in seconds (default: 30 days). */
  refreshTtl?: number;
}

export class OAuthProvider {
  private engine: Engine;
  private tokenTtl: number;
  private refreshTtl: number;

  constructor(options: OAuthProviderOptions) {
    this.engine = options.engine;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
  }

  private async rows<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const r = await this.engine.query<T>(sql, params);
    return r.rows;
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  async getClient(clientId: string): Promise<OAuthClientInfo | undefined> {
    const rows = await this.rows(
      `SELECT client_id, client_secret_hash, client_name, redirect_uris,
              grant_types, scope, token_endpoint_auth_method,
              client_id_issued_at, client_secret_expires_at
       FROM oauth_clients WHERE client_id = $1`,
      [clientId],
    );
    if (rows.length === 0) return undefined;
    const r = rows[0] as Record<string, unknown>;
    // Public clients (token_endpoint_auth_method='none') store a NULL secret
    // hash. Normalize SQL NULL to JS undefined so the caller's public-client
    // detection (`client_secret === undefined`) skips secret comparison.
    const rawSecret = r.client_secret_hash;
    return {
      client_id: r.client_id as string,
      client_secret: rawSecret == null ? undefined : (rawSecret as string),
      client_name: r.client_name as string,
      redirect_uris: (r.redirect_uris as string[]) || [],
      grant_types: (r.grant_types as string[]) || ["client_credentials"],
      scope: (r.scope as string | null) ?? undefined,
      token_endpoint_auth_method:
        (r.token_endpoint_auth_method as string | null) ?? undefined,
      client_id_issued_at: coerceTimestamp(r.client_id_issued_at),
      client_secret_expires_at: coerceTimestamp(r.client_secret_expires_at),
    };
  }

  /**
   * Dynamic Client Registration (RFC 7591). Reachable by unauthenticated
   * network callers when DCR is enabled, so this is the security-relevant
   * registration gate: HTTPS redirect_uris, allowed scopes, and a valid
   * auth method are all enforced here.
   */
  async registerClient(client: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    scope?: string;
    token_endpoint_auth_method?: string;
  }): Promise<OAuthClientInfo> {
    for (const uri of client.redirect_uris || []) {
      validateRedirectUri(String(uri));
    }
    assertAllowedScopes(parseScopeString(client.scope));
    const authMethod = validateTokenEndpointAuthMethod(
      client.token_endpoint_auth_method,
    );

    const clientId = generateToken("memex_cl_");
    // Public clients (auth method 'none') authenticate via PKCE alone — the
    // server must NOT issue a secret for them (RFC 7591 §2). Confidential
    // clients mint a secret and store only its hash.
    const isPublicClient = authMethod === "none";
    const clientSecret = isPublicClient
      ? undefined
      : generateToken("memex_cs_");
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // DCR clients default to source_id='default' with read scope == write
    // scope (federated_read=['default']); operators rescope via the CLI.
    await this.engine.query(
      `INSERT INTO oauth_clients
         (client_id, client_secret_hash, client_name, redirect_uris,
          grant_types, scope, token_endpoint_auth_method,
          client_id_issued_at, source_id, federated_read)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10::text[])`,
      [
        clientId,
        secretHash,
        client.client_name || "unnamed",
        (client.redirect_uris || []).map(String),
        client.grant_types || ["client_credentials"],
        client.scope || "",
        authMethod,
        now,
        "default",
        ["default"],
      ],
    );

    const response: OAuthClientInfo = {
      client_id: clientId,
      client_name: client.client_name || "unnamed",
      redirect_uris: (client.redirect_uris || []).map(String),
      grant_types: client.grant_types || ["client_credentials"],
      scope: client.scope,
      token_endpoint_auth_method: authMethod,
      client_id_issued_at: now,
    };
    // Public clients omit client_secret entirely (RFC 7591 §3.2.1).
    if (clientSecret) response.client_secret = clientSecret;
    return response;
  }

  /**
   * Operator-trusted registration (CLI / admin). Sets the tenancy grant
   * directly: `sourceId` is the write source, `federatedRead` the read set
   * (defaults to `[sourceId]` when omitted).
   */
  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string,
    redirectUris: string[] = [],
    sourceId = "default",
    federatedRead?: string[],
    tokenEndpointAuthMethod?: string,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    assertAllowedScopes(parseScopeString(scopes));
    const authMethod = validateTokenEndpointAuthMethod(
      tokenEndpointAuthMethod,
    );

    const clientId = generateToken("memex_cl_");
    const isPublicClient = authMethod === "none";
    const clientSecret = isPublicClient
      ? undefined
      : generateToken("memex_cs_");
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);
    const federated =
      federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId];

    await this.engine.query(
      `INSERT INTO oauth_clients
         (client_id, client_secret_hash, client_name, redirect_uris,
          grant_types, scope, token_endpoint_auth_method,
          client_id_issued_at, source_id, federated_read)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10::text[])`,
      [
        clientId,
        secretHash,
        name,
        redirectUris,
        grantTypes,
        scopes,
        authMethod,
        now,
        sourceId,
        federated,
      ],
    );

    return { clientId, clientSecret };
  }

  // -------------------------------------------------------------------------
  // Authorization-code flow
  // -------------------------------------------------------------------------

  /**
   * Mint an authorization code and return the redirect target. The HTTP
   * layer is responsible for issuing the 302 — this method only returns the
   * URL so it stays transport-neutral.
   */
  async authorize(
    client: OAuthClientInfo,
    params: AuthorizationParams,
  ): Promise<{ redirectUrl: string }> {
    const code = generateToken("memex_code_");
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min TTL

    // Clamp the requested scope to the client's registered grant (RFC 6749
    // §3.3). An omitted request defaults to the client's full registered
    // scope; an over-broad explicit request is filtered down to the allowed
    // set so it cannot escalate.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes =
      params.scopes && params.scopes.length ? params.scopes : allowedScopes;
    const grantedScopes = requestedScopes.filter((s) =>
      hasScope(allowedScopes, s),
    );

    await this.engine.query(
      `INSERT INTO oauth_codes
         (code_hash, client_id, scopes, code_challenge,
          code_challenge_method, redirect_uri, state, resource, expires_at)
       VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9)`,
      [
        codeHash,
        client.client_id,
        grantedScopes,
        params.codeChallenge,
        "S256",
        params.redirectUri,
        params.state ?? null,
        params.resource?.toString() ?? null,
        expiresAt,
      ],
    );

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) redirectUrl.searchParams.set("state", params.state);
    return { redirectUrl: redirectUrl.toString() };
  }

  /** Return the stored PKCE challenge for a code, bound to the client so a
   *  wrong client cannot read another client's challenge. */
  async challengeForAuthorizationCode(
    client: OAuthClientInfo,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    const rows = await this.rows<{ code_challenge: string }>(
      `SELECT code_challenge FROM oauth_codes
       WHERE code_hash = $1 AND client_id = $2 AND expires_at > $3`,
      [codeHash, client.client_id, Math.floor(Date.now() / 1000)],
    );
    if (rows.length === 0) {
      throw new Error("Authorization code not found or expired");
    }
    return rows[0]!.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInfo,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    // Single-use redemption: bind client_id (and redirect_uri when present)
    // into the DELETE…RETURNING so the row is consumed atomically. A second
    // request, wrong client, or wrong redirect_uri gets zero rows back. Use
    // `!== undefined` so an empty-string redirect_uri can't skip the binding.
    const rows =
      redirectUri !== undefined
        ? await this.rows<{ scopes: string[] }>(
            `DELETE FROM oauth_codes
             WHERE code_hash = $1 AND client_id = $2
               AND redirect_uri = $3 AND expires_at > $4
             RETURNING client_id, scopes, resource`,
            [codeHash, client.client_id, redirectUri, now],
          )
        : await this.rows<{ scopes: string[] }>(
            `DELETE FROM oauth_codes
             WHERE code_hash = $1 AND client_id = $2 AND expires_at > $3
             RETURNING client_id, scopes, resource`,
            [codeHash, client.client_id, now],
          );
    if (rows.length === 0) {
      throw new Error("Authorization code not found or expired");
    }

    const scopes = (rows[0]!.scopes as string[]) || [];
    return this.issueTokens(client.client_id, scopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Refresh token
  // -------------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInfo,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    // Rotate atomically: bind client_id into the DELETE so a wrong-client
    // attempt cannot burn the legitimate client's refresh row (RFC 6749
    // §10.4 stolen-token detection depends on second-use failure).
    const rows = await this.rows<{ scopes: string[]; expires_at: unknown }>(
      `DELETE FROM oauth_tokens
       WHERE token_hash = $1 AND token_type = 'refresh' AND client_id = $2
       RETURNING client_id, scopes, expires_at`,
      [tokenHash, client.client_id],
    );
    if (rows.length === 0) throw new Error("Refresh token not found");

    const row = rows[0]!;
    // NULL expires_at is treated as expired (fail-closed).
    const expiresAt = coerceTimestamp(row.expires_at);
    if (expiresAt === undefined || expiresAt < now) {
      throw new Error("Refresh token expired");
    }

    // Requested scope on refresh must be a subset of the original grant
    // (RFC 6749 §6). hasScope honors the hierarchy so an `admin` grant can
    // refresh down to an implied scope. Omitted scope inherits the grant.
    const grantedScopes = (row.scopes as string[]) || [];
    if (scopes && scopes.some((s) => !hasScope(grantedScopes, s))) {
      throw new Error("Requested scope exceeds refresh token grant");
    }
    const tokenScopes = scopes ?? grantedScopes;
    return this.issueTokens(client.client_id, tokenScopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Token verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // OAuth tokens first. JOIN oauth_clients so the source_id (write scope)
    // and federated_read (read set) arrive on the same query — no N+1 lookup.
    const oauthRows = await this.rows(
      `SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
              c.source_id, c.federated_read
       FROM oauth_tokens t
       LEFT JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.token_hash = $1 AND t.token_type = 'access'
         AND t.revoked_at IS NULL`,
      [tokenHash],
    );

    if (oauthRows.length > 0) {
      const row = oauthRows[0] as Record<string, unknown>;
      // NULL expires_at is treated as expired (fail-closed).
      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new InvalidTokenError("Token expired");
      }
      // Distinguish empty array (explicit no-federated-read) from undefined.
      const federatedRaw = row.federated_read;
      const allowedSources = Array.isArray(federatedRaw)
        ? (federatedRaw as string[])
        : undefined;
      return {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes: (row.scopes as string[]) || [],
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        sourceId: (row.source_id as string | null) ?? undefined,
        allowedSources,
      };
    }

    // Fallback: legacy access_tokens (pre-OAuth bearer path). These rows may
    // carry a permissions.source_id grant the OAuth transport must preserve
    // instead of pinning every legacy token to 'default'.
    let legacyRows: Record<string, unknown>[];
    try {
      legacyRows = await this.rows(
        `SELECT name, permissions FROM access_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
    } catch (err) {
      if (isUndefinedColumnError(err, "permissions")) {
        legacyRows = await this.rows(
          `SELECT name FROM access_tokens
           WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash],
        );
      } else {
        throw err;
      }
    }

    if (legacyRows.length > 0) {
      const row = legacyRows[0]!;
      await this.engine.query(
        `UPDATE access_tokens SET last_used_at = now() WHERE token_hash = $1`,
        [tokenHash],
      );
      const name = row.name as string;
      let permissions: unknown = row.permissions;
      if (typeof permissions === "string") {
        try {
          permissions = JSON.parse(permissions);
        } catch {
          permissions = undefined;
        }
      }
      const sourceGrant =
        permissions && typeof permissions === "object"
          ? (permissions as Record<string, unknown>).source_id
          : undefined;
      const { sourceId, allowedSources } = parseLegacyTokenScope(sourceGrant);
      return {
        token,
        clientId: name,
        clientName: name,
        // Legacy tokens grandfather in with full access.
        scopes: ["read", "write", "admin"],
        // Legacy tokens never expire — set a year out so the number check passes.
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        sourceId,
        allowedSources,
      };
    }

    throw new InvalidTokenError("Invalid token");
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    client: OAuthClientInfo,
    request: TokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    // Bind client_id so a client can only revoke its own tokens (RFC 7009
    // §2.1). Hard-delete keeps revocation simple; verify also gates on
    // revoked_at for rows that are soft-revoked out of band.
    await this.engine.query(
      `DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2`,
      [tokenHash, client.client_id],
    );
  }

  // -------------------------------------------------------------------------
  // Client credentials
  // -------------------------------------------------------------------------

  /**
   * Verify a confidential client's secret without spending it. Returns the
   * client on success; throws an opaque "Invalid client" on failure
   * (RFC 6749 §5.2). Public clients (NULL secret hash) are refused so the
   * PKCE path stays the canonical surface for them.
   */
  async verifyConfidentialClientSecret(
    clientId: string,
    presentedSecret: string,
  ): Promise<OAuthClientInfo> {
    const client = await this.getClient(clientId);
    if (!client) throw new Error("Invalid client");
    if (client.client_secret === undefined) {
      throw new Error("Invalid client");
    }
    const presentedHash = hashToken(presentedSecret);
    if (client.client_secret !== presentedHash) {
      throw new Error("Invalid client");
    }
    await this.assertClientNotRevoked(clientId);
    return client;
  }

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const client = await this.getClient(clientId);
    if (!client) throw new Error("Client not found");

    await this.assertClientNotRevoked(clientId);

    // Grant-type check before secret comparison.
    const grants = client.grant_types || [];
    if (!grants.includes("client_credentials")) {
      throw new Error(
        "Client credentials grant not authorized for this client",
      );
    }

    const secretHash = hashToken(clientSecret);
    if (client.client_secret !== secretHash) {
      throw new Error("Invalid client secret");
    }

    // Clamp requested scope to the client's registered grant; hasScope honors
    // the hierarchy so an `admin` client mints implied scopes too.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = requestedScope
      ? parseScopeString(requestedScope)
      : allowedScopes;
    const grantedScopes = requestedScopes.filter((s) =>
      hasScope(allowedScopes, s),
    );

    // Per-client TTL override (oauth_clients.token_ttl); fall through if the
    // column is absent on an older schema.
    let clientTtl: number | undefined;
    try {
      const ttlRows = await this.rows<{ token_ttl: unknown }>(
        `SELECT token_ttl FROM oauth_clients WHERE client_id = $1`,
        [clientId],
      );
      if (ttlRows.length > 0 && ttlRows[0]!.token_ttl) {
        clientTtl = Number(ttlRows[0]!.token_ttl);
      }
    } catch (e) {
      if (!isUndefinedColumnError(e, "token_ttl")) throw e;
    }

    // Client credentials: access token only, no refresh (RFC 6749 §4.4.3).
    return this.issueTokens(clientId, grantedScopes, undefined, false, clientTtl);
  }

  /**
   * Throw if the client is soft-deleted. Tolerates a schema without the
   * deleted_at column (older brains) but surfaces every other error — a bare
   * catch here would be a fail-open posture in a security path.
   */
  private async assertClientNotRevoked(clientId: string): Promise<void> {
    try {
      const revoked = await this.rows(
        `SELECT deleted_at FROM oauth_clients
         WHERE client_id = $1 AND deleted_at IS NOT NULL`,
        [clientId],
      );
      if (revoked.length > 0) throw new Error("Client has been revoked");
    } catch (e) {
      if (e instanceof Error && e.message === "Client has been revoked") {
        throw e;
      }
      if (!isUndefinedColumnError(e, "deleted_at")) throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Delete expired access/refresh tokens and authorization codes. Returns
   *  the total row count swept. */
  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const tokens = await this.rows(
      `DELETE FROM oauth_tokens WHERE expires_at < $1 RETURNING 1`,
      [now],
    );
    const codes = await this.rows(
      `DELETE FROM oauth_codes WHERE expires_at < $1 RETURNING 1`,
      [now],
    );
    return tokens.length + codes.length;
  }

  // -------------------------------------------------------------------------
  // Internal: issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
    ttlOverride?: number,
  ): Promise<OAuthTokens> {
    const accessToken = generateToken("memex_at_");
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const effectiveTtl = ttlOverride || this.tokenTtl;
    const accessExpiry = now + effectiveTtl;

    await this.engine.query(
      `INSERT INTO oauth_tokens
         (token_hash, token_type, client_id, scopes, expires_at, resource)
       VALUES ($1, 'access', $2, $3::text[], $4, $5)`,
      [accessHash, clientId, scopes, accessExpiry, resource?.toString() ?? null],
    );

    const result: OAuthTokens = {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: effectiveTtl,
      scope: scopes.join(" "),
    };

    if (includeRefresh) {
      const refreshToken = generateToken("memex_rt_");
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = now + this.refreshTtl;

      await this.engine.query(
        `INSERT INTO oauth_tokens
           (token_hash, token_type, client_id, scopes, expires_at, resource)
         VALUES ($1, 'refresh', $2, $3::text[], $4, $5)`,
        [
          refreshHash,
          clientId,
          scopes,
          refreshExpiry,
          resource?.toString() ?? null,
        ],
      );

      result.refresh_token = refreshToken;
    }

    return result;
  }
}
