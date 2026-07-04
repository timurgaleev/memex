/**
 * OAuth 2.1 authorization-server discovery — the RFC 8414 metadata document
 * served at `GET /.well-known/oauth-authorization-server`.
 *
 * A standard MCP OAuth client fetches this document first to auto-configure: it
 * learns the issuer, the token endpoint, the scopes it may request, and the
 * supported grant types. Without it, an operator has to hand-configure every
 * client. Only the endpoints memex actually serves are advertised (today:
 * `client_credentials` at `/token`); the auth-code/DCR/revoke fields are added
 * back once those routes are wired. The endpoints point at memex's OWN public
 * base URL so the
 * issuer claim matches the URL clients actually hit (RFC 8414 §3.3) — a
 * mismatch makes strict clients reject the minted tokens.
 *
 * This endpoint is PUBLIC (no bearer) — it is exempted in the public guard
 * exactly like `/health`, since a client must reach it BEFORE it holds any
 * credential.
 */
import { ALLOWED_SCOPES_LIST } from "../core/scope.ts";

export const OAUTH_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * RFC 8414 authorization-server metadata. Only the fields memex actually
 * honors are advertised:
 *  - `client_credentials` (POST /token, live), plus `authorization_code` +
 *    `refresh_token` (the provider exposes both exchange paths).
 *  - `client_secret_post` (secret in the body) + `none` (public/PKCE clients);
 *    memex reads the secret from the form/JSON body, never HTTP Basic.
 *  - `S256` PKCE only — plain is refused.
 */
export interface OAuthMetadata {
  issuer: string;
  token_endpoint: string;
  scopes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  // authorization_endpoint / registration_endpoint / revocation_endpoint +
  // authorization_code/refresh_token grants + code_challenge_methods are added
  // back when the auth-code+PKCE / DCR / revoke HTTP routes are wired — the doc
  // MUST advertise only endpoints that actually exist, or a strict client will
  // try an auth-code flow that 404s. Today only client_credentials + /token live.
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
  return base.replace(/\/+$/, "");
}

/** Build the RFC 8414 metadata object for a given issuer base URL. */
export function buildOAuthMetadata(issuer: string): OAuthMetadata {
  return {
    issuer,
    token_endpoint: `${issuer}/token`,
    scopes_supported: [...ALLOWED_SCOPES_LIST],
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
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
): Response {
  const declared = ((publicUrl ?? process.env.MEMEX_PUBLIC_URL ?? "").trim()).length > 0;
  const issuer = resolveIssuer(url, publicUrl);
  // Only a DECLARED issuer (publicUrl / MEMEX_PUBLIC_URL) is safe to cache
  // publicly. When we fall back to the request Host, a shared cache could be
  // poisoned by a spoofed Host so the advertised token_endpoint points at an
  // attacker — so a host-derived doc is `no-store`. Prod always declares the URL.
  const cache = declared ? "public, max-age=3600" : "no-store";
  return Response.json(buildOAuthMetadata(issuer), {
    status: 200,
    headers: { "Cache-Control": cache },
  });
}
