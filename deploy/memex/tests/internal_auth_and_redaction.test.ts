/**
 * Internal-auth gate + public-ingress body redaction — unit coverage.
 *
 * History: these guarded the legacy REST routes (POST /index, POST
 * /search). Those routes were removed in A.7 — all read/write capability
 * now flows through `POST /mcp`. The HTTP-level enforcement is therefore
 * exercised against the MCP surface in `mcp_internal_token.test.ts`
 * (write-tool token gate) and `mcp_redaction.test.ts` /
 * `mcp_search_redaction.test.ts` (public body redaction). What remains
 * here is the still-shared pure logic:
 *
 * 1. `evaluateInternalAuth` — the token gate the server applies to `/mcp`.
 * 2. `redactBodies` — the public-search allowlist (now sourced from the
 *    neutral `core/public_redaction.ts` module).
 */
import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import {
  evaluateInternalAuth,
  PUBLIC_GUARD_INTERNALS,
} from "../src/http/public_guard.ts";
import {
  redactBodies,
  redactFacts,
  redactTimeline,
} from "../src/core/public_redaction.ts";

const INT_TOKEN = "internal-shared-token-abcdef";

// ---------------------------------------------------------------------------
// evaluateInternalAuth unit — the gate the server applies to POST /mcp
// (and previously to POST /index).
// ---------------------------------------------------------------------------

describe("evaluateInternalAuth", () => {
  function req(authHeader?: string): Request {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) headers["Authorization"] = authHeader;
    return new Request("http://x/mcp", { method: "POST", headers });
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
// redactBodies — public-search allowlist (denylist-free)
// ---------------------------------------------------------------------------

describe("redactBodies — allowlist-based public search filtering", () => {
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
    const hits = [{ title: "a", content: "secret" }];
    redactBodies(hits);
    expect(hits[0]).toHaveProperty("content");
  });

  it("handles empty hit lists", () => {
    expect(redactBodies([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// redactFacts — public allowlist for entity-fact rows (strip `fact` text)
// ---------------------------------------------------------------------------

describe("redactFacts — allowlist-based public fact filtering", () => {
  const row = {
    id: 7,
    entity_slug: "acme-corp",
    fact: "Q3 revenue was 4.2M",
    confidence: 0.9,
    source_slug: "notes/acme",
    source_chunk_id: "chunk-1",
    written_by: "recipe",
    written_at: "2026-01-01T00:00:00Z",
  };

  it("strips the free-text `fact` field", () => {
    const out = redactFacts([row]);
    expect(out[0]).not.toHaveProperty("fact");
  });

  it("preserves the allowlisted metadata shape", () => {
    const out = redactFacts([row]);
    expect(out[0]).toEqual({
      id: 7,
      entity_slug: "acme-corp",
      confidence: 0.9,
      source_slug: "notes/acme",
      source_chunk_id: "chunk-1",
      written_by: "recipe",
      written_at: "2026-01-01T00:00:00Z",
    });
  });

  it("strips ANY future body-ish field by default (allowlist semantics)", () => {
    const out = redactFacts([
      { ...row, raw_statement: "future secret", embedding: [0.1] } as Record<
        string,
        unknown
      >,
    ]);
    expect(out[0]).not.toHaveProperty("raw_statement");
    expect(out[0]).not.toHaveProperty("embedding");
  });

  it("does not mutate the input array", () => {
    const hits = [{ ...row }];
    redactFacts(hits);
    expect(hits[0]).toHaveProperty("fact");
  });

  it("handles empty lists", () => {
    expect(redactFacts([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// redactTimeline — public allowlist for timeline rows (strip `event` text)
// ---------------------------------------------------------------------------

describe("redactTimeline — allowlist-based public timeline filtering", () => {
  const row = {
    id: 3,
    slug: "acme-corp",
    occurred_at: "2026-02-01T00:00:00Z",
    event: "signed a confidential 4.2M contract",
    source_chunk_id: "chunk-2",
    written_at: "2026-02-02T00:00:00Z",
  };

  it("strips the free-text `event` field", () => {
    const out = redactTimeline([row]);
    expect(out[0]).not.toHaveProperty("event");
  });

  it("preserves the allowlisted metadata shape", () => {
    const out = redactTimeline([row]);
    expect(out[0]).toEqual({
      id: 3,
      slug: "acme-corp",
      occurred_at: "2026-02-01T00:00:00Z",
      source_chunk_id: "chunk-2",
      written_at: "2026-02-02T00:00:00Z",
    });
  });

  it("does not mutate the input array", () => {
    const hits = [{ ...row }];
    redactTimeline(hits);
    expect(hits[0]).toHaveProperty("event");
  });

  it("handles empty lists", () => {
    expect(redactTimeline([])).toEqual([]);
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
