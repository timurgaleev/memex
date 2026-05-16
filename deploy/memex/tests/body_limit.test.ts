/**
 * Unit tests for the HTTP body-size gate. Verifies:
 *   - small JSON parses cleanly
 *   - Content-Length above cap → 413 without reading the body
 *   - body that overflows when streamed (no Content-Length header)
 *     → 413 after read but before JSON parse
 *   - invalid JSON → 400
 *   - cap honors MEMEX_MAX_BODY_BYTES env override
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseJsonBody } from "../src/http/body_limit.ts";

function reqWithBody(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://test/", {
    method: "POST",
    headers,
    body,
  });
}

describe("parseJsonBody", () => {
  afterEach(() => {
    delete process.env.MEMEX_MAX_BODY_BYTES;
  });

  test("parses small JSON cleanly", async () => {
    const r = await parseJsonBody<{ q: string }>(
      reqWithBody('{"q":"hello"}'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.q).toBe("hello");
  });

  test("rejects invalid JSON with 400", async () => {
    const r = await parseJsonBody(reqWithBody("not json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  test("rejects body with Content-Length above default cap (1 MiB)", async () => {
    // Don't actually send a 1MB body — Content-Length alone should
    // 413 before we read the stream.
    const huge = "x".repeat(2 * 1024 * 1024);
    const r = await parseJsonBody(
      reqWithBody(huge, { "Content-Length": String(2 * 1024 * 1024) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  test("honors MEMEX_MAX_BODY_BYTES override", async () => {
    process.env.MEMEX_MAX_BODY_BYTES = "10";
    const r = await parseJsonBody(
      reqWithBody('{"q":"big enough to exceed 10 bytes"}', {
        "Content-Length": "37",
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  test("falls back to stream read when Content-Length is missing", async () => {
    // No Content-Length header — parseJsonBody must still cap on stream.
    process.env.MEMEX_MAX_BODY_BYTES = "10";
    const r = await parseJsonBody(
      reqWithBody('{"q":"some text that exceeds ten bytes"}'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  test("ignores nonsensical Content-Length values", async () => {
    // A bogus Content-Length header should not corrupt the gate — we
    // still rely on the actual body read.
    const r = await parseJsonBody<{ q: string }>(
      reqWithBody('{"q":"hi"}', { "Content-Length": "notanumber" }),
    );
    expect(r.ok).toBe(true);
  });
});
