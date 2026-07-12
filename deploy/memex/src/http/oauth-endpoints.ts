/**
 * OAuth 2.1 HTTP endpoints — the standard MCP-client flow wired over Bun.serve.
 *
 * The OAuthProvider (core/oauth-provider.ts) owns all DB access + crypto; this
 * module is the transport glue that maps HTTP requests onto provider calls and
 * shapes the RFC responses. Four routes, each reachable BEFORE a client holds a
 * token, so all are exempt from the public bearer (see http/public_guard.ts).
 * Each enforces its OWN validation:
 *
 *   GET  /authorize  — authorization-code + PKCE (S256) kickoff (RFC 6749 §4.1)
 *   POST /token      — authorization_code / refresh_token / client_credentials
 *   POST /register   — Dynamic Client Registration (RFC 7591)
 *   POST /revoke     — token revocation (RFC 7009)
 *
 * PKCE note: memex does NOT use the MCP SDK's Express auth router, so the S256
 * verification the SDK normally performs at the token endpoint is done HERE
 * (`verifyPkceS256`) BEFORE the provider consumes the code. The provider's
 * `exchangeAuthorizationCode` still binds client_id + redirect_uri + single-use
 * atomically in its DELETE…RETURNING, so a wrong client / wrong redirect_uri /
 * replayed code all fail cleanly regardless of this layer.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  OAuthProvider,
  OAuthClientInfo,
} from "../core/oauth-provider.ts";
import { parseScopeString } from "../core/scope.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** RFC 6749 §5.2 error body with a no-store header (tokens must not be cached). */
function oauthError(
  error: string,
  description: string | undefined,
  status: number,
): Response {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Parse a form-encoded or JSON request body into a URLSearchParams. Returns
 * null on a malformed body so the caller can answer `invalid_request`.
 */
async function readParams(req: Request): Promise<URLSearchParams | null> {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = (await req.json()) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(j)) {
        if (typeof v === "string") p.set(k, v);
      }
      return p;
    }
    return new URLSearchParams(await req.text());
  } catch {
    return null;
  }
}

/**
 * Extract client credentials from a token/revoke request. A confidential client
 * presents its secret either in the body (`client_secret_post`) or an HTTP Basic
 * header (`client_secret_basic`); a public PKCE client presents neither.
 */
function clientAuthFromRequest(
  req: Request,
  params: URLSearchParams,
): { clientId?: string; clientSecret?: string } {
  let clientId = params.get("client_id") ?? undefined;
  let clientSecret = params.get("client_secret") ?? undefined;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!clientSecret && authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString(
        "utf8",
      );
      const idx = decoded.indexOf(":");
      if (idx > -1) {
        clientId = clientId ?? decodeURIComponent(decoded.slice(0, idx));
        clientSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    } catch {
      // Malformed Basic header — treated as no credentials (public path).
    }
  }
  return { clientId, clientSecret };
}

/**
 * PKCE S256 check (RFC 7636 §4.6): BASE64URL(SHA256(code_verifier)) must equal
 * the challenge stored at /authorize. Constant-time compare on the digests.
 */
function verifyPkceS256(codeVerifier: string, storedChallenge: string): boolean {
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedChallenge, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve + authenticate the client for a token/revoke request. Confidential
 * clients are verified against the stored secret hash; public clients (no
 * secret) must be registered with `token_endpoint_auth_method='none'`. Throws
 * an opaque "Invalid client" on any failure so the caller collapses to 401 and
 * never reveals whether the client_id exists.
 */
async function resolveClient(
  provider: OAuthProvider,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<OAuthClientInfo> {
  if (!clientId) throw new Error("Invalid client");
  if (clientSecret) {
    return provider.verifyConfidentialClientSecret(clientId, clientSecret);
  }
  const client = await provider.getClient(clientId);
  if (!client) throw new Error("Invalid client");
  // A confidential client (non-null stored secret) MUST present its secret; a
  // registered public client has a NULL secret hash (getClient → undefined).
  if (client.client_secret !== undefined) throw new Error("Invalid client");
  return client;
}

// ---------------------------------------------------------------------------
// POST /token — authorization_code / refresh_token / client_credentials
// ---------------------------------------------------------------------------

/**
 * The OAuth 2.1 token endpoint. `client_credentials` (machine-to-machine) mints
 * an access token from a client secret; `authorization_code` completes the PKCE
 * flow; `refresh_token` rotates. Any client/secret failure on the two latter
 * grants collapses to `invalid_client` 401; grant/code/verifier problems are
 * `invalid_grant` 400. client_credentials keeps its historical single 401.
 */
export async function handleTokenRoute(
  req: Request,
  provider: OAuthProvider,
): Promise<Response> {
  const params = await readParams(req);
  if (!params) return oauthError("invalid_request", "malformed body", 400);
  const grantType = params.get("grant_type");

  if (grantType === "client_credentials") {
    const clientId = params.get("client_id");
    const clientSecret = params.get("client_secret");
    if (!clientId || !clientSecret) {
      return oauthError(
        "invalid_client",
        "client_id and client_secret are required",
        401,
      );
    }
    try {
      const tokens = await provider.exchangeClientCredentials(
        clientId,
        clientSecret,
        params.get("scope") ?? undefined,
      );
      return Response.json(tokens, { status: 200, headers: NO_STORE });
    } catch {
      // Never distinguish unknown-client / bad-secret / wrong-grant.
      return oauthError("invalid_client", undefined, 401);
    }
  }

  if (grantType === "authorization_code" || grantType === "refresh_token") {
    const { clientId, clientSecret } = clientAuthFromRequest(req, params);
    let client: OAuthClientInfo;
    try {
      client = await resolveClient(provider, clientId, clientSecret);
    } catch {
      return oauthError("invalid_client", "client authentication failed", 401);
    }

    try {
      if (grantType === "authorization_code") {
        const code = params.get("code");
        const redirectUri = params.get("redirect_uri");
        const codeVerifier = params.get("code_verifier");
        // redirect_uri is required so the provider's binding check runs; the
        // verifier is required because every code is minted PKCE-bound.
        if (!code || !redirectUri || !codeVerifier) {
          return oauthError(
            "invalid_request",
            "code, redirect_uri, and code_verifier are required",
            400,
          );
        }
        // PKCE S256 verification (this replaces the SDK router's check). On a
        // mismatch we DO NOT consume the code — the legitimate client, which
        // holds the real verifier, can still redeem it.
        const challenge = await provider.challengeForAuthorizationCode(
          client,
          code,
        );
        if (!verifyPkceS256(codeVerifier, challenge)) {
          return oauthError("invalid_grant", "PKCE verification failed", 400);
        }
        const tokens = await provider.exchangeAuthorizationCode(
          client,
          code,
          codeVerifier,
          redirectUri,
        );
        return Response.json(tokens, { status: 200, headers: NO_STORE });
      }

      // refresh_token
      const refreshToken = params.get("refresh_token");
      if (!refreshToken) {
        return oauthError("invalid_request", "refresh_token is required", 400);
      }
      const scopeParam = params.get("scope");
      const scopes = scopeParam ? parseScopeString(scopeParam) : undefined;
      const tokens = await provider.exchangeRefreshToken(
        client,
        refreshToken,
        scopes,
      );
      return Response.json(tokens, { status: 200, headers: NO_STORE });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid grant";
      return oauthError("invalid_grant", msg, 400);
    }
  }

  return oauthError("unsupported_grant_type", undefined, 400);
}

// ---------------------------------------------------------------------------
// GET /authorize — authorization-code + PKCE (S256)
// ---------------------------------------------------------------------------

/** Redirect back to the client with an OAuth error (RFC 6749 §4.1.2.1). Only
 *  used once the redirect_uri is confirmed registered — never before. */
function errorRedirect(
  redirectUri: string,
  error: string,
  state: string | undefined,
  description?: string,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: u.toString() } });
}

/**
 * The authorization endpoint. Validates client_id + an EXACT-match redirect_uri
 * against the client's registered allowlist BEFORE trusting either — an unknown
 * client or unregistered redirect_uri gets a direct 400 (never a redirect to an
 * attacker-controlled URI). Once the redirect_uri is trusted, response_type /
 * PKCE parameter errors are reported as an error redirect carrying `state`. On
 * success a one-time, PKCE-bound code is issued and the browser is 302'd back.
 */
export async function handleAuthorizeRoute(
  req: Request,
  provider: OAuthProvider,
  /**
   * Resource-owner authentication gate. By DEFAULT this auto-approves (returns
   * true), so a standard MCP client (Claude.ai etc.) completes the
   * authorization-code flow with no extra step.
   * An operator who wants the stricter posture sets `MEMEX_OAUTH_REQUIRE_LOGIN=1`
   * (wired in server.ts), which passes `adminAuth.requireAdmin` here: then a code
   * is only ever minted for a logged-in operator and an unauthenticated browser
   * is bounced to `/admin/login`. DCR clients are read/write-only regardless, so
   * auto-approve cannot yield an elevated token.
   */
  isResourceOwnerAuthenticated: (req: Request) => boolean = () => true,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");

  if (!clientId) {
    return oauthError("invalid_request", "client_id is required", 400);
  }
  const client = await provider.getClient(clientId);
  if (!client) return oauthError("invalid_client", "unknown client", 400);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return oauthError(
      "invalid_request",
      "redirect_uri is not registered for this client",
      400,
    );
  }

  // redirect_uri is now trusted — parameter errors go back to it.
  const state = q.get("state") ?? undefined;
  if (q.get("response_type") !== "code") {
    return errorRedirect(redirectUri, "unsupported_response_type", state);
  }
  const codeChallenge = q.get("code_challenge");
  const method = q.get("code_challenge_method");
  if (!codeChallenge) {
    return errorRedirect(
      redirectUri,
      "invalid_request",
      state,
      "code_challenge is required (PKCE)",
    );
  }
  // S256 only — plain is refused (a method omitted defaults to S256 here).
  if (method && method !== "S256") {
    return errorRedirect(
      redirectUri,
      "invalid_request",
      state,
      "only the S256 code_challenge_method is supported",
    );
  }

  const scopeParam = q.get("scope");
  const resourceParam = q.get("resource");
  let resource: URL | undefined;
  if (resourceParam) {
    try {
      resource = new URL(resourceParam);
    } catch {
      // A bad resource indicator is non-fatal — drop it rather than fail.
    }
  }

  // Resource-owner gate: never issue a code without a logged-in operator. Bounce
  // an unauthenticated browser to the admin login, carrying the full authorize
  // URL so it can resume after sign-in. Placed AFTER param validation so a
  // malformed request still fails fast, but BEFORE any code is minted.
  if (!isResourceOwnerAuthenticated(req)) {
    const returnTo = encodeURIComponent(req.url);
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/login?return_to=${returnTo}` },
    });
  }

  try {
    const { redirectUrl } = await provider.authorize(client, {
      codeChallenge,
      redirectUri,
      ...(scopeParam ? { scopes: parseScopeString(scopeParam) } : {}),
      ...(state ? { state } : {}),
      ...(resource ? { resource } : {}),
    });
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    });
  } catch {
    return errorRedirect(redirectUri, "server_error", state);
  }
}

// ---------------------------------------------------------------------------
// POST /register — Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

/**
 * Dynamic Client Registration. Accepts client metadata as JSON, delegates the
 * security-relevant validation (HTTPS redirect_uris, allowed scopes, allowed
 * auth method) to the provider, and returns the RFC 7591 §3.2.1 response with
 * the freshly minted client_id (+ secret for confidential clients). Rejections
 * map to `invalid_redirect_uri` / `invalid_client_metadata` (§3.2.2).
 */
export async function handleRegisterRoute(
  req: Request,
  provider: OAuthProvider,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return oauthError(
      "invalid_client_metadata",
      "request body must be JSON",
      400,
    );
  }

  const redirectUris = body.redirect_uris;
  if (redirectUris !== undefined && !Array.isArray(redirectUris)) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris must be an array",
      400,
    );
  }
  const grantTypes = body.grant_types;
  if (grantTypes !== undefined && !Array.isArray(grantTypes)) {
    return oauthError(
      "invalid_client_metadata",
      "grant_types must be an array",
      400,
    );
  }

  try {
    const client = await provider.registerClient({
      ...(typeof body.client_name === "string"
        ? { client_name: body.client_name }
        : {}),
      ...(redirectUris
        ? { redirect_uris: (redirectUris as unknown[]).map(String) }
        : {}),
      ...(grantTypes
        ? { grant_types: (grantTypes as unknown[]).map(String) }
        : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      ...(typeof body.token_endpoint_auth_method === "string"
        ? { token_endpoint_auth_method: body.token_endpoint_auth_method }
        : {}),
    });
    return Response.json(client, { status: 201, headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid client metadata";
    const error = /redirect_uri/i.test(msg)
      ? "invalid_redirect_uri"
      : "invalid_client_metadata";
    return oauthError(error, msg, 400);
  }
}

// ---------------------------------------------------------------------------
// POST /revoke — token revocation (RFC 7009)
// ---------------------------------------------------------------------------

/**
 * Token revocation. Authenticates the client (so a client can only revoke its
 * own tokens, RFC 7009 §2.1) and soft-revokes the token. Per §2.2 the endpoint
 * answers 200 even for an unknown / already-invalid token — it never confirms
 * whether the token existed.
 */
export async function handleRevokeRoute(
  req: Request,
  provider: OAuthProvider,
): Promise<Response> {
  const params = await readParams(req);
  if (!params) return oauthError("invalid_request", "malformed body", 400);
  const token = params.get("token");
  if (!token) return oauthError("invalid_request", "token is required", 400);

  const { clientId, clientSecret } = clientAuthFromRequest(req, params);
  let client: OAuthClientInfo;
  try {
    client = await resolveClient(provider, clientId, clientSecret);
  } catch {
    return oauthError("invalid_client", "client authentication failed", 401);
  }

  const hint = params.get("token_type_hint");
  await provider.revokeToken(client, {
    token,
    ...(hint ? { token_type_hint: hint } : {}),
  });
  return new Response(null, { status: 200, headers: NO_STORE });
}
