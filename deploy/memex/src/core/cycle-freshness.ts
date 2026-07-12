/**
 * cycle-freshness.ts — doctor liveness probe for the maintenance cycle.
 *
 * The cycle is memex's core differentiator (it re-embeds, reconciles links,
 * recomputes salience, snapshots). It appends a `cycle_snapshots` row every
 * tick (core/cycle/snapshot.ts), but nothing watched its liveness: a wedged
 * loop (stuck db-lock, exception loop) surfaced only via downstream proxies
 * (links-extraction-lag). This probes `MAX(captured_at)` against a warn/fail
 * age. memex is single-source, so it checks the one snapshot stream, not a
 * per-federated-source `last_full_cycle_at`.
 *
 * Zero snapshots = informational, NOT a failure: a fresh brain or a deploy that
 * never enabled the cycle loop (serve only starts it when the interval is set)
 * has none yet. The valuable signal is an ESTABLISHED stream that goes stale.
 *
 * Staleness is WARN-only by default (`ok:true`, surfaced in the detail) — a
 * deploy that ran the cycle then disabled it keeps old snapshots, and a hard
 * `exit 1` there would cry wolf on every `doctor` run (the check can't know,
 * from a one-shot CLI, whether the loop is *meant* to be running). Set
 * `MEMEX_CYCLE_FRESHNESS_ENFORCE=1` to make a past-fail-threshold stream a real
 * failure (the deploy that DOES run the cycle and wants `doctor` to gate on it).
 */
import type { Engine } from "./engine/interface.ts";

const HOUR_MS = 3_600_000;

function resolveHours(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface CycleFreshnessResult {
  /** false only on FAIL (stale beyond the fail threshold) — drives doctor exit. */
  ok: boolean;
  detail: string;
}

/**
 * Classify cycle liveness from the newest `cycle_snapshots.captured_at`.
 * `nowMs` is injectable for deterministic tests. Warn/fail ages default to
 * 6h/24h, overridable via
 * `MEMEX_CYCLE_FRESHNESS_WARN_HOURS` / `_FAIL_HOURS`.
 */
export async function checkCycleFreshness(
  engine: Engine,
  nowMs?: number,
): Promise<CycleFreshnessResult> {
  // to_char a clean ISO 'T'…'Z' (not ::text — its space-separated, DateStyle-
  // dependent form is fragile for Date.parse, cf. the v1.38.0 stale-sweep).
  const r = await engine.query<{ t: string | null }>(
    `SELECT to_char(MAX(captured_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t
       FROM cycle_snapshots`,
  );
  const t = r.rows[0]?.t ?? null;
  if (!t) {
    return { ok: true, detail: "no cycle snapshots yet (cycle loop has not run)" };
  }
  const now = nowMs ?? Date.now();
  const ageMs = now - new Date(t).getTime();
  if (ageMs < 0) {
    return { ok: true, detail: "latest cycle snapshot is in the future — clock skew" };
  }
  const failH = resolveHours("MEMEX_CYCLE_FRESHNESS_FAIL_HOURS", 24);
  // Clamp the warn band below fail so a misconfigured WARN>=FAIL can't make the
  // warn message unreachable (LOW, review).
  const warnH = Math.min(resolveHours("MEMEX_CYCLE_FRESHNESS_WARN_HOURS", 6), failH);
  const enforce = process.env.MEMEX_CYCLE_FRESHNESS_ENFORCE === "1";
  const ageH = Math.floor(ageMs / HOUR_MS);
  if (ageMs > failH * HOUR_MS) {
    const detail = `last cycle ${ageH}h ago (>${failH}h) — the maintenance cycle may be wedged`;
    // Hard-fail only when the operator asserts the cycle MUST be fresh; else
    // warn-loud so a cycle-off deploy doesn't fail every doctor run.
    return enforce ? { ok: false, detail } : { ok: true, detail: `WARN: ${detail}` };
  }
  if (ageMs > warnH * HOUR_MS) {
    return { ok: true, detail: `WARN: last cycle ${ageH}h ago (>${warnH}h)` };
  }
  return { ok: true, detail: `last cycle ${ageH}h ago` };
}
