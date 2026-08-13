/**
 * Stop-reason parity across the two Bedrock transports.
 *
 * A caller that parses structured output has to tell "the model finished" from
 * "the model ran out of room", and it must be able to ask that question the
 * same way whichever tier it is on. The utility tier (haiku) used to drop the
 * field entirely, so every truncated take proposal / judge verdict looked like
 * a model with nothing to say.
 *
 * The mapping is exercised through the pure response mapper — no live Bedrock,
 * same convention as `buildUserContent`'s tests.
 */
import { describe, expect, it } from "bun:test";
import { toLlmCallResult } from "../src/core/llm/haiku.ts";
import { STOP_REASON_MAX_TOKENS, type SonnetCallResult } from "../src/core/llm/sonnet.ts";
import { isTruncated } from "../src/core/llm/truncation.ts";

const converse = (over: Record<string, unknown> = {}) => ({
  output: { message: { content: [{ text: "[{\"claim_text\"" }] } },
  usage: { inputTokens: 10, outputTokens: 20 },
  ...over,
});

describe("utility-tier stop reason", () => {
  it("carries the output-cap stop reason to the caller", () => {
    const r = toLlmCallResult(converse({ stopReason: STOP_REASON_MAX_TOKENS }), "m");
    expect(r.stopReason).toBe(STOP_REASON_MAX_TOKENS);
  });

  it("carries any other stop reason verbatim — the caller compares, not this", () => {
    expect(toLlmCallResult(converse({ stopReason: "end_turn" }), "m").stopReason).toBe("end_turn");
  });

  it("omits the field when the transport reports none, exactly as the paid tier does", () => {
    const r = toLlmCallResult(converse(), "m");
    expect("stopReason" in r).toBe(false);
  });

  it("still maps text, model and usage (incl. cache tokens)", () => {
    const r = toLlmCallResult(
      converse({
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheWriteInputTokens: 40,
        },
      }),
      "eu.anthropic.claude-haiku-fake",
    );
    expect(r.text).toBe('[{"claim_text"');
    expect(r.modelId).toBe("eu.anthropic.claude-haiku-fake");
    expect(r.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 40,
    });
  });

  it("is the SAME shape the shared truncation check reads on the paid tier", () => {
    const utility = toLlmCallResult(converse({ stopReason: STOP_REASON_MAX_TOKENS }), "m");
    // Same field, same value: a utility-tier result answers the reasoning
    // tier's own truncation predicate once its usage is filled in.
    const asPaid: SonnetCallResult = {
      text: utility.text,
      modelId: utility.modelId,
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(utility.stopReason ? { stopReason: utility.stopReason } : {}),
    };
    expect(isTruncated(asPaid)).toBe(true);
    expect(isTruncated({ ...asPaid, stopReason: "end_turn" })).toBe(false);
  });
});
