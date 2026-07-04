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
  return base.replace(/\/+$/, "");
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
