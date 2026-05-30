/**
 * Internal-auth gate + public-search body redaction.
 *
 * These two regressions were caught by the 2026-05-17 security audit:
 *
 * 1. POST /index, POST /friction, MCP write tools were "internal-only"
 *    purely by way of the public-guard rejecting them with isPublic=true.
 *    A peer on the docker bridge with no `Cf-Connecting-Ip` header
 *    passed as "internal" and could write to the index with no auth.
 *    The new `MEMEX_INTERNAL_TOKEN` requirement closes that.
 *
 * 2. POST /search and POST /backlinks returned note bodies to any
 *    bearer holder over the public ingress. A leaked bearer exfiled
 *    the entire vault. Default response now redacts `content` /
 *    `excerpt` / `snippet`; bodies opt back in via
 *    `MEMEX_PUBLIC_READ_BODIES=1`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import {
  evaluateInternalAuth,
  PUBLIC_GUARD_INTERNALS,
} from "../src/http/public_guard.ts";
import { redactBodies } from "../src/http/search_route.ts";

const PUB_TOKEN = "pub-bearer-xyz789";
const INT_TOKEN = "internal-shared-token-abcdef";

let tmp: string;
let storage: Storage;
let server: ServerHandle;
let url: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-internal-auth-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  server = startServer({
    host: "127.0.0.1",
    port: 0,
    storage,
    publicBearerToken: PUB_TOKEN,
    internalToken: INT_TOKEN,
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// evaluateInternalAuth unit
// ---------------------------------------------------------------------------

describe("evaluateInternalAuth", () => {
  function req(authHeader?: string): Request {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) headers["Authorization"] = authHeader;
    return new Request("http://x/index", { method: "POST", headers });
  }

  it("token unset → open (legacy fallthrough)", () => {
    const r = evaluateInternalAuth(req("Bearer wrong"), {});
    expect(r.allow).toBe(true);
  });

  it("token set, request missing header → 401", () => {
    const r = evaluateInternalAuth(req(), { internalToken: INT_TOKEN });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(401);
  });

  it("token set, wrong bearer → 401", () => {
    const r = evaluateInternalAuth(req("Bearer NOPE"), {
      internalToken: INT_TOKEN,
    });
    expect(r.allow).toBe(false);
  });

  it("token set, correct bearer → allow", () => {
    const r = evaluateInternalAuth(req(`Bearer ${INT_TOKEN}`), {
      internalToken: INT_TOKEN,
    });
    expect(r.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP server end-to-end — internal /index now requires the shared token
// ---------------------------------------------------------------------------

describe("HTTP /index — internal shared-token gate", () => {
  it("internal /index POST without token → 401", async () => {
    const r = await fetch(`${url}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePath: "x.md", text: "hi" }),
    });
    expect(r.status).toBe(401);
  });

  it("internal /index POST with correct token → routes past the guard", async () => {
    const r = await fetch(`${url}/index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${INT_TOKEN}`,
      },
      // Intentionally minimal body — route validation fails, but we
      // only care that the auth gate let us through (not 401/403).
      body: JSON.stringify({}),
    });
    expect([400, 500].includes(r.status)).toBe(true);
  });

  it("internal /friction POST without token → 401", async () => {
    const r = await fetch(`${url}/friction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("public /index still 403s regardless of internal token", async () => {
    // The public-guard rejects /index with 403 BEFORE the internal
    // gate runs — internal auth is a defence-in-depth layer for the
    // internal surface only.
    const r = await fetch(`${url}/index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Connecting-Ip": "1.2.3.4",
        "Authorization": `Bearer ${PUB_TOKEN}`,
      },
      body: JSON.stringify({ sourcePath: "x.md", text: "hi" }),
    });
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Public /search — note bodies redacted by default
// ---------------------------------------------------------------------------

describe("redactBodies — allowlist-based public /search filtering", () => {
  it("removes any body-ish field (denylist-free)", () => {
    const hits = [
      { title: "a", sourcePath: "/a.md", score: 0.9, content: "secret a" },
      { title: "b", sourcePath: "/b.md", score: 0.8, excerpt: "secret b" },
      { title: "c", sourcePath: "/c.md", score: 0.7, snippet: "secret c" },
    ];
    const out = redactBodies(hits);
    for (const h of out) {
      expect(h).not.toHaveProperty("content");
      expect(h).not.toHaveProperty("excerpt");
      expect(h).not.toHaveProperty("snippet");
    }
  });

  it("strips ANY future body-ish field by default (allowlist semantics)", () => {
    // A future SearchHit shape adding `raw_text` / `body_md` / `embedding`
    // would silently leak under a denylist. The allowlist closes that
    // door — only known-safe fields survive.
    const hits = [
      {
        title: "a",
        sourcePath: "/a.md",
        score: 0.9,
        raw_text: "future secret",
        body_md: "another future field",
        embedding: [0.1, 0.2],
      },
    ];
    const out = redactBodies(hits);
    expect(out[0]).not.toHaveProperty("raw_text");
    expect(out[0]).not.toHaveProperty("body_md");
    expect(out[0]).not.toHaveProperty("embedding");
  });

  it("preserves title, sourcePath, score for the operator", () => {
    const out = redactBodies([
      { title: "a", sourcePath: "/a.md", score: 0.9, content: "secret" },
    ]);
    expect(out[0]?.title).toBe("a");
    expect(out[0]?.sourcePath).toBe("/a.md");
    expect(out[0]?.score).toBe(0.9);
  });

  it("preserves the full allowlisted shape (documentId, chunkId, kind, rank)", () => {
    const out = redactBodies([
      {
        title: "a",
        sourcePath: "/a.md",
        score: 0.9,
        documentId: "doc-1",
        chunkId: "chunk-1",
        kind: "obsidian",
        rank: 1,
        content: "REDACT ME",
      },
    ]);
    expect(out[0]).toEqual({
      title: "a",
      sourcePath: "/a.md",
      score: 0.9,
      documentId: "doc-1",
      chunkId: "chunk-1",
      kind: "obsidian",
      rank: 1,
    });
  });

  it("does not mutate the input array", () => {
    const hits = [
      { title: "a", content: "secret" },
    ];
    redactBodies(hits);
    expect(hits[0]).toHaveProperty("content");
  });

  it("handles empty hit lists", () => {
    expect(redactBodies([])).toEqual([]);
  });

  it("public /search route returns 400 on missing q (validation path unaffected)", async () => {
    const r = await fetch(`${url}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Connecting-Ip": "1.2.3.4",
        "Authorization": `Bearer ${PUB_TOKEN}`,
      },
      body: JSON.stringify({ k: 5 }), // missing q
    });
    expect(r.status).toBe(400);
  });
});

describe("MEMEX_PUBLIC_READ_BODIES opt-in", () => {
  const ORIGINAL = process.env["MEMEX_PUBLIC_READ_BODIES"];
  beforeEach(() => {
    process.env["MEMEX_PUBLIC_READ_BODIES"] = "1";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["MEMEX_PUBLIC_READ_BODIES"];
    else process.env["MEMEX_PUBLIC_READ_BODIES"] = ORIGINAL;
  });

  it("publicReadBodiesAllowed() flips true when env=1", () => {
    expect(PUBLIC_GUARD_INTERNALS.publicReadBodiesAllowed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: dispatchTool must honor isPublic so the MCP ingress
// (brain.<domain>/mcp) redacts note bodies the same way REST does.
// Before the fix, dispatchTool ignored isPublic -> full vault exfil.
// ---------------------------------------------------------------------------
test("[tools/call page_get] redacts markdown_body on public MCP ingress", async () => {
  const r = await dispatchTool(
    storage,
    { name: "page_get", arguments: { slug: "people/alice" } },
    { isPublic: true },
  );
  const text = r.content[0]?.text ?? "";
  expect(text).not.toContain("secret body text");
  expect(text).not.toContain("markdown_body");
  expect(text).toContain("people/alice");
});

test("[tools/call page_get] returns full body for internal callers", async () => {
  const r = await dispatchTool(
    storage,
    { name: "page_get", arguments: { slug: "people/alice" } },
    { isPublic: false },
  );
  expect(r.content[0]?.text ?? "").toContain("secret body text");
});

test("[tools/call entity_recall] omits page body on public MCP ingress", async () => {
  const r = await dispatchTool(
    storage,
    { name: "entity_recall", arguments: { slug: "people/alice" } },
    { isPublic: true },
  );
  expect(r.content[0]?.text ?? "").not.toContain("secret body text");
});
