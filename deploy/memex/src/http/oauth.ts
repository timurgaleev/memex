/**
 * Optional OAuth/JWT bearer verification for the public ingress.
 *
 * DEFAULT-OFF. This path is invoked ONLY when `config.auth.oauth.enabled`
 * is true AND the static public-bearer check has already failed for a
 * public request. A validated JWT is mapped to the EXISTING public
 * (redacted) read scope — the same `isPublic: true` branch the static
 * bearer joins, with the same `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` set
 * enforced downstream. It NEVER grants internal scope.
 *
 * memex is a single-holder personal brain: there is no per-user data
 * model (no `user_id` on documents/pages). "Multi-user" here means only
 * "accept tokens from a configured IdP as an alternative credential for
 * the one public read scope." A real tenancy / data-partitioning model
 * is a separate project and is intentionally NOT built here.
 *
 * Verification is fail-closed: any error (bad signature, expired,
 * wrong issuer/audience, malformed token, JWKS fetch failure, unknown
 * `kid`, unsupported `alg`) returns `{ ok: false }` and the caller
 * stays unauthenticated. No new outbound call is ever made unless OAuth
 * is enabled and a JWT is actually presented.
 *
 * No new dependency: RS256 / ES256 signatures are verified with Bun's
 * WebCrypto (`crypto.subtle`). `fetchJwks` and `now` are injectable
 * seams so the test suite runs fully offline and deterministically.
 */

// --- Config shape ----------------------------------------------------------

export interface OAuthConfig {
  /** Master switch. When false/absent the whole path is dead code. */
  enabled?: boolean;
  /** Expected `iss` claim AND base for JWKS discovery if jwks_uri absent. */
  issuer: string;
  /** JWKS endpoint. Required — we do not auto-derive it to avoid surprises. */
  jwks_uri: string;
  /** Expected `aud` claim. A token's `aud` must contain this value. */
  audience: string;
  /**
   * Optional `sub` allowlist. When non-empty, the token's `sub` must be a
   * member or verification fails. Empty/absent → any validly-signed token
   * from the issuer is accepted (still public-scope only).
   */
  allowed_subs?: string[];
  /**
   * Clock-skew tolerance in seconds for exp/nbf. Default 60. Bounded so a
   * misconfig can't disable expiry entirely.
   */
  clock_skew_s?: number;
}

// --- Result type -----------------------------------------------------------

export type OAuthResult =
  | { ok: true; sub: string }
  | { ok: false; reason: string };

// --- JWKS types ------------------------------------------------------------

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  // RSA
  n?: string;
  e?: string;
  // EC
  crv?: string;
  x?: string;
  y?: string;
}

interface JwksDoc {
  keys: Jwk[];
}

export type FetchJwks = (jwksUri: string) => Promise<JwksDoc>;

export interface VerifyDeps {
  /** Override the JWKS fetcher (tests inject an offline stub). */
  fetchJwks?: FetchJwks;
  /** Override the clock. Returns epoch milliseconds. */
  now?: () => number;
}

// --- JWKS cache ------------------------------------------------------------

/**
 * Process-wide JWKS cache keyed by `${jwksUri}#${kid}`. Populated on the
 * first token presenting a given kid and refreshed on a cache miss (key
 * rotation). A short TTL bounds staleness without re-fetching per request.
 */
const JWKS_TTL_MS = 5 * 60_000;

interface CachedKey {
  jwk: Jwk;
  fetchedAt: number;
}

const keyCache = new Map<string, CachedKey>();

/** Exposed for tests: clear cached JWKS between cases. */
export function __clearJwksCache(): void {
  keyCache.clear();
}

// --- base64url helpers -----------------------------------------------------

function b64urlToBytes(s: string): Uint8Array {
  // Reject anything outside the base64url alphabet rather than letting
  // atob silently coerce — a malformed segment must fail closed.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error("invalid base64url");
  }
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// --- JWT structure ---------------------------------------------------------

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
}

interface ParsedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("token is not a three-part JWS");
  }
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(b64urlToString(h)) as unknown;
  const claims = JSON.parse(b64urlToString(p)) as unknown;
  if (typeof header !== "object" || header === null) {
    throw new Error("malformed JWT header");
  }
  if (typeof claims !== "object" || claims === null) {
    throw new Error("malformed JWT claims");
  }
  return {
    header: header as JwtHeader,
    claims: claims as JwtClaims,
    signingInput: new TextEncoder().encode(`${h}.${p}`),
    signature: b64urlToBytes(s),
  };
}

// --- key import + signature verify -----------------------------------------

const SUPPORTED_ALGS = new Set(["RS256", "ES256"]);

async function importVerifyKey(jwk: Jwk, alg: string): Promise<CryptoKey> {
  // Bind the JWK to the token alg / a signing purpose. WebCrypto would
  // happily import an RSA encryption key for RS256 verify, so reject a
  // key whose declared `use`/`alg` contradict a signature check.
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new Error("JWKS key is not a signing key");
  }
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    throw new Error("JWKS key alg does not match token alg");
  }
  if (alg === "RS256") {
    return crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  // ES256
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

async function verifySignature(
  alg: string,
  key: CryptoKey,
  parsed: ParsedJwt,
): Promise<boolean> {
  const algParams =
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: "SHA-256" };
  return crypto.subtle.verify(
    algParams,
    key,
    // Copy into a fresh ArrayBuffer so the BufferSource is exactly the
    // signature bytes (a Uint8Array view over a larger buffer would pass
    // its whole backing store).
    parsed.signature.slice().buffer,
    parsed.signingInput.slice().buffer,
  );
}

// --- JWKS resolution -------------------------------------------------------

async function resolveKey(
  jwksUri: string,
  kid: string | undefined,
  fetchJwks: FetchJwks,
  now: number,
): Promise<Jwk> {
  const cacheKey = `${jwksUri}#${kid ?? ""}`;
  const cached = keyCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.jwk;
  }

  const doc = await fetchJwks(jwksUri);
  if (!doc || !Array.isArray(doc.keys)) {
    throw new Error("JWKS response missing keys[]");
  }
  // When the token carries a kid, match it; otherwise (single-key JWKS)
  // fall back to the sole key. Ambiguity with no kid is rejected.
  let match: Jwk | undefined;
  if (kid) {
    match = doc.keys.find((k) => k.kid === kid);
  } else if (doc.keys.length === 1) {
    match = doc.keys[0];
  }
  if (!match) {
    throw new Error("no JWKS key matches token kid");
  }
  keyCache.set(cacheKey, { jwk: match, fetchedAt: now });
  return match;
}

// --- claim checks ----------------------------------------------------------

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

function checkClaims(claims: JwtClaims, cfg: OAuthConfig, nowSec: number): string | null {
  const skew = cfg.clock_skew_s ?? 60;

  if (claims.iss !== cfg.issuer) return "iss mismatch";
  if (!audienceMatches(claims.aud, cfg.audience)) return "aud mismatch";

  if (typeof claims.exp !== "number") return "missing exp";
  if (nowSec > claims.exp + skew) return "token expired";

  if (typeof claims.nbf === "number" && nowSec + skew < claims.nbf) {
    return "token not yet valid";
  }

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return "missing sub";
  }

  const allow = cfg.allowed_subs;
  if (allow && allow.length > 0 && !allow.includes(claims.sub)) {
    return "sub not in allowlist";
  }

  return null;
}

// --- public entry point ----------------------------------------------------

const defaultFetchJwks: FetchJwks = async (jwksUri) => {
  const res = await fetch(jwksUri, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as JwksDoc;
};

/**
 * Verify an OAuth/JWT bearer against the configured issuer.
 *
 * Returns `{ ok: true, sub }` only when the signature, all standard
 * claims (iss/aud/exp/nbf), and the optional sub allowlist pass. Any
 * failure returns `{ ok: false, reason }` — the reason is for server
 * logs only and MUST NOT be echoed to the caller (fail-closed: every
 * branch outside the happy path is a 401).
 *
 * Disabled config (`enabled !== true`) short-circuits to a rejection
 * WITHOUT touching the token or making any network call.
 */
export async function verifyOAuthToken(
  token: string,
  cfg: OAuthConfig | undefined,
  deps: VerifyDeps = {},
): Promise<OAuthResult> {
  if (!cfg || cfg.enabled !== true) {
    return { ok: false, reason: "oauth disabled" };
  }
  if (!cfg.issuer || !cfg.jwks_uri || !cfg.audience) {
    return { ok: false, reason: "oauth config incomplete" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "empty token" };
  }

  const fetchJwks = deps.fetchJwks ?? defaultFetchJwks;
  const nowMs = (deps.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);

  try {
    const parsed = parseJwt(token);

    const alg = parsed.header.alg ?? "";
    if (!SUPPORTED_ALGS.has(alg)) {
      return { ok: false, reason: `unsupported alg: ${alg || "none"}` };
    }

    // Verify the signature BEFORE trusting any claim. resolveKey may fetch
    // (and cache) the JWKS; a cache miss on the kid forces a fresh fetch.
    const jwk = await resolveKey(cfg.jwks_uri, parsed.header.kid, fetchJwks, nowMs);
    const key = await importVerifyKey(jwk, alg);
    const sigOk = await verifySignature(alg, key, parsed);
    if (!sigOk) {
      return { ok: false, reason: "bad signature" };
    }

    const claimErr = checkClaims(parsed.claims, cfg, nowSec);
    if (claimErr) {
      return { ok: false, reason: claimErr };
    }

    // checkClaims guarantees sub is a non-empty string.
    return { ok: true, sub: parsed.claims.sub as string };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "verification error",
    };
  }
}
