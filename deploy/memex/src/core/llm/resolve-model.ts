/**
 * Unified model-tier resolver — the single seam for choosing a Bedrock model id
 * by tier, replacing the per-helper env lookups duplicated across haiku.ts and
 * sonnet.ts. memex is Anthropic-only via Bedrock, so this is env + code only —
 * NOT the reference's multi-provider config-table / alias-map / subagent
 * machinery (dead schema here).
 *
 * Tiers:
 *   - `utility`   → Haiku (fast/cheap classification, extraction).
 *   - `reasoning` → Sonnet (synthesis, facts, grading).
 *   - `deep`      → opt-in Opus (`MEMEX_DEEP_MODEL`); OFF by default, in which
 *                   case it falls back to the reasoning model so nothing regresses.
 *
 * Precedence per tier: explicit `override` > tier env var > built-in default.
 * Uses `||` (not `??`) so an empty-string env (a `${VAR:-}` compose default)
 * falls through to the built-in, mirroring the existing helper behaviour.
 */
import { DEFAULT_HAIKU_MODEL } from "./haiku.ts";
import { DEFAULT_SONNET_MODEL } from "./sonnet.ts";

export type ModelTier = "utility" | "reasoning" | "deep";

const TIER_ENV: Record<ModelTier, string> = {
  utility: "MEMEX_UTILITY_MODEL",
  reasoning: "MEMEX_FACTS_MODEL",
  deep: "MEMEX_DEEP_MODEL",
};

// Read the built-in defaults at CALL time (function-local), never at module
// init — haiku.ts / sonnet.ts import back into this module, and reading their
// `export const`s at init would race the circular load. Call-time is safe.
function tierDefault(tier: ModelTier): string {
  if (tier === "utility") return DEFAULT_HAIKU_MODEL;
  if (tier === "reasoning") return DEFAULT_SONNET_MODEL;
  return ""; // deep has no built-in default — it is opt-in
}

/** Resolve the Bedrock model id for a tier. `deep` with no override/env falls
 *  back to the reasoning model (Sonnet), so enabling the tier is a deliberate,
 *  cost-guarded opt-in and disabling it never regresses. */
export function resolveModel(tier: ModelTier, override?: string): string {
  const v = override || process.env[TIER_ENV[tier]] || tierDefault(tier);
  return tier === "deep" && !v ? tierDefault("reasoning") : v;
}
