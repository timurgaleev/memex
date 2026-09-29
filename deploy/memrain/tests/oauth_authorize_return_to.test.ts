/**
 * The login-resume URL behind a TLS terminator.
 *
 * With `MEMEX_OAUTH_REQUIRE_LOGIN=1` an unauthenticated browser hitting
 * `/authorize` is bounced to `/admin/login?return_to=…`. The resume target was
 * built from `req.url`, which behind Caddy is the PLAIN-HTTP internal request
 * this process actually received — so signing in sent the operator back to an
 * `http://` address. Observed live on the pilot before the fix:
 * `return_to=http%3A%2F%2Fbrain.…%2Fauthorize%3F…`.
 *
 * The declared public origin is the only thing that knows what the outside
 * world calls this server, so the resume is built from that.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { handleAuthorizeRoute } from "../src/http/oauth-endpoints.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PUBLIC = "https://brain.example.test";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let clientId: string;
let priorPublicUrl: string | undefined;

/** The authorize URL as this process sees it behind a TLS terminator. */
function internalAuthorizeUrl(): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "probe",
  });
  return `http://brain.example.test/authorize?${q.toString()}`;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-authz-return-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
  const client = await provider.registerClient({
    client_name: "claude-tester",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    scope: "read write",
  });
  clientId = client.client_id;
  priorPublicUrl = process.env.MEMEX_PUBLIC_URL;
}, 30_000);

afterAll(async () => {
  if (priorPublicUrl === undefined) delete process.env.MEMEX_PUBLIC_URL;
  else process.env.MEMEX_PUBLIC_URL = priorPublicUrl;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

describe("authorize → admin login resume", () => {
  it("resumes against the declared public origin, not the request's scheme", async () => {
    process.env.MEMEX_PUBLIC_URL = PUBLIC;
    const res = await handleAuthorizeRoute(
      new Request(internalAuthorizeUrl()),
      provider,
      () => false,
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/admin/login?return_to=")).toBe(true);
    const returnTo = decodeURIComponent(loc.split("return_to=")[1] ?? "");
    expect(returnTo.startsWith(`${PUBLIC}/authorize?`)).toBe(true);
    expect(returnTo).not.toContain("http://");
    // The query the browser came in with has to survive, or the resumed
    // authorize is a different request than the one that was interrupted.
    expect(returnTo).toContain(`client_id=${clientId}`);
    expect(returnTo).toContain("code_challenge_method=S256");
  });

  it("falls back to the request origin when no public URL is declared", async () => {
    delete process.env.MEMEX_PUBLIC_URL;
    const res = await handleAuthorizeRoute(
      new Request(internalAuthorizeUrl()),
      provider,
      () => false,
    );
    const returnTo = decodeURIComponent(
      (res.headers.get("location") ?? "").split("return_to=")[1] ?? "",
    );
    expect(returnTo.startsWith("http://brain.example.test/authorize?")).toBe(true);
  });

  it("still auto-approves when no login is required", async () => {
    process.env.MEMEX_PUBLIC_URL = PUBLIC;
    const res = await handleAuthorizeRoute(
      new Request(internalAuthorizeUrl()),
      provider,
    );
    expect(res.status).toBe(302);
    // Straight back to the client with a code — the flow a connector completes.
    expect(res.headers.get("location") ?? "").toContain(REDIRECT);
    expect(res.headers.get("location") ?? "").toContain("code=");
  });
});
