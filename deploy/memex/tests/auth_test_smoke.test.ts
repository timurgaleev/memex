/**
 * `memex auth test <url> --token` — the live MCP smoke, exercised hermetically
 * through the injectable fetch (JSON and SSE response shapes, failure paths).
 */
import { describe, expect, it } from "bun:test";
import { runAuthTest } from "../src/commands/auth.ts";

type FetchLike = typeof fetch;

function fakeServer(opts: {
  status?: number;
  sse?: boolean;
  failOn?: "initialize" | "tools/list" | "tools/call";
}): { fetchFn: FetchLike; seen: Array<{ method: string; auth: string | null }> } {
  const seen: Array<{ method: string; auth: string | null }> = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    const headers = init?.headers as Record<string, string>;
    seen.push({ method: body.method, auth: headers["Authorization"] ?? null });
    if (opts.failOn === body.method) {
      return new Response("denied", { status: opts.status ?? 401, statusText: "Unauthorized" });
    }
    if (body.method === "tools/list") {
      const payload = JSON.stringify({ result: { tools: [{ name: "search" }, { name: "stats" }] } });
      if (opts.sse) {
        return new Response(`event: message\ndata:${payload}\n\n`, { status: 200 });
      }
      return new Response(payload, { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as FetchLike;
  return { fetchFn, seen };
}

describe("runAuthTest", () => {
  it("passes the three-step smoke and counts tools (JSON shape)", async () => {
    const { fetchFn, seen } = fakeServer({});
    const r = await runAuthTest("http://brain/mcp", "tok", fetchFn);
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBe(2);
    expect(r.steps.map((s) => s.step)).toEqual(["initialize", "tools/list", "tools/call"]);
    // Every request carried the bearer.
    expect(seen.every((s) => s.auth === "Bearer tok")).toBe(true);
    // The third step is a REAL tool call against `stats`.
    expect(seen[2]!.method).toBe("tools/call");
  });

  it("parses SSE-framed tools/list responses", async () => {
    const { fetchFn } = fakeServer({ sse: true });
    const r = await runAuthTest("http://brain/mcp", "tok", fetchFn);
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBe(2);
  });

  it("fails fast when initialize is rejected", async () => {
    const { fetchFn, seen } = fakeServer({ failOn: "initialize" });
    const r = await runAuthTest("http://brain/mcp", "bad", fetchFn);
    expect(r.ok).toBe(false);
    expect(r.steps.length).toBe(1);
    expect(r.steps[0]!.ok).toBe(false);
    expect(seen.length).toBe(1); // no further calls after the failure
  });

  it("reports a tools/call failure as the failing step", async () => {
    const { fetchFn } = fakeServer({ failOn: "tools/call", status: 500 });
    const r = await runAuthTest("http://brain/mcp", "tok", fetchFn);
    expect(r.ok).toBe(false);
    expect(r.steps[2]!.step).toBe("tools/call");
    expect(r.steps[2]!.ok).toBe(false);
  });
});
