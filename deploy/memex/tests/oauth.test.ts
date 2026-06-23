/**
 * OAuth/JWT verification tests — fully offline.
 *
 * Each case generates an RS256 (or ES256) keypair via WebCrypto, exports
 * the public half as a JWK, signs a JWT with the private half, and injects
 * an offline `fetchJwks` so no network call is ever made. `now` is injected
 * to make exp/nbf checks deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  verifyOAuthToken,
  __clearJwksCache,
  type OAuthConfig,
} from "../src/http/oauth.ts";

const ISSUER = "https://issuer.example.com/";
const JWKS_URI = "https://issuer.example.com/.well-known/jwks.json";
const AUDIENCE = "memex-public";
const KID = "test-key-1";

// crypto.subtle.exportKey("jwk") returns a JWK object. The DOM `Jwk`
// lib type isn't in this tsconfig's `lib` (ES2022 only), so model it locally
// as a mutable string map — enough to set kid/alg and feed back as a key.
type Jwk = Record<string, unknown>;

// Fixed clock: 2026-01-01T00:00:00Z in seconds.
const NOW_SEC = 1_767_225_600;
const NOW_MS = NOW_SEC * 1000;
const now = () => NOW_MS;

function baseConfig(over: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    enabled: true,
    issuer: ISSUER,
    jwks_uri: JWKS_URI,
    audience: AUDIENCE,
    ...over,
  };
}

// --- low-level JWT signing helpers -----------------------------------------

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

interface SigningKey {
  privateKey: CryptoKey;
  jwk: Jwk;
  sign: { name: string; hash?: string };
}

async function genRs256(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  jwk.kid = KID;
  jwk.alg = "RS256";
  return { privateKey: pair.privateKey, jwk, sign: { name: "RSASSA-PKCS1-v1_5" } };
}

async function genEs256(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  jwk.kid = KID;
  jwk.alg = "ES256";
  return {
    privateKey: pair.privateKey,
    jwk,
    sign: { name: "ECDSA", hash: "SHA-256" },
  };
}

async function signJwt(
  key: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const alg = key.jwk.alg as string;
  const h = b64urlJson({ alg, typ: "JWT", kid: KID, ...header });
  const p = b64urlJson(claims);
  const signingInput = new TextEncoder().encode(`${h}.${p}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign(key.sign, key.privateKey, signingInput),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

function validClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: "user-123",
    aud: AUDIENCE,
    iat: NOW_SEC - 10,
    nbf: NOW_SEC - 10,
    exp: NOW_SEC + 3600,
    ...over,
  };
}

// fetchJwks stub bound to a specific public JWK.
function jwksStub(jwk: Jwk) {
  return async () => ({ keys: [jwk as unknown as Record<string, unknown>] }) as never;
}

describe("verifyOAuthToken", () => {
  let rs: SigningKey;

  beforeEach(async () => {
    __clearJwksCache();
    rs = await genRs256();
  });
  afterEach(() => __clearJwksCache());

  it("accepts a valid RS256 token", async () => {
    const jwt = await signJwt(rs, validClaims());
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub).toBe("user-123");
  });

  it("accepts a valid ES256 token", async () => {
    const es = await genEs256();
    const jwt = await signJwt(es, validClaims());
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(es.jwk),
      now,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub).toBe("user-123");
  });

  it("rejects when oauth is disabled (default)", async () => {
    const jwt = await signJwt(rs, validClaims());
    const r = await verifyOAuthToken(jwt, baseConfig({ enabled: false }), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when config is undefined (default-off)", async () => {
    const jwt = await signJwt(rs, validClaims());
    const r = await verifyOAuthToken(jwt, undefined, {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
  });

  it("does NOT fetch JWKS when disabled", async () => {
    let fetched = false;
    const jwt = await signJwt(rs, validClaims());
    await verifyOAuthToken(jwt, baseConfig({ enabled: false }), {
      fetchJwks: async () => {
        fetched = true;
        return { keys: [] } as never;
      },
      now,
    });
    expect(fetched).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const jwt = await signJwt(rs, validClaims());
    // Flip the FIRST char of the signature segment — its bits are always
    // significant (the last char can hold only padding bits, where a flip
    // may decode to the same bytes and leave the signature intact).
    const parts = jwt.split(".");
    const sig = parts[2] as string;
    const firstCh = sig.slice(0, 1) === "A" ? "B" : "A";
    parts[2] = firstCh + sig.slice(1);
    const r = await verifyOAuthToken(parts.join("."), baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad signature");
  });

  it("rejects a token signed by a DIFFERENT key", async () => {
    const other = await genRs256();
    const jwt = await signJwt(other, validClaims());
    // JWKS only advertises the original public key.
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad signature");
  });

  it("rejects an expired token", async () => {
    const jwt = await signJwt(rs, validClaims({ exp: NOW_SEC - 3600 }));
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("token expired");
  });

  it("rejects a not-yet-valid token (nbf in the future)", async () => {
    const jwt = await signJwt(rs, validClaims({ nbf: NOW_SEC + 3600 }));
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("token not yet valid");
  });

  it("rejects a wrong issuer", async () => {
    const jwt = await signJwt(rs, validClaims({ iss: "https://evil.example/" }));
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("iss mismatch");
  });

  it("rejects a wrong audience", async () => {
    const jwt = await signJwt(rs, validClaims({ aud: "some-other-api" }));
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("aud mismatch");
  });

  it("accepts when aud is an array containing the audience", async () => {
    const jwt = await signJwt(rs, validClaims({ aud: ["x", AUDIENCE, "y"] }));
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("enforces the sub allowlist", async () => {
    const jwt = await signJwt(rs, validClaims({ sub: "stranger" }));
    const r = await verifyOAuthToken(
      jwt,
      baseConfig({ allowed_subs: ["user-123"] }),
      { fetchJwks: jwksStub(rs.jwk), now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("sub not in allowlist");
  });

  it("accepts an allowlisted sub", async () => {
    const jwt = await signJwt(rs, validClaims({ sub: "user-123" }));
    const r = await verifyOAuthToken(
      jwt,
      baseConfig({ allowed_subs: ["user-123", "other"] }),
      { fetchJwks: jwksStub(rs.jwk), now },
    );
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported alg (HS256)", async () => {
    // Build a structurally-valid token claiming HS256 — must be refused
    // before any key import.
    const h = b64url(
      new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID })),
    );
    const p = b64url(new TextEncoder().encode(JSON.stringify(validClaims())));
    const jwt = `${h}.${p}.AAAA`;
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unsupported alg");
  });

  it("rejects the 'alg: none' downgrade", async () => {
    const h = b64url(
      new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" })),
    );
    const p = b64url(new TextEncoder().encode(JSON.stringify(validClaims())));
    const jwt = `${h}.${p}.`;
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed (non-three-part) token", async () => {
    const r = await verifyOAuthToken("not-a-jwt", baseConfig(), {
      fetchJwks: jwksStub(rs.jwk),
      now,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when no JWKS key matches the kid", async () => {
    const jwt = await signJwt(rs, validClaims(), { kid: "unknown-kid" });
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(rs.jwk), // advertises kid=test-key-1 only
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no JWKS key matches token kid");
  });

  it("rejects a JWKS key marked for encryption (use=enc)", async () => {
    const encJwk = { ...(rs.jwk as Record<string, unknown>), use: "enc" } as Jwk;
    const jwt = await signJwt(rs, validClaims());
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(encJwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("JWKS key is not a signing key");
  });

  it("rejects a JWKS key whose alg contradicts the token alg", async () => {
    const mismatchJwk = {
      ...(rs.jwk as Record<string, unknown>),
      alg: "RS512",
    } as Jwk;
    const jwt = await signJwt(rs, validClaims());
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: jwksStub(mismatchJwk),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("JWKS key alg does not match token alg");
  });

  it("fails closed when JWKS fetch throws", async () => {
    const jwt = await signJwt(rs, validClaims());
    const r = await verifyOAuthToken(jwt, baseConfig(), {
      fetchJwks: async () => {
        throw new Error("network down");
      },
      now,
    });
    expect(r.ok).toBe(false);
  });

  it("caches JWKS — second verify does not re-fetch", async () => {
    let calls = 0;
    const stub = async () => {
      calls++;
      return { keys: [rs.jwk as unknown as Record<string, unknown>] } as never;
    };
    const jwt = await signJwt(rs, validClaims());
    await verifyOAuthToken(jwt, baseConfig(), { fetchJwks: stub, now });
    await verifyOAuthToken(jwt, baseConfig(), { fetchJwks: stub, now });
    expect(calls).toBe(1);
  });
});
