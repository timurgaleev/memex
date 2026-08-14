/**
 * OAuth 2.1 authorization-server discovery — the RFC 8414 metadata document
 * served at `GET /.well-known/oauth-authorization-server`.
 *
 * A standard MCP OAuth client fetches this document first to auto-configure: it
 * learns the issuer, the endpoints, the scopes it may request, and the
 * supported grant + PKCE methods. Without it, an operator has to hand-configure
 * every client. memex now serves the full standard surface — `/authorize`
 * (authorization-code + PKCE), `/token` (authorization_code / refresh_token /
 * client_credentials), `/register` (RFC 7591 DCR), and `/revoke` (RFC 7009) —
 * so all four are advertised. The endpoints point at memex's OWN public base
 * URL so the issuer claim matches the URL clients actually hit (RFC 8414 §3.3)
 * — a mismatch makes strict clients reject the minted tokens.
 *
 * This endpoint is PUBLIC (no bearer) — it is exempted in the public guard
 * exactly like `/health`, since a client must reach it BEFORE it holds any
 * credential.
 */
import { ALLOWED_SCOPES_LIST } from "../core/scope.ts";

export const OAUTH_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** RFC 9728 protected-resource metadata path (served alongside the AS doc). */
export const OAUTH_PROTECTED_RESOURCE_PATH =
  "/.well-known/oauth-protected-resource";

/**
 * RFC 8414 authorization-server metadata. Only the fields memex actually
 * honors are advertised:
 *  - grants: `authorization_code` + `refresh_token` (PKCE flow) and
 *    `client_credentials` (machine-to-machine) — all live on POST /token.
 *  - `response_types_supported: ["code"]` — the only response type /authorize
 *    issues.
 *  - auth methods: `client_secret_post` (secret in the body),
 *    `client_secret_basic` (secret in an HTTP Basic header), and `none`
 *    (public/PKCE clients).
 *  - `S256` PKCE only — plain is refused.
 */
export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** Advertised only when Dynamic Client Registration is enabled (MEMEX_ENABLE_DCR).
   *  Omitted by default so a client doesn't attempt (and a scanner doesn't find) a
   *  self-registration endpoint that isn't there. */
  registration_endpoint?: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
}

/**
 * Resolve the public base URL the discovery document advertises. Prefers an
 * explicitly-declared issuer (`publicUrl` opt / `MEMEX_PUBLIC_URL` env) so a
 * Cloudflare-tunnel deploy advertises its external `https://…` origin rather
 * than the internal request host. Falls back to the request's own origin for
 * local/dev where no public URL is set. The trailing slash is stripped so the
 * emitted endpoints never contain a `//`.
 */
export function resolveIssuer(url: URL, publicUrl?: string): string {
  const declared = (publicUrl ?? process.env.MEMEX_PUBLIC_URL ?? "").trim();
  const base = declared.length > 0 ? declared : `${url.protocol}//${url.host}`;
  // `(?<!\/)` keeps the strip linear. `base` is an operator-supplied issuer
  // (`publicUrl` / MEMEX_PUBLIC_URL) with no length bound; unguarded, `\/+$`
  // restarts at every slash of a run and walks to the end each time — measured
  // through resolveIssuer on `/`*n + `x` at 225 ms for 25 K, 15 s for 200 K,
  // ratio 4.0 on a doubling. Guarded, only a run's first slash is a candidate:
  // 19 ms at 2 M, ratio 2.0. Language is untouched — a greedy `\/+$` could only
  // ever match the maximal trailing run, verified over 400 K random strings.
  return base.replace(/(?<!\/)\/+$/, "");
}

/** Build the RFC 8414 metadata object for a given issuer base URL. `dcrEnabled`
 *  controls whether the self-registration endpoint is advertised. */
export function buildOAuthMetadata(
  issuer: string,
  dcrEnabled = false,
): OAuthMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(dcrEnabled ? { registration_endpoint: `${issuer}/register` } : {}),
    revocation_endpoint: `${issuer}/revoke`,
    scopes_supported: [...ALLOWED_SCOPES_LIST],
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
  };
}

/**
 * Route handler for `GET /.well-known/oauth-authorization-server`. Returns the
 * discovery JSON with a short-lived cache header (the document is stable but an
 * issuer change should propagate within the hour).
 */
export function handleOAuthMetadataRoute(
  url: URL,
  publicUrl?: string,
  dcrEnabled = false,
): Response {
  const declared = ((publicUrl ?? process.env.MEMEX_PUBLIC_URL ?? "").trim()).length > 0;
  const issuer = resolveIssuer(url, publicUrl);
  // Only a DECLARED issuer (publicUrl / MEMEX_PUBLIC_URL) is safe to cache
  // publicly. When we fall back to the request Host, a shared cache could be
  // poisoned by a spoofed Host so the advertised token_endpoint points at an
  // attacker — so a host-derived doc is `no-store`. Prod always declares the URL.
  const cache = declared ? "public, max-age=3600" : "no-store";
  return Response.json(buildOAuthMetadata(issuer, dcrEnabled), {
    status: 200,
    headers: { "Cache-Control": cache },
  });
}

/**
 * RFC 9728 OAuth protected-resource metadata. memex is both the resource
 * server (`/mcp`) and its own authorization server, so `resource` and the
 * single `authorization_servers` entry are the same issuer. Standard MCP
 * OAuth clients (Claude, ChatGPT, …) fetch this document when a 401's
 * `WWW-Authenticate` challenge points at it, then discover the AS from it —
 * closing the loop for clients that start at the resource instead of the
 * authorization-server document.
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

export function buildProtectedResourceMetadata(
  issuer: string,
): ProtectedResourceMetadata {
  return {
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: [...ALLOWED_SCOPES_LIST],
    // Bearer tokens are accepted in the Authorization header only (RFC 6750
    // §2.1) — never as query param or form field.
    bearer_methods_supported: ["header"],
    resource_name: "memex",
  };
}

/** Route handler for `GET /.well-known/oauth-protected-resource`. Same
 *  issuer + cache rules as the authorization-server document. */
export function handleProtectedResourceRoute(
  url: URL,
  publicUrl?: string,
): Response {
  const declared = ((publicUrl ?? process.env.MEMEX_PUBLIC_URL ?? "").trim()).length > 0;
  const issuer = resolveIssuer(url, publicUrl);
  const cache = declared ? "public, max-age=3600" : "no-store";
  return Response.json(buildProtectedResourceMetadata(issuer), {
    status: 200,
    headers: { "Cache-Control": cache },
  });
}

/**
 * `WWW-Authenticate` challenge value for a 401 on `/mcp` (RFC 9728 §5.1).
 * The `resource_metadata` parameter tells a standards-aware client exactly
 * where to fetch the protected-resource document above, from which it
 * discovers the authorization server and starts the OAuth flow unattended.
 */
export function wwwAuthenticateChallenge(issuer: string): string {
  return `Bearer error="invalid_token", resource_metadata="${issuer}${OAUTH_PROTECTED_RESOURCE_PATH}"`;
}
