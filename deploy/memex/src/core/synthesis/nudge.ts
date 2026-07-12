/**
 * Take-commit nudge — real-time bias pattern surfacing on commit. When a
 * newly-committed high-conviction take matches an active bias tag on the
 * holder's latest calibration profile, tap
 * the operator on the shoulder with a short conversational line.
 *
 * This is the payoff surface of the calibration loop: bias_tags were written
 * by the calibration phase but nothing consumed them at write time until now.
 *
 * Rules:
 *   - conviction weight must exceed 0.7,
 *   - the take's domain must match an active bias tag on the SAME tenant's
 *     latest profile (memex takes carry a real `domain` column, so no slug
 *     heuristic is needed),
 *   - 14-day cooldown per (take_id, nudge_pattern) via take_nudge_log so the
 *     same pattern never re-fires on every cycle.
 *
 * Deterministic + free: the ship-state nudge text is a template (the voice
 * gate wraps this surface once production examples accumulate). Output channel
 * is stderr; the log's `channel` column already supports future routing.
 *
 * Wiring note: call `nudgeOnTakeCommit(engine, takeKey)` from the take-commit
 * surfaces (set_take_status / propose write path — owned by the takes/MCP
 * layer). Always fail-soft: a nudge error must never fail a take write.
 */
import type { Engine } from "../engine/interface.ts";

export const NUDGE_COOLDOWN_DAYS = 14;
export const NUDGE_CONVICTION_THRESHOLD = 0.7;

export interface NudgeTake {
  id: number;
  weight: number;
  domain: string | null;
}

export interface NudgeProfile {
  bias_tags: string[];
}

export interface NudgeDecision {
  shouldFire: boolean;
  reason?:
    | "no_profile"
    | "below_conviction_threshold"
    | "no_matching_bias_tag"
    | "cooldown_active"
    | "error";
  matchedTag?: string;
  text?: string;
}

/** Pure rule: high conviction + domain matching an active bias tag. */
export function evaluateNudgeRule(
  take: NudgeTake,
  profile: NudgeProfile | null,
): { matched: boolean; reason?: NudgeDecision["reason"]; matchedTag?: string } {
  if (!profile || profile.bias_tags.length === 0) {
    return { matched: false, reason: "no_profile" };
  }
  if (!(take.weight > NUDGE_CONVICTION_THRESHOLD)) {
    return { matched: false, reason: "below_conviction_threshold" };
  }
  const domain = (take.domain ?? "").trim().toLowerCase();
  if (!domain) return { matched: false, reason: "no_matching_bias_tag" };
  for (const tag of profile.bias_tags) {
    if (typeof tag === "string" && tag.toLowerCase().includes(domain)) {
      return { matched: true, matchedTag: tag };
    }
  }
  return { matched: false, reason: "no_matching_bias_tag" };
}

/** Is this (take, pattern) inside the cooldown window? Fail-soft to false. */
export async function checkNudgeCooldown(
  engine: Engine,
  takeId: number,
  nudgePattern: string,
): Promise<boolean> {
  try {
    const { rows } = await engine.query<{ id: number }>(
      `SELECT id FROM take_nudge_log
        WHERE take_id = $1 AND nudge_pattern = $2
          AND fired_at >= now() - ($3 * interval '1 day')
        LIMIT 1`,
      [takeId, nudgePattern, NUDGE_COOLDOWN_DAYS],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Log a fire (the cooldown starts now). */
export async function recordNudgeFire(
  engine: Engine,
  opts: { sourceId: string | null; takeId: number; nudgePattern: string; channel?: string },
): Promise<void> {
  await engine.query(
    `INSERT INTO take_nudge_log (source_id, take_id, nudge_pattern, channel)
     VALUES ($1, $2, $3, $4)`,
    [opts.sourceId, opts.takeId, opts.nudgePattern, opts.channel ?? "stderr"],
  );
}

/** Deterministic conversational template — the ship-state nudge voice. */
export function buildNudgeText(opts: { matchedTag: string; conviction: number }): string {
  const domain = opts.matchedTag.split("-").slice(-1)[0] ?? "this area";
  const pct = Math.round(opts.conviction * 100);
  return (
    `Heads up — you're at ${pct}% conviction and your record tags you ` +
    `${opts.matchedTag}. Worth a second look before betting big on ${domain}?`
  );
}

/** Latest calibration profile's bias tags for a tenant. A NULL tenant (take
 *  with no resolvable source document) reads the 'default' legacy bucket —
 *  the same coalescing the calibration phase uses when writing. Fail-soft. */
export async function loadNudgeProfile(
  engine: Engine,
  sourceId: string | null,
): Promise<NudgeProfile | null> {
  try {
    const { rows } = await engine.query<{ bias_tags: unknown }>(
      `SELECT bias_tags FROM synth_calibration_profile
        WHERE source_id = $1
        ORDER BY generated_at DESC, id DESC
        LIMIT 1`,
      [sourceId ?? "default"],
    );
    const raw = rows[0]?.bias_tags;
    let tags: unknown = raw;
    if (typeof tags === "string") {
      try {
        tags = JSON.parse(tags);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(tags)) return null;
    const clean = tags.filter((t): t is string => typeof t === "string" && t.length > 0);
    return clean.length > 0 ? { bias_tags: clean } : null;
  } catch {
    return null;
  }
}

export interface EvaluateAndFireOpts {
  engine: Engine;
  take: NudgeTake;
  profile: NudgeProfile | null;
  sourceId: string | null;
  /** Override the stderr stream (tests). Production: process.stderr. */
  stderr?: { write: (s: string) => void };
}

/**
 * Evaluate, check cooldown, fire if appropriate, log. Always succeeds — a
 * no-fire is success; errors surface in the decision's reason, never thrown.
 */
export async function evaluateAndFireNudge(opts: EvaluateAndFireOpts): Promise<NudgeDecision> {
  const rule = evaluateNudgeRule(opts.take, opts.profile);
  if (!rule.matched) {
    return {
      shouldFire: false,
      ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
    };
  }
  const tag = rule.matchedTag!;
  if (await checkNudgeCooldown(opts.engine, opts.take.id, tag)) {
    return { shouldFire: false, reason: "cooldown_active", matchedTag: tag };
  }
  const text = buildNudgeText({ matchedTag: tag, conviction: opts.take.weight });
  try {
    (opts.stderr ?? process.stderr).write(text + "\n");
    await recordNudgeFire(opts.engine, {
      sourceId: opts.sourceId,
      takeId: opts.take.id,
      nudgePattern: tag,
    });
  } catch {
    return { shouldFire: false, reason: "error", matchedTag: tag };
  }
  return { shouldFire: true, matchedTag: tag, text };
}

/**
 * Convenience entry for the take-commit surfaces: load the take (by take_key)
 * + its tenant's latest profile, then evaluate-and-fire. Fail-soft: any error
 * is a silent no-fire — a nudge must never break a take write.
 */
export async function nudgeOnTakeCommit(
  engine: Engine,
  takeKey: string,
  opts: { stderr?: { write: (s: string) => void } } = {},
): Promise<NudgeDecision> {
  try {
    const { rows } = await engine.query<{
      id: number;
      weight: number;
      domain: string | null;
      source_id: string | null;
    }>(
      `SELECT t.id, t.weight, t.domain, d.source_id
         FROM synth_takes t
         LEFT JOIN documents d ON d.id = t.source_ref
        WHERE t.take_key = $1`,
      [takeKey],
    );
    const take = rows[0];
    if (!take) return { shouldFire: false, reason: "error" };
    const profile = await loadNudgeProfile(engine, take.source_id);
    return evaluateAndFireNudge({
      engine,
      take: { id: Number(take.id), weight: Number(take.weight), domain: take.domain },
      profile,
      sourceId: take.source_id,
      ...(opts.stderr ? { stderr: opts.stderr } : {}),
    });
  } catch {
    return { shouldFire: false, reason: "error" };
  }
}

/** Clear a take's cooldown so the next commit re-evaluates fresh. */
export async function resetNudgeCooldown(
  engine: Engine,
  takeId: number,
): Promise<{ deleted: number }> {
  const { rows } = await engine.query<{ id: number }>(
    `DELETE FROM take_nudge_log WHERE take_id = $1 RETURNING id`,
    [takeId],
  );
  return { deleted: rows.length };
}
