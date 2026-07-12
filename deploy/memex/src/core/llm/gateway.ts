/**
 * LLM gateway helpers. memex is Bedrock-only, so multi-provider recipes,
 * capability classification, and stop-reason machinery don't apply here;
 * retry/backoff/timeout are delegated to the AWS SDK (tuned in the haiku.ts /
 * sonnet.ts client factories). What this adds: a per-process inflight
 * concurrency cap so the many synthesis phases that fan out in parallel can't
 * stampede Bedrock, plus an availability probe.
 */

const DEFAULT_MAX_INFLIGHT = 4;

function maxInflight(): number {
  const n = Number.parseInt(process.env.MEMEX_LLM_MAX_INFLIGHT ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_INFLIGHT;
}

let active = 0;
const waiters: Array<() => void> = [];

/**
 * Run `fn` under the per-process inflight cap (`MEMEX_LLM_MAX_INFLIGHT`, default
 * 4). Excess callers queue FIFO until a slot frees. Per-process only (like
 * throttle.ts) — under multi-container scale-out it under-throttles, which is
 * acceptable on the single EC2.
 */
export async function withInflightCap<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= maxInflight()) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

/** Cheap probe that a Bedrock call could plausibly authenticate (region/creds
 *  present). Not a live reachability check. */
export function isLlmAvailable(): boolean {
  return !!(
    process.env.AWS_REGION ||
    process.env.AWS_PROFILE ||
    process.env.AWS_ACCESS_KEY_ID
  );
}
