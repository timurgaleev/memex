/**
 * `memex auth doctor <base-url>` — the remote doctor, driven hermetically
 * through an injectable fetch routed by URL path and JSON-RPC method.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCredentialFile,
  redactSecrets,
  runRemoteDoctor,
  type DoctorCredentials,
} from "../src/commands/remote-doctor.ts";

type FetchLike = typeof fetch;

const BASE = "https://brain.example.com";
// Assembled at runtime so no credential-shaped literal sits in the file.
const SECRET = ["memex", "cs", "s3cr3t-value-xyz"].join("_");
const MINTED = ["memex", "at", "minted-token-abc"].join("_");
const FILE_TOKEN = ["memex", "pat", "file-token-def"].join("_");

interface ServerOpts {
  healthStatus?: number;
  healthBody?: Record<string, unknown>;
  asMeta?: Record<string, unknown>;
  prMeta?: Record<string, unknown>;
  tokenStatus?: number;
  tokenBody?: Record<string, unknown>;
  initResult?: Record<string, unknown>;
  toolsListSse?: boolean;
  tools?: unknown[];
  whoami?: Record<string, unknown>;
  whoamiRpcError?: boolean;
  whoamiIsError?: boolean;
}

interface Seen {
  url: string;
  step: string;
  auth: string | null;
  body: string;
}

function fakeServer(opts: ServerOpts = {}): { fetchFn: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : "";
    const auth = headers["Authorization"] ?? null;
    const record = (step: string) => seen.push({ url: url.href, step, auth, body });
    if (url.pathname === "/health") {
      record("health");
      return Response.json(opts.healthBody ?? { ok: true, db: "postgres", version: "v1.2.3" }, {
        status: opts.healthStatus ?? 200,
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      record("as-meta");
      return Response.json(
        opts.asMeta ?? {
          issuer: BASE,
          token_endpoint: `${BASE}/token`,
          grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        },
      );
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      record("pr-meta");
      return Response.json(opts.prMeta ?? { resource: BASE, authorization_servers: [BASE] });
    }
    if (url.pathname === "/token") {
      record("token");
      if ((opts.tokenStatus ?? 200) !== 200) {
        return new Response(`{"error":"invalid_client","hint":"${SECRET}"}`, {
          status: opts.tokenStatus,
        });
      }
      return Response.json(
        opts.tokenBody ?? { access_token: MINTED, token_type: "Bearer", expires_in: 3600 },
      );
    }
    if (url.pathname === "/mcp") {
      const rpc = JSON.parse(body) as { method: string; params?: { name?: string }; id: number };
      const step = rpc.method === "tools/call" ? `tools/call ${rpc.params?.name}` : rpc.method;
      record(step);
      if (rpc.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: opts.initResult ?? {
            serverInfo: { name: "memex", version: "v1.2.3" },
            instructions: "Search the brain before answering.",
          },
        });
      }
      if (rpc.method === "tools/list") {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { tools: opts.tools ?? [{ name: "search" }, { name: "whoami" }] },
        });
        return opts.toolsListSse
          ? new Response(`event: message\ndata: ${payload}\n\n`, { status: 200 })
          : new Response(payload, { status: 200 });
      }
      if (opts.whoamiRpcError) {
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "boom" } });
      }
      const who = opts.whoami ?? {
        ok: true,
        client_id: null,
        scopes: ["read", "write", "admin"],
        write_source: null,
        read_sources: null,
      };
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(who) }],
          ...(opts.whoamiIsError ? { isError: true } : {}),
        },
      });
    }
    record(`unexpected ${url.pathname}`);
    return new Response("not found", { status: 404 });
  }) as FetchLike;
  return { fetchFn, seen };
}

const clientCreds: DoctorCredentials = {
  kind: "client",
  clientId: "memex_cl_alpha",
  clientSecret: SECRET,
};
const tokenCreds: DoctorCredentials = { kind: "token", token: FILE_TOKEN };

const statusOf = (r: { checks: Array<{ name: string; status: string }> }, name: string) =>
  r.checks.find((c) => c.name === name)?.status;

describe("runRemoteDoctor — happy paths", () => {
  it("runs health, discovery, mint, initialize, tools/list, whoami in order with the minted bearer", async () => {
    const { fetchFn, seen } = fakeServer();
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.step)).toEqual([
      "health",
      "as-meta",
      "pr-meta",
      "token",
      "initialize",
      "tools/list",
      "tools/call whoami",
    ]);
    expect(r.checks.map((c) => c.name)).toEqual([
      "health",
      "discovery",
      "mint",
      "initialize",
      "tools/list",
      "whoami",
      "scope",
    ]);
    const mcpCalls = seen.filter((s) => s.url === `${BASE}/mcp`);
    expect(mcpCalls.every((s) => s.auth === `Bearer ${MINTED}`)).toBe(true);
    expect(r.version).toBe("v1.2.3");
    expect(r.whoami?.read_sources).toBeNull();
    // The secret travelled in the token request only.
    expect(seen.filter((s) => s.body.includes(SECRET)).map((s) => s.step)).toEqual(["token"]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(MINTED);
  });

  it("skips the mint with a token file and uses that bearer", async () => {
    const { fetchFn, seen } = fakeServer();
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(r.ok).toBe(true);
    expect(statusOf(r, "mint")).toBe("skipped");
    expect(seen.some((s) => s.step === "token")).toBe(false);
    const mcpCalls = seen.filter((s) => s.url === `${BASE}/mcp`);
    expect(mcpCalls.length).toBe(3);
    expect(mcpCalls.every((s) => s.auth === `Bearer ${FILE_TOKEN}`)).toBe(true);
  });

  it("uses basic auth when the metadata lists client_secret_basic first", async () => {
    const { fetchFn, seen } = fakeServer({
      asMeta: {
        issuer: BASE,
        token_endpoint: `${BASE}/token`,
        grant_types_supported: ["client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      },
    });
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(r.ok).toBe(true);
    const tokenReq = seen.find((s) => s.step === "token")!;
    expect(tokenReq.auth?.startsWith("Basic ")).toBe(true);
    expect(tokenReq.body).not.toContain(SECRET);
  });

  it("parses an SSE-framed tools/list body", async () => {
    const { fetchFn } = fakeServer({ toolsListSse: true });
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(statusOf(r, "tools/list")).toBe("ok");
    expect(r.ok).toBe(true);
  });
});

describe("runRemoteDoctor — health", () => {
  it("fails on a stamp that differs from --expect-version", async () => {
    const { fetchFn } = fakeServer();
    const r = await runRemoteDoctor(BASE, tokenCreds, { expectVersion: "v9.9.9" }, fetchFn);
    expect(statusOf(r, "health")).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.checks[0]!.detail).toContain("v9.9.9");
  });

  it("warns on a dev stamp without an expectation and stays ok", async () => {
    const { fetchFn } = fakeServer({
      healthBody: { ok: true, version: "dev" },
      initResult: { serverInfo: { version: "dev" }, instructions: "x" },
    });
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(statusOf(r, "health")).toBe("warn");
    expect(r.ok).toBe(true);
  });

  for (const [label, opts] of [
    ["a 503", { healthStatus: 503, healthBody: { ok: false, error: "database connection failed" } }],
    ["ok:false", { healthBody: { ok: false } }],
  ] as const) {
    it(`fails on ${label} and skips every later check`, async () => {
      const { fetchFn, seen } = fakeServer(opts);
      const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
      expect(r.ok).toBe(false);
      expect(statusOf(r, "health")).toBe("fail");
      expect(r.checks.slice(1).every((c) => c.status === "skipped")).toBe(true);
      expect(seen.map((s) => s.step)).toEqual(["health"]);
    });
  }

  it("fails when initialize reports a different version than /health", async () => {
    const { fetchFn } = fakeServer({
      initResult: { serverInfo: { version: "v1.2.2" }, instructions: "x" },
    });
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(statusOf(r, "initialize")).toBe("fail");
    const detail = r.checks.find((c) => c.name === "initialize")!.detail;
    expect(detail).toContain("v1.2.2");
    expect(detail).toContain("v1.2.3");
    expect(r.ok).toBe(false);
  });

  it("fails when initialize carries no instructions", async () => {
    const { fetchFn } = fakeServer({ initResult: { serverInfo: { version: "v1.2.3" } } });
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(statusOf(r, "initialize")).toBe("fail");
  });
});

describe("runRemoteDoctor — discovery", () => {
  const good = {
    issuer: BASE,
    token_endpoint: `${BASE}/token`,
    grant_types_supported: ["client_credentials"],
  };

  it("fails when the issuer is not the origin given", async () => {
    const { fetchFn, seen } = fakeServer({
      asMeta: { ...good, issuer: "https://other.example.com" },
    });
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(statusOf(r, "discovery")).toBe("fail");
    expect(statusOf(r, "mint")).toBe("skipped");
    expect(seen.some((s) => s.step === "token")).toBe(false);
  });

  it("fails when client_credentials is not supported", async () => {
    const { fetchFn } = fakeServer({
      asMeta: { ...good, grant_types_supported: ["authorization_code"] },
    });
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(statusOf(r, "discovery")).toBe("fail");
  });

  it("never posts the secret to a token endpoint on another origin", async () => {
    const { fetchFn, seen } = fakeServer({
      asMeta: { ...good, token_endpoint: "https://evil.example.net/token" },
    });
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(statusOf(r, "discovery")).toBe("fail");
    expect(r.ok).toBe(false);
    expect(seen.some((s) => s.url.includes("evil.example.net"))).toBe(false);
    expect(seen.some((s) => s.body.includes(SECRET))).toBe(false);
  });

  it("fails when the protected-resource document names another server", async () => {
    const { fetchFn } = fakeServer({
      prMeta: { resource: BASE, authorization_servers: ["https://other.example.com"] },
    });
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(statusOf(r, "discovery")).toBe("fail");
  });
});

describe("runRemoteDoctor — mint", () => {
  it("fails on a 401 without echoing the secret", async () => {
    const { fetchFn } = fakeServer({ tokenStatus: 401 });
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(statusOf(r, "mint")).toBe("fail");
    expect(statusOf(r, "initialize")).toBe("skipped");
    const detail = r.checks.find((c) => c.name === "mint")!.detail;
    expect(detail).toContain("401");
    expect(detail).toContain("[redacted]");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("fails when the token response lacks a bearer token_type", async () => {
    const { fetchFn } = fakeServer({
      tokenBody: { access_token: MINTED, token_type: "mac", expires_in: 3600 },
    });
    const r = await runRemoteDoctor(BASE, clientCreds, {}, fetchFn);
    expect(statusOf(r, "mint")).toBe("fail");
  });
});

describe("runRemoteDoctor — MCP", () => {
  it("fails on HTTP 200 carrying a JSON-RPC error on tools/call", async () => {
    const { fetchFn } = fakeServer({ whoamiRpcError: true });
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(statusOf(r, "whoami")).toBe("fail");
    expect(statusOf(r, "scope")).toBe("skipped");
    expect(r.ok).toBe(false);
  });

  it("fails on HTTP 200 carrying result.isError on tools/call", async () => {
    const { fetchFn } = fakeServer({ whoamiIsError: true });
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(statusOf(r, "whoami")).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("fails on an empty tools/list", async () => {
    const { fetchFn } = fakeServer({ tools: [] });
    const r = await runRemoteDoctor(BASE, tokenCreds, {}, fetchFn);
    expect(statusOf(r, "tools/list")).toBe("fail");
  });
});

describe("runRemoteDoctor — scope probe", () => {
  const who = (write: string | null, read: string[] | null) => ({
    ok: true,
    client_id: "memex_cl_alpha",
    scopes: ["read"],
    write_source: write,
    read_sources: read,
  });

  it("passes --expect-source when write and read agree", async () => {
    const { fetchFn } = fakeServer({ whoami: who("alpha", ["alpha"]) });
    const r = await runRemoteDoctor(BASE, clientCreds, { expectSource: "alpha" }, fetchFn);
    expect(statusOf(r, "scope")).toBe("ok");
    expect(r.ok).toBe(true);
  });

  it("fails --expect-source on another write source", async () => {
    const { fetchFn } = fakeServer({ whoami: who("beta", ["alpha"]) });
    const r = await runRemoteDoctor(BASE, clientCreds, { expectSource: "alpha" }, fetchFn);
    expect(statusOf(r, "scope")).toBe("fail");
  });

  it("fails --expect-source on an operator (whole-brain) caller", async () => {
    const { fetchFn } = fakeServer({ whoami: who("alpha", null) });
    const r = await runRemoteDoctor(BASE, clientCreds, { expectSource: "alpha" }, fetchFn);
    expect(statusOf(r, "scope")).toBe("fail");
  });

  it("fails --expect-operator on a no-grant caller", async () => {
    const { fetchFn } = fakeServer({ whoami: who(null, []) });
    const r = await runRemoteDoctor(BASE, clientCreds, { expectOperator: true }, fetchFn);
    expect(statusOf(r, "scope")).toBe("fail");
  });

  it("passes --expect-operator when read_sources is null", async () => {
    const { fetchFn } = fakeServer({ whoami: who(null, null) });
    const r = await runRemoteDoctor(BASE, clientCreds, { expectOperator: true }, fetchFn);
    expect(statusOf(r, "scope")).toBe("ok");
  });
});

describe("runRemoteDoctor — transport", () => {
  it("refuses http:// to a non-loopback host before any fetch", async () => {
    const boom = ((): Promise<Response> => {
      throw new Error("fetch must not run");
    }) as unknown as FetchLike;
    await expect(runRemoteDoctor("http://brain.example.com", tokenCreds, {}, boom)).rejects.toThrow(
      /https/,
    );
  });

  it("allows http://127.0.0.1", async () => {
    const local = "http://127.0.0.1:18790";
    const { fetchFn } = fakeServer({
      asMeta: {
        issuer: local,
        token_endpoint: `${local}/token`,
        grant_types_supported: ["client_credentials"],
      },
      prMeta: { resource: local, authorization_servers: [local] },
    });
    const r = await runRemoteDoctor(local, tokenCreds, {}, fetchFn);
    expect(r.ok).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence and truncates", () => {
    const out = redactSecrets(`a ${SECRET} b ${SECRET} ${"x".repeat(500)}`, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out.startsWith("a [redacted] b [redacted]")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(201);
  });

  it("stays linear on a long adversarial body", () => {
    const time = (n: number) => {
      const body = "memex_cs_".repeat(n);
      const t = performance.now();
      redactSecrets(body, ["memex_cs_memex_cs_x"]);
      return performance.now() - t;
    };
    time(1000);
    const small = Math.max(time(100_000), 0.5);
    const large = time(400_000);
    expect(large / small).toBeLessThan(12);
  });
});

describe("readCredentialFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "memex-doctor-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string, mode: number) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    chmodSync(p, mode);
    return p;
  };

  it("accepts a 0600 client file", () => {
    const p = write("client.json", JSON.stringify({ client_id: "memex_cl_a", client_secret: SECRET }), 0o600);
    expect(readCredentialFile(p)).toEqual({ kind: "client", clientId: "memex_cl_a", clientSecret: SECRET });
  });

  it("accepts a 0600 token file", () => {
    const p = write("token.json", JSON.stringify({ token: FILE_TOKEN }), 0o600);
    expect(readCredentialFile(p)).toEqual({ kind: "token", token: FILE_TOKEN });
  });

  it("refuses a group- or world-readable file, naming only path and mode", () => {
    const p = write("loose.json", JSON.stringify({ token: FILE_TOKEN }), 0o644);
    expect(() => readCredentialFile(p)).toThrow(/0644/);
    try {
      readCredentialFile(p);
    } catch (e) {
      expect(String(e)).toContain(p);
      expect(String(e)).not.toContain(FILE_TOKEN);
    }
  });

  it("refuses a symlink", () => {
    const target = write("real.json", JSON.stringify({ token: FILE_TOKEN }), 0o600);
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    expect(() => readCredentialFile(link)).toThrow(/symlink/);
  });

  it("refuses malformed content without echoing it", () => {
    const p = write("bad.json", `{"token": ${JSON.stringify(FILE_TOKEN)}`, 0o600);
    expect(() => readCredentialFile(p)).toThrow(/JSON/);
    try {
      readCredentialFile(p);
    } catch (e) {
      expect(String(e)).not.toContain(FILE_TOKEN);
    }
    const q = write("shape.json", JSON.stringify({ client_id: "memex_cl_a" }), 0o600);
    expect(() => readCredentialFile(q)).toThrow(/client_secret|token/);
  });
});
