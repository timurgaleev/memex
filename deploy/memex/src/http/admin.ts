/**
 * http/admin.ts — admin auth core (increment A1 of the admin surface).
 *
 * A cookie + magic-link auth surface for `/admin`, built on memex's Bun.serve.
 * Trust model:
 *   - A long-term BOOTSTRAP token is the server admin secret, from
 *     `MEMEX_ADMIN_BOOTSTRAP` (or a generated ephemeral one printed to stderr).
 *     PROD: set `MEMEX_ADMIN_BOOTSTRAP` explicitly — in a container the ephemeral
 *     token's stderr line goes to the docker/aggregated logs, not just a
 *     terminal. It never appears in a URL.
 *   - Magic-link URLs use one-time NONCES, not the bootstrap token: an agent
 *     calls `POST /admin/api/issue-magic-link` with the bootstrap token in
 *     `Authorization: Bearer` to mint a 5-minute single-use nonce. The browser
 *     redeems `GET /admin/auth/:nonce`, which sets an HttpOnly+SameSite=Strict
 *     cookie session. The BOOTSTRAP token never appears in a URL; the nonce DOES
 *     travel in the URL path (so it can land in browser history / proxy logs /
 *     Referer) — what contains that exposure is single-use + the 5-minute TTL,
 *     not URL hygiene.
 *   - Cookie sessions are in-memory (Map), so a restart signs everyone out.
 *
 * This increment ships the AUTH routes (`/admin/login`, `/admin/api/issue-magic-link`,
 * `/admin/auth/:nonce`, `/admin/api/sign-out-everywhere`) + `requireAdmin`. The
 * data endpoints (A2) and the embedded SPA (B/C) build on top.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { resolveClientKey } from "./client-key.ts";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h for password login
const MAGIC_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d for magic-link
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_LRU_CAP = 1000;
const COOKIE_NAME = "memex_admin";

/** Constant-time compare of two hex digests of equal length. */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Parse a single cookie value out of the request's Cookie header. */
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Build a Set-Cookie header value. Secure is set when the request arrived over
 *  https (behind a TLS-terminating proxy this rides the forwarded scheme). */
function buildSetCookie(req: Request, value: string, maxAgeMs: number): string {
  const url = new URL(req.url);
  const https = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (https) attrs.push("Secure");
  return attrs.join("; ");
}

const EXPIRED_LINK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>memex</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{max-width:400px;padding:32px;text-align:left}.logo{font-size:28px;font-weight:600;margin-bottom:24px}
.msg{color:#888;font-size:14px;line-height:1.6;margin-bottom:20px}
.hint{background:rgba(136,170,255,0.08);border:1px solid rgba(136,170,255,0.2);border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.5;color:#888}
.hint b{color:#e0e0e0}.prompt{background:rgba(0,0,0,0.3);border-radius:6px;padding:8px 12px;margin-top:8px;font-family:monospace;font-size:12px;color:#88aaff}
</style></head><body><div class="box">
<div class="logo">memex</div>
<div class="msg">⚠️ This admin link has expired, was already used, or the server has restarted.</div>
<div class="hint"><b>Get a fresh link from your AI agent:</b>
<div class="prompt">&ldquo;Give me the memex admin login link&rdquo;</div>
</div></div></body></html>`;

export interface AdminAuthOptions {
  /** The bootstrap admin token (its sha256 is the stored secret). */
  bootstrapToken: string;
  /** Public base URL for the minted magic-link (falls back to the request host). */
  publicUrl?: string;
}

export interface AdminAuth {
  /** True when the request carries a live admin session cookie. */
  requireAdmin(req: Request): boolean;
  /** Handle an `/admin` AUTH route. Returns a Response, or null when the path is
   *  not an auth route (so a later data/SPA dispatcher can take over). */
  handleAuthRoute(req: Request, url: URL): Promise<Response | null>;
}

export function createAdminAuth(opts: AdminAuthOptions): AdminAuth {
  const bootstrapHash = createHash("sha256").update(opts.bootstrapToken).digest("hex");
  const sessions = new Map<string, number>(); // sessionId → expiresAt
  const nonces = new Map<string, number>(); // nonce → expiresAt
  const consumed = new Set<string>();
  // 10 attempts / minute / client (capacity 10, refill 10/60s ≈ 0.1667/s).
  // The client key comes from http/client-key.ts — the SAME resolver every
  // other ingress bucket uses. The old local rule trusted X-Forwarded-For
  // unconditionally, so a caller could rotate that header and hand itself a
  // fresh 10-attempt bucket per login try; XFF now only counts under
  // MEMEX_HTTP_TRUST_PROXY, and unattributable callers share one bucket.
  const authLimiter = new RateLimiter({ capacity: 10, refillPerSecond: 10 / 60 });

  function pruneNonces(): void {
    const now = Date.now();
    for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
    if (nonces.size > NONCE_LRU_CAP) {
      const it = nonces.keys();
      for (let i = nonces.size - NONCE_LRU_CAP; i > 0; i--) nonces.delete(it.next().value as string);
    }
    if (consumed.size > NONCE_LRU_CAP) {
      const it = consumed.values();
      for (let i = consumed.size - NONCE_LRU_CAP; i > 0; i--) consumed.delete(it.next().value as string);
    }
  }

  function newSession(ttl: number): string {
    const id = randomBytes(32).toString("hex");
    sessions.set(id, Date.now() + ttl);
    return id;
  }

  function requireAdmin(req: Request): boolean {
    const id = readCookie(req, COOKIE_NAME);
    if (!id) return false;
    const exp = sessions.get(id);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  function bearerOk(req: Request): boolean {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m) return false;
    const hash = createHash("sha256").update(m[1]!).digest("hex");
    return safeHexEqual(hash, bootstrapHash);
  }

  async function handleAuthRoute(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;

    // POST /admin/login — JSON { token } → session cookie. Rate-limited per IP
    // so a weak operator-set bootstrap token can't be brute-forced online.
    if (p === "/admin/login" && req.method === "POST") {
      if (!authLimiter.allow(resolveClientKey(req))) {
        return Response.json({ error: "Too many attempts" }, { status: 429 });
      }
      let token: unknown;
      try {
        token = (await req.json() as { token?: unknown })?.token;
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      if (typeof token !== "string" || token.length === 0) {
        return Response.json({ error: "Token required" }, { status: 400 });
      }
      const hash = createHash("sha256").update(token).digest("hex");
      if (!safeHexEqual(hash, bootstrapHash)) {
        return Response.json({ error: "Invalid token. Check your terminal output." }, { status: 401 });
      }
      const id = newSession(SESSION_TTL_MS);
      return Response.json(
        { status: "authenticated" },
        { headers: { "Set-Cookie": buildSetCookie(req, id, SESSION_TTL_MS) } },
      );
    }

    // POST /admin/api/issue-magic-link — Bearer bootstrap → one-time nonce URL.
    if (p === "/admin/api/issue-magic-link" && req.method === "POST") {
      if (!bearerOk(req)) {
        return Response.json({ error: "Authorization: Bearer <bootstrap-token> required" }, { status: 401 });
      }
      pruneNonces();
      const nonce = randomBytes(32).toString("hex");
      nonces.set(nonce, Date.now() + NONCE_TTL_MS);
      const base = opts.publicUrl || `${url.protocol}//${url.host}`;
      return Response.json({ url: `${base}/admin/auth/${nonce}`, expires_in: NONCE_TTL_MS / 1000 });
    }

    // GET /admin/auth/:nonce — single-use redemption → session cookie + redirect.
    if (p.startsWith("/admin/auth/") && req.method === "GET") {
      if (!authLimiter.allow(resolveClientKey(req))) {
        return new Response("Too Many Requests", { status: 429 });
      }
      let nonce: string;
      try {
        nonce = decodeURIComponent(p.slice("/admin/auth/".length));
      } catch {
        // Malformed percent-encoding — treat as an invalid (expired) link, not a 500.
        return new Response(EXPIRED_LINK_HTML, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      pruneNonces();
      const exp = nonces.get(nonce);
      const valid = !!nonce && exp !== undefined && exp > Date.now() && !consumed.has(nonce);
      if (!valid) {
        return new Response(EXPIRED_LINK_HTML, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      nonces.delete(nonce);
      consumed.add(nonce);
      const id = newSession(MAGIC_SESSION_TTL_MS);
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin/", "Set-Cookie": buildSetCookie(req, id, MAGIC_SESSION_TTL_MS) },
      });
    }

    // POST /admin/api/sign-out-everywhere — clear all sessions (requires a session).
    if (p === "/admin/api/sign-out-everywhere" && req.method === "POST") {
      if (!requireAdmin(req)) return Response.json({ error: "Admin authentication required" }, { status: 401 });
      const count = sessions.size;
      sessions.clear();
      return Response.json({ revoked_sessions: count });
    }

    return null; // not an auth route — let a later dispatcher handle it
  }

  return { requireAdmin, handleAuthRoute };
}
