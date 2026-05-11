/**
 * Tests for the Gmail recipe. Stubs `fetch` and the Bedrock client so
 * the suite runs offline and is deterministic.
 *
 * Coverage grows incrementally: Task 4 = OAuth; Tasks 5+ append.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  refreshAccessToken,
  _resetTokenCacheForTesting,
} from "../src/recipes/gmail.ts";

const SECRET = {
  client_id: "cid",
  client_secret: "csec",
  refresh_token: "rtok",
};

beforeEach(() => _resetTokenCacheForTesting());

describe("refreshAccessToken", () => {
  it("posts form-encoded grant_type=refresh_token", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ access_token: "atok", expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const r = await refreshAccessToken(SECRET, { fetch: fakeFetch });
    expect(r.accessToken).toBe("atok");
    expect(captured!.url).toBe("https://oauth2.googleapis.com/token");
    expect((captured!.init.body as string)).toContain("grant_type=refresh_token");
    expect((captured!.init.body as string)).toContain("refresh_token=rtok");
  });

  it("caches the access token until ~60s before expiry", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ access_token: `atok${calls}`, expires_in: 600, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const t0 = new Date("2026-05-08T10:00:00Z");
    const r1 = await refreshAccessToken(SECRET, { fetch: fakeFetch, now: t0 });
    const r2 = await refreshAccessToken(SECRET, { fetch: fakeFetch, now: new Date(t0.getTime() + 60_000) });
    expect(r1.accessToken).toBe("atok1");
    expect(r2.accessToken).toBe("atok1"); // cached
    expect(calls).toBe(1);

    // Past expiry ⇒ refresh
    const r3 = await refreshAccessToken(SECRET, { fetch: fakeFetch, now: new Date(t0.getTime() + 10 * 60_000) });
    expect(r3.accessToken).toBe("atok2");
    expect(calls).toBe(2);
  });

  it("throws when google returns a non-200", async () => {
    const fakeFetch = (async () =>
      new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    await expect(refreshAccessToken(SECRET, { fetch: fakeFetch })).rejects.toThrow(
      /400/,
    );
  });
});

import {
  listMessageIds,
  getMessage,
  extractMessageContent,
} from "../src/recipes/gmail.ts";

describe("listMessageIds", () => {
  it("calls users.me/messages with the q + maxResults params and returns ids", async () => {
    let urlSeen = "";
    const fakeFetch = (async (url: string) => {
      urlSeen = url;
      return new Response(
        JSON.stringify({
          messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }],
          resultSizeEstimate: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const ids = await listMessageIds({
      accessToken: "atok",
      query: "newer_than:1d",
      maxResults: 50,
      fetch: fakeFetch,
    });
    expect(ids).toEqual(["m1", "m2"]);
    expect(urlSeen).toContain("/users/me/messages");
    expect(urlSeen).toContain("q=newer_than%3A1d");
    expect(urlSeen).toContain("maxResults=50");
  });

  it("returns empty list when the response has no messages field", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ resultSizeEstimate: 0 }), { status: 200 })) as unknown as typeof fetch;
    const ids = await listMessageIds({
      accessToken: "atok",
      query: "x",
      maxResults: 10,
      fetch: fakeFetch,
    });
    expect(ids).toEqual([]);
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(
      listMessageIds({
        accessToken: "atok",
        query: "x",
        maxResults: 10,
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/401/);
  });
});

describe("extractMessageContent", () => {
  it("pulls subject + from + plain-text body from a multipart payload", () => {
    const message = {
      id: "m1",
      threadId: "t1",
      internalDate: "1714896000000",
      payload: {
        headers: [
          { name: "Subject", value: "Hello world" },
          { name: "From", value: "Alice <alice@example.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Date", value: "Wed, 08 May 2026 10:00:00 +0000" },
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: { data: Buffer.from("Body text here", "utf8").toString("base64url") },
          },
          {
            mimeType: "text/html",
            body: { data: Buffer.from("<p>HTML</p>", "utf8").toString("base64url") },
          },
        ],
      },
    };
    const c = extractMessageContent(message);
    expect(c.subject).toBe("Hello world");
    expect(c.from).toBe("Alice <alice@example.com>");
    expect(c.body).toContain("Body text here");
  });

  it("falls back to text/html when text/plain is absent", () => {
    const message = {
      id: "m2",
      threadId: "t2",
      internalDate: "1714896000000",
      payload: {
        headers: [{ name: "Subject", value: "S" }, { name: "From", value: "F" }],
        parts: [
          {
            mimeType: "text/html",
            body: {
              data: Buffer.from("<p>plain <b>bold</b></p>", "utf8").toString("base64url"),
            },
          },
        ],
      },
    };
    const c = extractMessageContent(message);
    expect(c.body).toBe("plain bold");
  });

  it("caps body length at 4 KiB", () => {
    const big = "x".repeat(8000);
    const message = {
      id: "m3",
      threadId: "t3",
      internalDate: "1714896000000",
      payload: {
        headers: [{ name: "Subject", value: "S" }, { name: "From", value: "F" }],
        body: { data: Buffer.from(big, "utf8").toString("base64url") },
      },
    };
    const c = extractMessageContent(message);
    expect(c.body.length).toBeLessThanOrEqual(4096);
  });
});

describe("getMessage", () => {
  it("calls users.me/messages/<id>?format=full and returns the parsed payload", async () => {
    let urlSeen = "";
    const fakeFetch = (async (url: string) => {
      urlSeen = url;
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          internalDate: "1714896000000",
          payload: {
            headers: [
              { name: "Subject", value: "Hi" },
              { name: "From", value: "Alice" },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: { data: Buffer.from("body", "utf8").toString("base64url") },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const m = await getMessage({ accessToken: "atok", id: "m1", fetch: fakeFetch });
    expect(m.id).toBe("m1");
    expect(urlSeen).toContain("/messages/m1");
    expect(urlSeen).toContain("format=full");
  });
});

import { classifySignal } from "../src/recipes/gmail.ts";

function bedrockStub(text: string) {
  return {
    send: async () => ({ output: { message: { content: [{ text }] } } }),
  } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
}

describe("classifySignal", () => {
  it("parses a clean JSON object", async () => {
    const r = await classifySignal({
      client: bedrockStub('{"score": 0.84, "reason": "explicit task assignment"}'),
      modelId: "global.amazon.nova-2-lite-v1:0",
      subject: "Action required: Q2 budget review",
      from: "boss@example.com",
      bodyExcerpt: "Please review the attached budget by Friday.",
    });
    expect(r.score).toBeCloseTo(0.84);
    expect(r.reason).toContain("task");
  });

  it("tolerates a code-fenced JSON response", async () => {
    const r = await classifySignal({
      client: bedrockStub('```json\n{"score": 0.05, "reason": "marketing"}\n```'),
      modelId: "x",
      subject: "20% off!",
      from: "promo@example.com",
      bodyExcerpt: "Limited-time offer ending soon.",
    });
    expect(r.score).toBeCloseTo(0.05);
  });

  it("clamps score to [0, 1]", async () => {
    const high = await classifySignal({
      client: bedrockStub('{"score": 1.7, "reason": "x"}'),
      modelId: "x",
      subject: "s",
      from: "f",
      bodyExcerpt: "b",
    });
    expect(high.score).toBe(1);
    const low = await classifySignal({
      client: bedrockStub('{"score": -0.3, "reason": "x"}'),
      modelId: "x",
      subject: "s",
      from: "f",
      bodyExcerpt: "b",
    });
    expect(low.score).toBe(0);
  });

  it("throws when the response is not parseable", async () => {
    await expect(
      classifySignal({
        client: bedrockStub("the model went off the rails"),
        modelId: "x",
        subject: "s",
        from: "f",
        bodyExcerpt: "b",
      }),
    ).rejects.toThrow(/parse/i);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  pollGmail,
  buildMessageMarkdown,
  gmailSourcePath,
} from "../src/recipes/gmail.ts";
import { _resetForTest as _resetThrottle } from "../src/core/throttle.ts";

describe("buildMessageMarkdown", () => {
  it("emits frontmatter + heading + meta + body", () => {
    const md = buildMessageMarkdown(
      {
        id: "msg-abc-123",
        threadId: "t1",
        date: "Wed, 08 May 2026 10:00:00 +0000",
        subject: "Q2 Budget Review",
        from: "boss@example.com",
        to: "me@example.com",
        body: "Please review the attached budget.",
      },
      { score: 0.84, reason: "task assignment" },
    );
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("source: gmail");
    expect(md).toContain("gmail_id: msg-abc-123");
    expect(md).toContain("signal_score: 0.84");
    expect(md).toContain("# Q2 Budget Review");
    expect(md).toContain("**From:** boss@example.com");
    expect(md).toContain("Please review the attached budget.");
  });

  it("falls back to '(no subject)' when subject is empty", () => {
    const md = buildMessageMarkdown(
      {
        id: "x", threadId: "t", date: "...",
        subject: "",
        from: "f", to: "t", body: "b",
      },
      { score: 0.5, reason: "r" },
    );
    expect(md).toContain("subject: '(no subject)'");
    expect(md).toContain("# (no subject)");
  });

  it("escapes single quotes in YAML scalars by doubling", () => {
    const md = buildMessageMarkdown(
      {
        id: "x", threadId: "t", date: "...",
        subject: "It's a 'test'",
        from: "f", to: "t", body: "b",
      },
      { score: 0.5, reason: "edge case" },
    );
    expect(md).toContain("subject: 'It''s a ''test'''");
  });
});

describe("gmailSourcePath", () => {
  it("returns the gmail: scheme prefix", () => {
    expect(gmailSourcePath("abc")).toBe("gmail:abc");
  });
});

function buildFakeFetch(messages: Array<{ id: string; subject: string; body: string }>) {
  return (async (url: string, _init?: RequestInit) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "atok", expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/messages?")) {
      return new Response(
        JSON.stringify({ messages: messages.map((m) => ({ id: m.id })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const idMatch = /\/messages\/([^?]+)/.exec(url);
    if (idMatch) {
      const id = idMatch[1]!;
      const m = messages.find((x) => x.id === id);
      if (!m) return new Response("", { status: 404 });
      return new Response(
        JSON.stringify({
          id: m.id,
          threadId: `t-${m.id}`,
          internalDate: "1714896000000",
          payload: {
            headers: [
              { name: "Subject", value: m.subject },
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "me@example.com" },
              { name: "Date", value: "Wed, 08 May 2026 10:00:00 +0000" },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: { data: Buffer.from(m.body, "utf8").toString("base64url") },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

interface IndexCall {
  sourcePath: string;
  text: string;
  mtimeMs?: number;
}

function makeIndexStub(): {
  fn: NonNullable<Parameters<typeof pollGmail>[1]>["indexFn"];
  calls: IndexCall[];
} {
  const calls: IndexCall[] = [];
  const fn: NonNullable<Parameters<typeof pollGmail>[1]>["indexFn"] = async (
    _storage,
    input,
  ) => {
    const c: IndexCall = { sourcePath: input.sourcePath, text: input.text };
    if (input.mtimeMs !== undefined) c.mtimeMs = input.mtimeMs;
    calls.push(c);
    return {
      documentId: `doc_${input.sourcePath}`,
      chunks: 1,
      embeddings: 1,
      entities: 0,
    };
  };
  return { fn, calls };
}

describe("pollGmail (integration with stubs)", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-poll-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    _resetTokenCacheForTesting();
    _resetThrottle();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ingests high-signal via indexFn, skips low-signal, persists dedup", async () => {
    const messages = [
      { id: "high-1", subject: "Action: budget", body: "Please review by Friday." },
      { id: "low-1", subject: "20% off!", body: "Marketing copy here." },
    ];
    const scores: Record<string, number> = { "high-1": 0.84, "low-1": 0.04 };
    const bedrock = {
      send: async (cmd: { input: { messages: { content: { text: string }[] }[] } }) => {
        const text = cmd.input.messages[0]!.content[0]!.text;
        const m = messages.find((x) => text.includes(x.subject))!;
        return {
          output: {
            message: {
              content: [
                { text: `{"score": ${scores[m.id]}, "reason": "stub"}` },
              ],
            },
          },
        };
      },
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;

    const { fn: indexFn, calls } = makeIndexStub();
    const r = await pollGmail(storage, {
      fetch: buildFakeFetch(messages),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-08T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.scanned).toBe(2);
    expect(r.processed).toBe(2);
    expect(r.ingested).toBe(1);
    expect(r.skippedLowSignal).toBe(1);
    expect(r.skippedDedup).toBe(0);

    expect(calls.length).toBe(1);
    expect(calls[0]!.sourcePath).toBe("gmail:high-1");
    expect(calls[0]!.text).toContain("# Action: budget");
    expect(calls[0]!.text).toContain("Please review by Friday.");
    expect(calls[0]!.mtimeMs).toBe(new Date("2026-05-08T10:00:00Z").getTime());
  });

  it("dedups on a second poll", async () => {
    const messages = [{ id: "stable", subject: "Hi", body: "Body." }];
    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.7, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const { fn: indexFn, calls } = makeIndexStub();
    const opts = {
      fetch: buildFakeFetch(messages),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-08T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    };
    const r1 = await pollGmail(storage, opts);
    expect(r1.ingested).toBe(1);
    expect(calls.length).toBe(1);
    const r2 = await pollGmail(storage, opts);
    expect(r2.scanned).toBe(1);
    expect(r2.processed).toBe(0);
    expect(r2.skippedDedup).toBe(1);
    expect(r2.ingested).toBe(0);
    expect(calls.length).toBe(1); // not called again
  });

  it("retries once on a 401 by refreshing the token", async () => {
    const messages = [{ id: "m1", subject: "S", body: "B" }];
    let listCalls = 0;
    const fakeFetch = (async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: `atok-${++listCalls}`, expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes("/messages?")) {
        if (listCalls === 1) return new Response("expired", { status: 401 });
        return new Response(
          JSON.stringify({ messages: [{ id: "m1" }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t",
          internalDate: "1714896000000",
          payload: {
            headers: [
              { name: "Subject", value: "S" },
              { name: "From", value: "F" },
            ],
            parts: [{ mimeType: "text/plain", body: { data: Buffer.from("B").toString("base64url") } }],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.7, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;

    const { fn: indexFn, calls } = makeIndexStub();
    const r = await pollGmail(storage, {
      fetch: fakeFetch,
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-08T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.ingested).toBe(1);
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBe(1);
    expect(calls[0]!.sourcePath).toBe("gmail:m1");
  });

  it("dryRun skips indexFn and dedup persistence", async () => {
    const messages = [{ id: "dry-1", subject: "Hi", body: "B" }];
    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.9, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const { fn: indexFn, calls } = makeIndexStub();
    const baseOpts = {
      fetch: buildFakeFetch(messages),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-08T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
      dryRun: true,
    };
    const r = await pollGmail(storage, baseOpts);
    expect(r.ingested).toBe(1);
    expect(calls.length).toBe(0); // indexFn never invoked under dryRun
    // Dedup not persisted — second call sees same message
    const r2 = await pollGmail(storage, baseOpts);
    expect(r2.skippedDedup).toBe(0);
  });

  it("indexFn failure surfaces in errors[] and skips dedup", async () => {
    const messages = [{ id: "boom", subject: "Hi", body: "B" }];
    const bedrock = {
      send: async () => ({
        output: { message: { content: [{ text: '{"score": 0.9, "reason": "ok"}' }] } },
      }),
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    const indexFn: NonNullable<Parameters<typeof pollGmail>[1]>["indexFn"] = async () => {
      throw new Error("bedrock embed transient");
    };
    const r = await pollGmail(storage, {
      fetch: buildFakeFetch(messages),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-08T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn,
    });
    expect(r.ingested).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.id).toBe("boom");
    expect(r.errors[0]!.error).toContain("bedrock embed");
    // Not deduped — next poll will retry the same id.
    const { fn: ok } = makeIndexStub();
    const r2 = await pollGmail(storage, {
      fetch: buildFakeFetch(messages),
      bedrockClient: bedrock,
      secret: { client_id: "x", client_secret: "y", refresh_token: "z" },
      signalThreshold: 0.1,
      now: new Date("2026-05-08T10:00:00Z"),
      systemSensors: { loadAvg1: 0, memoryRssMB: 0 },
      indexFn: ok,
    });
    expect(r2.skippedDedup).toBe(0);
    expect(r2.ingested).toBe(1);
  });
});
