/**
 * USD budget tracker for paid Bedrock LLM calls (the conversation→facts
 * extractor). A hard ceiling, not a suggestion: once cumulative spend reaches
 * the cap, `record()` throws BudgetExhausted and the caller stops. Adapted from
 * the reference's BudgetTracker, trimmed to memex's single use — no
 * AsyncLocalStorage, no rerank/embed tiers, just chat cost.
 *
 * Pricing is per-1M tokens on Bedrock (eu-west-1 cross-region inference),
 * matched by model-family substring so an exact version suffix doesn't have to
 * be enumerated. A configured cap with NO pricing match HARD-FAILS (you should
 * never spend against an unpriced model).
 */
import { appendAudit, auditDir } from "./audit-week-file.ts";
import type { SonnetUsage } from "./llm/sonnet.ts";

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number;
}

/** Bedrock per-1M pricing by model-family substring (lowercased match). */
export const MODEL_PRICING: { match: string; price: ModelPricing }[] = [
  { match: "sonnet", price: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { match: "haiku", price: { inputPer1M: 1.0, outputPer1M: 5.0 } },
];

export function priceFor(modelId: string): ModelPricing | null {
  const id = modelId.toLowerCase();
  for (const { match, price } of MODEL_PRICING) {
    if (id.includes(match)) return price;
  }
  return null;
}

/** Cost in USD for one call's token usage on a given model. */
export function costUsd(modelId: string, usage: SonnetUsage): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  return (
    (usage.inputTokens / 1_000_000) * p.inputPer1M +
    (usage.outputTokens / 1_000_000) * p.outputPer1M
  );
}

export type BudgetReason = "cost" | "no_pricing";

export class BudgetExhausted extends Error {
  constructor(
    public readonly reason: BudgetReason,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

export interface BudgetSnapshot {
  spentUsd: number;
  maxCostUsd: number;
  callsRecorded: number;
}

export class BudgetTracker {
  private spent = 0;
  private calls = 0;

  constructor(
    private readonly maxCostUsd: number,
    private readonly label: string = "facts-extract",
  ) {}

  /** Would recording this model's call (best-effort cost) exceed the cap? Used
   *  to skip a call BEFORE spending when the prior spend already left no room.
   *  An unpriced model is treated as "would exceed" — consistent with `record`,
   *  which hard-fails rather than spend against an unpriced model. */
  wouldExceed(modelId: string, estUsage: SonnetUsage): boolean {
    if (priceFor(modelId) === null) return true;
    return this.spent + costUsd(modelId, estUsage) > this.maxCostUsd;
  }

  /**
   * Record a completed call's actual usage. Throws BudgetExhausted when the cap
   * is reached (cost) or the model has no pricing (no_pricing) — the cap is a
   * real ceiling. Writes a best-effort audit line.
   */
  record(modelId: string, usage: SonnetUsage): void {
    if (priceFor(modelId) === null) {
      throw new BudgetExhausted(
        "no_pricing",
        `no pricing for model '${modelId}' — refusing to spend against an unpriced model`,
      );
    }
    const c = costUsd(modelId, usage);
    this.spent += c;
    this.calls += 1;
    this.audit(modelId, usage, c);
    if (this.spent > this.maxCostUsd) {
      throw new BudgetExhausted(
        "cost",
        `budget exhausted: spent $${this.spent.toFixed(4)} > cap $${this.maxCostUsd.toFixed(2)} (label=${this.label})`,
      );
    }
  }

  totalSpent(): number {
    return this.spent;
  }

  snapshot(): BudgetSnapshot {
    return {
      spentUsd: this.spent,
      maxCostUsd: this.maxCostUsd,
      callsRecorded: this.calls,
    };
  }

  private audit(modelId: string, usage: SonnetUsage, cost: number): void {
    const dir = auditDir();
    if (!dir) return;
    appendAudit(dir, {
      kind: "budget",
      label: this.label,
      model_id: modelId,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: Number(cost.toFixed(6)),
      cumulative_usd: Number(this.spent.toFixed(6)),
      at: new Date().toISOString(),
    });
  }
}
