/**
 * MCP param redaction — the summary keeps only shape (declared key names,
 * unknown count, coarse 1 KB-bucketed size), never a value, and the opt-in
 * request log emits nothing unless MEMEX_LOG_REQUESTS is set.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  summarizeMcpParams,
  logToolCall,
  requestLoggingEnabled,
} from "../src/mcp/param-redaction.ts";

const savedEnv = process.env["MEMEX_LOG_REQUESTS"];
afterEach(() => {
  if (savedEnv === undefined) delete process.env["MEMEX_LOG_REQUESTS"];
  else process.env["MEMEX_LOG_REQUESTS"] = savedEnv;
});

describe("summarizeMcpParams", () => {
  it("returns null for null/undefined params", () => {
    expect(summarizeMcpParams("search", null)).toBeNull();
    expect(summarizeMcpParams("search", undefined)).toBeNull();
  });

  it("splits declared vs unknown object keys, never values", () => {
    const s = summarizeMcpParams("search", {
      q: "a private search phrase",
      not_a_real_param: "x",
    })!;
    expect(s.redacted).toBe(true);
    expect(s.kind).toBe("object");
    expect(s.declared_keys).toContain("q"); // `q` is a real search param
    expect(s.unknown_key_count).toBe(1); // not_a_real_param
    // The summary must not carry any VALUE.
    expect(JSON.stringify(s)).not.toContain("private search phrase");
  });

  it("reports array length, not contents", () => {
    const s = summarizeMcpParams("search", ["secret-a", "secret-b", "secret-c"])!;
    expect(s.kind).toBe("array");
    expect(s.length).toBe(3);
    expect(JSON.stringify(s)).not.toContain("secret-");
  });

  it("buckets byte size UP to 1 KB (no size side channel)", () => {
    // Two payloads of different lengths but both under 1 KB hash to the same
    // bucket, so an observer can't binary-search the secret's exact length.
    const small = summarizeMcpParams("search", { q: "x".repeat(8) })!;
    const bigger = summarizeMcpParams("search", { q: "x".repeat(800) })!;
    expect(small.approx_bytes).toBe(1024);
    expect(bigger.approx_bytes).toBe(1024);
    // A payload over 1 KB lands in the next bucket.
    const huge = summarizeMcpParams("search", { q: "x".repeat(1100) })!;
    expect(huge.approx_bytes).toBe(2048); // ~1108 bytes → ceil to 2 KB
  });
});

describe("logToolCall", () => {
  it("emits nothing when MEMEX_LOG_REQUESTS is unset", () => {
    delete process.env["MEMEX_LOG_REQUESTS"];
    expect(requestLoggingEnabled()).toBe(false);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      logToolCall("search", true, { q: "secret" }, true);
    } finally {
      console.log = orig;
    }
    expect(lines.length).toBe(0);
  });

  it("emits one redacted line when enabled — no param values", () => {
    process.env["MEMEX_LOG_REQUESTS"] = "1";
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      logToolCall("search", false, { q: "secret-phrase", k: 5 }, true);
    } finally {
      console.log = orig;
    }
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      mcp_request: { tool: string; ingress: string; ok: boolean; params: unknown };
    };
    expect(parsed.mcp_request.tool).toBe("search");
    expect(parsed.mcp_request.ingress).toBe("internal");
    expect(parsed.mcp_request.ok).toBe(true);
    expect(lines[0]).not.toContain("secret-phrase");
  });

  it("never echoes an unknown (caller-controlled) tool name raw", () => {
    process.env["MEMEX_LOG_REQUESTS"] = "1";
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      logToolCall("exfil-SECRET-as-toolname", true, { x: 1 }, false);
    } finally {
      console.log = orig;
    }
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      mcp_request: { tool: string; known_tool: boolean };
    };
    expect(parsed.mcp_request.tool).toBe("unknown");
    expect(parsed.mcp_request.known_tool).toBe(false);
    expect(lines[0]).not.toContain("exfil-SECRET");
  });
});
