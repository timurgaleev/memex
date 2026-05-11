/**
 * Exponential backoff for retried jobs.
 *
 *   delay = min(baseMs * 2^retryCount, maxMs)
 *
 * No jitter at this layer — the worker polling interval already
 * smooths out collisions. Jitter would matter once we run >1 worker
 * against the same queue; revisit then.
 */

export interface BackoffOptions {
  /** First retry delay. Default 5_000 ms. */
  baseMs?: number;
  /** Cap. Default 30 minutes. */
  maxMs?: number;
}

export function backoffMs(retryCount: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 5_000;
  const max = opts.maxMs ?? 30 * 60 * 1000;
  if (retryCount < 0) return base;
  // Math.pow(2, 30) is ~1e9 — well within safe integer territory; cap
  // before the multiplication overflows for paranoid retry counts.
  const exp = Math.min(retryCount, 30);
  const raw = base * Math.pow(2, exp);
  return Math.min(raw, max);
}
