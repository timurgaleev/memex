/**
 * LLM gateway: per-process inflight concurrency cap + availability probe.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { withInflightCap, isLlmAvailable } from "../src/core/llm/gateway.ts";

afterEach(() => delete process.env.MEMEX_LLM_MAX_INFLIGHT);

describe("withInflightCap", () => {
  it("caps peak concurrency at MEMEX_LLM_MAX_INFLIGHT", async () => {
    process.env.MEMEX_LLM_MAX_INFLIGHT = "4";
    let peak = 0;
    let active = 0;
    const fake = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 12 }, () => withInflightCap(fake)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });

  it("runs all queued work to completion", async () => {
    process.env.MEMEX_LLM_MAX_INFLIGHT = "2";
    let done = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withInflightCap(async () => {
          await new Promise((r) => setTimeout(r, 1));
          done++;
        }),
      ),
    );
    expect(done).toBe(6);
  });
});

describe("isLlmAvailable", () => {
  it("is true when a region/profile/key is present", () => {
    const prev = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-west-1";
    expect(isLlmAvailable()).toBe(true);
    if (prev === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prev;
  });
});
