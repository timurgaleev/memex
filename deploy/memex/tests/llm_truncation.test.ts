/**
 * Output-token limits + the shared truncation-retry helper.
 *
 * The behaviour that matters: a call cut off by the output cap is retried with
 * MORE room, never the same cap (temperature-0 output truncates identically),
 * and only when the caller's budget covers the second call.
 */
import { describe, expect, it } from "bun:test";
import {
  SAFE_OUTPUT_CEILING,
  MIN_OUTPUT_TOKENS,
  clampOutputTokens,
  truncationRetryCap,
  outputTokensFromEnv,
} from "../src/core/llm/output-limits.ts";
import { callWithTruncationRetry } from "../src/core/llm/truncation.ts";
import {
  STOP_REASON_MAX_TOKENS,
  type SonnetCallResult,
} from "../src/core/llm/sonnet.ts";

function resp(over: Partial<SonnetCallResult> = {}): SonnetCallResult {
  return {
    text: "{}",
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 100, outputTokens: 50 },
    ...over,
  };
}

describe("clampOutputTokens", () => {
  it("holds the request inside the usable range", () => {
    expect(clampOutputTokens(4000)).toBe(4000);
    expect(clampOutputTokens(SAFE_OUTPUT_CEILING * 10)).toBe(SAFE_OUTPUT_CEILING);
    expect(clampOutputTokens(1)).toBe(MIN_OUTPUT_TOKENS);
    expect(clampOutputTokens(Number.NaN)).toBe(MIN_OUTPUT_TOKENS);
  });
});

describe("truncationRetryCap", () => {
  it("doubles, then stops at the ceiling", () => {
    expect(truncationRetryCap(1000)).toBe(2000);
    expect(truncationRetryCap(SAFE_OUTPUT_CEILING - 1)).toBe(SAFE_OUTPUT_CEILING);
  });

  it("returns null at the ceiling — there is no more room to buy", () => {
    expect(truncationRetryCap(SAFE_OUTPUT_CEILING)).toBeNull();
  });
});

describe("outputTokensFromEnv", () => {
  it("uses the override when it parses", () => {
    expect(outputTokensFromEnv("X", 1000, { X: "2500" })).toBe(2500);
  });

  it("falls back on empty, zero and garbage — an unset compose default is not a 0 cap", () => {
    for (const raw of ["", "   ", "0", "-5", "abc"]) {
      expect(outputTokensFromEnv("X", 1000, { X: raw })).toBe(1000);
    }
    expect(outputTokensFromEnv("X", 1000, {})).toBe(1000);
  });
});

describe("callWithTruncationRetry", () => {
  it("passes a complete response straight through, with one call", async () => {
    const caps: number[] = [];
    const r = await callWithTruncationRetry("t", 1000, (cap) => {
      caps.push(cap);
      return Promise.resolve(resp());
    });
    expect(caps).toEqual([1000]);
    expect(r.retried).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("retries at a LARGER cap and returns the retry's response", async () => {
    const caps: number[] = [];
    const r = await callWithTruncationRetry(
      "t",
      1000,
      (cap) => {
        caps.push(cap);
        return Promise.resolve(
          caps.length === 1
            ? resp({ stopReason: STOP_REASON_MAX_TOKENS, text: "{cut" })
            : resp({ text: "{whole}" }),
        );
      },
      () => true,
    );
    expect(caps).toEqual([1000, 2000]);
    expect(r.retried).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.resp.text).toBe("{whole}");
    // Both calls were paid for; the caller's budget must see the sum.
    expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
  });

  it("does not retry when the budget refuses, and says the answer is partial", async () => {
    let calls = 0;
    const r = await callWithTruncationRetry(
      "t",
      1000,
      () => {
        calls += 1;
        return Promise.resolve(resp({ stopReason: STOP_REASON_MAX_TOKENS }));
      },
      () => false,
    );
    expect(calls).toBe(1);
    expect(r.retried).toBe(false);
    expect(r.truncated).toBe(true);
  });

  it("does not retry with no budget predicate at all", async () => {
    let calls = 0;
    const r = await callWithTruncationRetry("t", 1000, () => {
      calls += 1;
      return Promise.resolve(resp({ stopReason: STOP_REASON_MAX_TOKENS }));
    });
    expect(calls).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it("does not retry when already at the ceiling", async () => {
    let calls = 0;
    const r = await callWithTruncationRetry(
      "t",
      SAFE_OUTPUT_CEILING,
      () => {
        calls += 1;
        return Promise.resolve(resp({ stopReason: STOP_REASON_MAX_TOKENS }));
      },
      () => true,
    );
    expect(calls).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it("reports still-truncated when even the larger cap was not enough", async () => {
    const r = await callWithTruncationRetry(
      "t",
      1000,
      () => Promise.resolve(resp({ stopReason: STOP_REASON_MAX_TOKENS })),
      () => true,
    );
    expect(r.retried).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("prices the retry decision on the combined projection, not the retry alone", async () => {
    const seen: { inputTokens: number; outputTokens: number }[] = [];
    await callWithTruncationRetry(
      "t",
      1000,
      () => Promise.resolve(resp({ stopReason: STOP_REASON_MAX_TOKENS })),
      (projected) => {
        seen.push(projected);
        return false;
      },
    );
    // first call's input twice over, plus its output plus the retry's ceiling
    expect(seen).toEqual([{ inputTokens: 200, outputTokens: 2050 }]);
  });
});
