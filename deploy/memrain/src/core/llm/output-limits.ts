/**
 * Output-token ceilings and the truncation-retry cap.
 *
 * Every paid call has to pick a `maxTokens`. Pick it too low and a structured
 * answer is cut mid-JSON, which is total loss rather than graceful degradation
 * — the parser throws the whole response away and the money is already spent.
 *
 * The ceiling here is deliberately a single conservative number rather than a
 * per-model table: Bedrock rejects a `maxTokens` above the model's own maximum
 * with a validation error, so a table that guesses high turns a truncated
 * answer into a failed call. Every Claude model memex can be pointed at accepts
 * at least this much output.
 *
 * ponytail: one shared ceiling, not a per-model table. If a model with a
 * genuinely larger useful output arrives and the extra headroom matters,
 * replace `SAFE_OUTPUT_CEILING` with a family-matched table shaped like
 * `MODEL_PRICING` in ../budget.ts.
 */

/** Upper bound for any single call's output-token request. */
export const SAFE_OUTPUT_CEILING = 8000;

/** Lower bound — below this even a short structured answer cannot close. */
export const MIN_OUTPUT_TOKENS = 256;

/** Clamp a caller-supplied output-token request into the usable range. */
export function clampOutputTokens(n: number): number {
  if (!Number.isFinite(n)) return MIN_OUTPUT_TOKENS;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(SAFE_OUTPUT_CEILING, Math.floor(n)));
}

/**
 * Cap for the retry after a call stopped on `max_tokens`. Doubling is what the
 * facts extractor proved out; the clamp keeps it inside the ceiling. Returns
 * null when there is no more room to give — retrying at the same cap would
 * reproduce the same truncation, since these calls run at temperature 0.
 */
export function truncationRetryCap(maxTokens: number): number | null {
  if (maxTokens >= SAFE_OUTPUT_CEILING) return null;
  return clampOutputTokens(maxTokens * 2);
}

/**
 * Read a positive integer env override for an output-token setting, clamped.
 * An unset, empty or unparseable value falls through to `fallback` — an empty
 * `${VAR:-}` compose default must not become a 0-token cap.
 */
export function outputTokensFromEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return clampOutputTokens(fallback);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return clampOutputTokens(fallback);
  return clampOutputTokens(n);
}
