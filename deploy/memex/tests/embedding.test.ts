import { test, expect, mock } from "bun:test";
import { embedText, resolveEmbedDimensions } from "../src/core/embedding.ts";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

function mockBedrockClient(returnVector: number[]): BedrockRuntimeClient {
  // Minimal mock that returns the configured vector wrapped in the Titan response shape.
  return {
    send: mock(async () => ({
      body: new TextEncoder().encode(JSON.stringify({ embedding: returnVector })),
    })),
  } as unknown as BedrockRuntimeClient;
}

test("embedText returns a 1024-dim vector from Titan", async () => {
  const fakeVec = new Array(1024).fill(0).map((_, i) => i / 1024);
  const client = mockBedrockClient(fakeVec);
  const result = await embedText("hello world", { client });
  expect(result.length).toBe(1024);
  expect(result[0]).toBe(0);
  expect(result[1023]).toBeCloseTo(1023 / 1024);
});

test("embedText throws on empty input", async () => {
  const client = mockBedrockClient(new Array(1024).fill(0));
  await expect(embedText("", { client })).rejects.toThrow();
  await expect(embedText("   ", { client })).rejects.toThrow();
});

test("embedText throws when response embedding has wrong dimension", async () => {
  const client = mockBedrockClient(new Array(512).fill(0));  // wrong dim
  await expect(embedText("hello", { client })).rejects.toThrow(/1024/);
});

test("embedText accepts modelId override", async () => {
  const fakeVec = new Array(1024).fill(0);
  const client = mockBedrockClient(fakeVec);
  // Should not throw with a custom modelId
  const result = await embedText("hello", { client, modelId: "custom.model.v1" });
  expect(result.length).toBe(1024);
});

test("resolveEmbedDimensions defaults to 1024 when unset/blank", () => {
  expect(resolveEmbedDimensions(undefined)).toBe(1024);
  expect(resolveEmbedDimensions("")).toBe(1024);
  expect(resolveEmbedDimensions("   ")).toBe(1024);
});

test("resolveEmbedDimensions reads a valid positive integer", () => {
  expect(resolveEmbedDimensions("1536")).toBe(1536);
  expect(resolveEmbedDimensions("256")).toBe(256);
});

test("resolveEmbedDimensions fails loud on a bad value", () => {
  expect(() => resolveEmbedDimensions("0")).toThrow(/positive integer/);
  expect(() => resolveEmbedDimensions("-1")).toThrow(/positive integer/);
  expect(() => resolveEmbedDimensions("1.5")).toThrow(/positive integer/);
  expect(() => resolveEmbedDimensions("abc")).toThrow(/positive integer/);
});
