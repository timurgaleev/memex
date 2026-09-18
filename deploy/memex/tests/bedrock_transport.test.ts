/**
 * The Bedrock transport every memex client shares (`bedrockClientConfig`),
 * exercised against a local HTTP server instead of a fake function — the
 * retries and the timeout live in the SDK and its HTTP handler, so a seam above
 * them would test nothing.
 *
 * Locks: a throttle or a 5xx is retried to success; a hung request now ENDS
 * (before, the handler only logged a warning and kept waiting — how a write
 * reached 116 s) and is retried like any other transient failure.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClientConfig } from "../src/core/llm/gateway.ts";
import { EMBED_DIMENSIONS, embedText } from "../src/core/embedding.ts";
import { callHaiku } from "../src/core/llm/haiku.ts";
import { expandQuery } from "../src/core/search/expansion.ts";

type Reply = "ok" | "throttle" | "throttle-retry-after" | "unavailable" | "hang" | "slow-converse" | "hang-long";

let server: ReturnType<typeof Bun.serve>;
let script: Reply[] = [];
let hits = 0;

const titanBody = JSON.stringify({
  embedding: Array.from<number>({ length: EMBED_DIMENSIONS }).fill(0.01),
  inputTextTokenCount: 3,
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch() {
      hits++;
      const reply = script.shift() ?? "ok";
      if (reply === "slow-converse") {
        await new Promise((r) => setTimeout(r, 700));
        return Response.json({
          output: { message: { role: "assistant", content: [{ text: "done" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        });
      }
      if (reply === "hang-long") {
        await new Promise((r) => setTimeout(r, 20_000));
        return new Response("too late", { status: 200 });
      }
      if (reply === "hang") {
        await new Promise((r) => setTimeout(r, 5_000));
        return new Response("too late", { status: 200 });
      }
      if (reply === "throttle-retry-after") {
        await new Promise((r) => setTimeout(r, 1_000));
        return Response.json(
          { message: "Too many requests" },
          {
            status: 429,
            headers: { "x-amzn-errortype": "ThrottlingException", "retry-after": "10" },
          },
        );
      }
      if (reply === "throttle") {
        return Response.json(
          { message: "Too many requests" },
          { status: 429, headers: { "x-amzn-errortype": "ThrottlingException" } },
        );
      }
      if (reply === "unavailable") {
        return Response.json(
          { message: "Service unavailable" },
          { status: 503, headers: { "x-amzn-errortype": "ServiceUnavailableException" } },
        );
      }
      return new Response(titanBody, { headers: { "content-type": "application/json" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  script = [];
  hits = 0;
});

function client(timeoutMs: number): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: "eu-west-1",
    endpoint: `http://127.0.0.1:${server.port}`,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    ...bedrockClientConfig(timeoutMs),
  });
}

describe("shared Bedrock transport", () => {
  it("retries a 503 to success", async () => {
    script = ["unavailable", "ok"];
    const vec = await embedText("hello", { client: client(2_000) });
    expect(vec).toHaveLength(EMBED_DIMENSIONS);
    expect(hits).toBe(2);
  });

  it("retries a throttle to success", async () => {
    script = ["throttle", "ok"];
    const vec = await embedText("hello", { client: client(2_000) });
    expect(vec).toHaveLength(EMBED_DIMENSIONS);
    expect(hits).toBe(2);
  });

  it("ends a hung request at the timeout and retries it", async () => {
    script = ["hang", "ok"];
    const started = performance.now();
    const vec = await embedText("hello", { client: client(300) });
    expect(vec).toHaveLength(EMBED_DIMENSIONS);
    expect(hits).toBe(2);
    // The hung attempt was cut at ~300 ms, not left to run its 5 s.
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("gives up after its attempts when every one hangs", async () => {
    script = ["hang", "hang", "hang", "hang"];
    const started = performance.now();
    await expect(embedText("hello", { client: client(200) })).rejects.toThrow();
    expect(hits).toBe(4);
    expect(performance.now() - started).toBeLessThan(4_500);
  });

  it("gives a chat call time for the output it is allowed to generate", async () => {
    const prev = process.env.MEMEX_LLM_UTILITY_TIMEOUT_MS;
    process.env.MEMEX_LLM_UTILITY_TIMEOUT_MS = "200";
    try {
      // Each answer takes 700 ms. 200 ms base + 40 tokens x 25 ms = 1.2 s: fits.
      script = ["slow-converse"];
      const ok = await callHaiku(
        { system: "s", user: "u", maxTokens: 40 },
        { client: client(200), modelId: "fake-haiku" },
      );
      expect(ok.text).toBe("done");
      expect(hits).toBe(1);

      // The same 700 ms answer with no output allowance is cut at 200 ms on
      // every attempt.
      hits = 0;
      script = ["slow-converse", "slow-converse", "slow-converse", "slow-converse"];
      await expect(
        callHaiku({ system: "s", user: "u", maxTokens: 0 }, { client: client(200), modelId: "fake-haiku" }),
      ).rejects.toThrow();
      expect(hits).toBe(4);
    } finally {
      if (prev === undefined) delete process.env.MEMEX_LLM_UTILITY_TIMEOUT_MS;
      else process.env.MEMEX_LLM_UTILITY_TIMEOUT_MS = prev;
    }
  });

  it("does not let an optional search-path LLM step hold a search hostage", async () => {
    // Query expansion is a recall bonus that fails open; a hung call must give
    // up at the search budget, not wait out a chat timeout.
    script = ["hang-long", "hang-long", "hang-long", "hang-long"];
    const started = performance.now();
    const variants = await expandQuery("memex write latency", { client: client(60_000) });
    const took = performance.now() - started;
    expect(variants).toEqual([]);
    expect(took).toBeGreaterThan(4_000);
    expect(took).toBeLessThan(8_000);
  }, 15_000);

  it("keeps the search budget through the SDK's own retry pauses", async () => {
    // A throttle carrying Retry-After makes the SDK sleep between attempts, and
    // that sleep ignores an abort signal; the deadline has to cover it.
    script = ["throttle-retry-after", "ok"];
    const started = performance.now();
    const variants = await expandQuery("memex write latency", { client: client(60_000) });
    const took = performance.now() - started;
    expect(variants).toEqual([]);
    expect(took).toBeLessThan(6_500);
  }, 20_000);
});
