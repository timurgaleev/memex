/**
 * Env-hardening guards: an empty-string env var (what a `${VAR}` compose
 * passthrough injects when the operator hasn't set it) must not clobber a valid
 * default, and an unsupported embedding width must fail at resolution time
 * rather than at the first embed call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { awsRegion, llmRequestTimeoutMs } from "../src/core/llm/gateway.ts";
import { resolveEmbedDimensions } from "../src/core/embedding.ts";

describe("llmRequestTimeoutMs", () => {
  test("empty string falls back to 30000 (not Number('') === 0)", () => {
    expect(llmRequestTimeoutMs("")).toBe(30000);
    expect(llmRequestTimeoutMs("   ")).toBe(30000);
  });

  test("unset / non-numeric falls back to 30000", () => {
    expect(llmRequestTimeoutMs(undefined)).toBe(30000);
    expect(llmRequestTimeoutMs("abc")).toBe(30000);
  });

  test("zero / negative fall back to 30000", () => {
    expect(llmRequestTimeoutMs("0")).toBe(30000);
    expect(llmRequestTimeoutMs("-5")).toBe(30000);
  });

  test("a valid positive integer is used", () => {
    expect(llmRequestTimeoutMs("5000")).toBe(5000);
  });
});

describe("awsRegion", () => {
  test("empty / whitespace string falls back to eu-west-1", () => {
    expect(awsRegion("")).toBe("eu-west-1");
    expect(awsRegion("   ")).toBe("eu-west-1");
  });

  test("unset falls back to eu-west-1", () => {
    expect(awsRegion(undefined)).toBe("eu-west-1");
  });

  test("a set region is used (trimmed)", () => {
    expect(awsRegion("us-east-1")).toBe("us-east-1");
    expect(awsRegion("  us-east-1  ")).toBe("us-east-1");
  });
});

describe("env default-parameter path", () => {
  const savedRegion = process.env.AWS_REGION;
  const savedTimeout = process.env.MEMEX_LLM_TIMEOUT_MS;

  afterEach(() => {
    if (savedRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = savedRegion;
    if (savedTimeout === undefined) delete process.env.MEMEX_LLM_TIMEOUT_MS;
    else process.env.MEMEX_LLM_TIMEOUT_MS = savedTimeout;
  });

  test("AWS_REGION='' reads through the default arg to eu-west-1", () => {
    process.env.AWS_REGION = "";
    expect(awsRegion()).toBe("eu-west-1");
  });

  test("MEMEX_LLM_TIMEOUT_MS='' reads through the default arg to 30000", () => {
    process.env.MEMEX_LLM_TIMEOUT_MS = "";
    expect(llmRequestTimeoutMs()).toBe(30000);
  });
});

describe("resolveEmbedDimensions fail-closed on the stored vector(1024) column", () => {
  test("unset yields the 1024 column-width default", () => {
    expect(resolveEmbedDimensions(undefined)).toBe(1024);
    expect(resolveEmbedDimensions("")).toBe(1024);
  });

  test("the stored column width (1024) resolves", () => {
    expect(resolveEmbedDimensions("1024")).toBe(1024);
  });

  test("any other width throws — it wouldn't fit the fixed column", () => {
    // Even Titan-native widths (256/512) are rejected: the column is vector(1024).
    expect(() => resolveEmbedDimensions("512")).toThrow(/vector\(1024\)/);
    expect(() => resolveEmbedDimensions("4096")).toThrow(/migration/);
    expect(() => resolveEmbedDimensions("2000")).toThrow(/migration/);
  });

  test("a non-integer / non-positive width still fails loud", () => {
    expect(() => resolveEmbedDimensions("0")).toThrow(/positive integer/);
    expect(() => resolveEmbedDimensions("1.5")).toThrow(/positive integer/);
  });
});
