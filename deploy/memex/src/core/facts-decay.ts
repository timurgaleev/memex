/**
 * Confidence decay for entity facts (deterministic, LLM-free).
 *
 * Migration 037 added `kind` / `notability` / `valid_from` / `valid_until` to
 * `entity_facts`, but until now nothing READ them at recall: `listFacts`
 * ordered purely by raw `confidence`. This module is the consumer for the
 * `kind` / `valid_from` / `valid_until` subset -- the three columns that drive
 * decay. (`notability` is projected but not yet consumed; an ordinal-boost
 * pass over it is a possible follow-on.)
 *
 * `effectiveConfidence(fact, now)` is a pure function:
 *   - a fact past its `valid_until` (an explicit "stopped being true" marker)
 *     scores 0 regardless of kind -- it is historical, not current truth;
 *   - a fact whose `kind` carries a half-life decays as
 *     `confidence * exp(-age_days / halflife_days)`, clamped to [0, 1];
 *   - a fact with no recognized `kind` does NOT decay (returns its clamped
 *     confidence) -- so a legacy row with NULL metadata behaves exactly as it
 *     does today.
 *
 * The half-life table is keyed by memex's own `FactKind` enum (the same five
 * categories the `## Facts` fence parses), so it cannot drift from the schema.
 *
 * Application is default ON internally (`MEMEX_FACT_DECAY=0` disables) —
 * decay is unconditional: without it a stale
 * event ranks as fresh in fact recall. Decay is applied on INTERNAL ingress
 * only: the dispatch layer forces it off on the public-bearer path, because
 * reordering/dropping facts by hidden `valid_until`/`kind` over stable
 * redacted rows would be a content oracle (a caller could diff the decayed
 * order against `order:"recency"` to infer which fact expired). See
 * `mcp/dispatch.ts` callEntityFacts / callEntityRecall.
 */
import type { FactKind } from "./facts-fence.ts";

/**
 * Half-life in days per fact kind. Exported so tests pin the exact table.
 *
 *   event       7 days   -- "lunch on Tuesday" is meaningless after Tuesday
 *   commitment  90 days  -- promises hold longer; an explicit valid_until wins
 *   preference  90 days  -- "doesn't drink coffee" stays useful for a quarter
 *   belief      365 days -- opinions decay slowly, not infinitely
 *   fact        365 days -- most factual rows; same as belief by default
 *
 * At age == half-life the multiplier is exp(-1) ~= 0.368.
 */
export const HALFLIFE_DAYS: Record<FactKind, number> = {
  event: 7,
  commitment: 90,
  preference: 90,
  belief: 365,
  fact: 365,
};

const MS_PER_DAY = 86_400_000;

/** The subset of a fact row decay needs. Dates are text (DATE / timestamptz). */
export interface DecayableFact {
  confidence: number;
  /** mig037 `kind`; NULL or unrecognized => no decay. */
  kind: string | null;
  /** mig037 `valid_from` (DATE text). NULL => fall back to `written_at`. */
  valid_from: string | null;
  /** mig037 `valid_until` (DATE text). A past value zeroes the fact. */
  valid_until: string | null;
  /** mig018 `written_at` (timestamptz text); the decay age anchor fallback. */
  written_at: string;
}

/** True when fact decay is enabled (default ON; MEMEX_FACT_DECAY=0 opts out).
 *  The public-ingress force-off in dispatch is unaffected — it passes an
 *  explicit `decay: false` that overrides this default. */
export function factDecayEnabled(): boolean {
  return process.env.MEMEX_FACT_DECAY !== "0";
}

/**
 * Tolerant date parser for both a bare `YYYY-MM-DD` DATE and Postgres
 * `timestamptz::text` ("2026-06-13 12:14:49.95+00", space-separated, `+00`
 * offset). Returns null on anything unparseable so a poisoned cell degrades to
 * "no anchor / no cutoff" rather than throwing.
 */
export function parseFactDate(s: string | null | undefined): Date | null {
  if (s == null) return null;
  let v = String(s).trim();
  if (v.length === 0) return null;
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (bare) {
    // bare DATE -> UTC midnight, with a calendar round-trip so an invalid date
    // (e.g. 2026-02-31, which `Date` would silently roll into March) returns
    // null rather than a wrong instant -- honoring the "unparseable => null"
    // contract for direct callers (the DB DATE type already rejects these).
    const [, y, mo, da] = bare;
    const d = new Date(`${v}T00:00:00Z`);
    if (
      Number.isNaN(d.getTime()) ||
      d.getUTCFullYear() !== Number(y) ||
      d.getUTCMonth() + 1 !== Number(mo) ||
      d.getUTCDate() !== Number(da)
    ) {
      return null;
    }
    return d;
  }
  v = v.replace(" ", "T");
  // Normalize the trailing timezone to a form JS `Date` accepts. Postgres
  // `timestamptz::text` emits a 2-digit offset ("+00") that `new Date` rejects
  // (it needs `Z`, `+HH:MM`, or `+HHMM`).
  if (/[+-]\d{2}$/.test(v)) {
    v += ":00"; // +00 -> +00:00
  } else if (/[+-]\d{4}$/.test(v)) {
    v = `${v.slice(0, -2)}:${v.slice(-2)}`; // +0000 -> +00:00
  } else if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(v)) {
    v += "Z"; // no timezone -> UTC
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x >= 1 ? 1 : x;
}

/**
 * Effective confidence of a fact at `now`. Pure; no I/O.
 *
 * Order of rules:
 *   1. `valid_until` reached -> 0 (honored regardless of kind). Per the mig037
 *      definition ("the ISO date the fact stopped being true"), the cutoff is
 *      EXCLUSIVE of that date: a fact with `valid_until = 2026-06-13` is no
 *      longer current from 00:00 UTC on 2026-06-13 (it stopped being true that
 *      day), not at the day's end.
 *   2. confidence clamped to [0, 1]; 0 stays 0.
 *   3. no recognized `kind` -> return the clamped confidence (no decay).
 *   4. otherwise multiply by exp(-age_days / halflife). Age anchors on
 *      `valid_from` (when the fact became true) else `written_at` (when it was
 *      recorded). A future anchor (age <= 0) is treated as un-aged.
 */
export function effectiveConfidence(
  f: DecayableFact,
  now: Date = new Date(),
): number {
  const validUntil = parseFactDate(f.valid_until);
  if (validUntil && validUntil.getTime() <= now.getTime()) return 0;

  const c = clamp01(f.confidence);
  if (c === 0) return 0;

  const kind = f.kind;
  if (kind == null || !(kind in HALFLIFE_DAYS)) return c;

  const anchor = parseFactDate(f.valid_from) ?? parseFactDate(f.written_at);
  if (!anchor) return c;

  const ageMs = now.getTime() - anchor.getTime();
  if (ageMs <= 0) return c;

  const ageDays = ageMs / MS_PER_DAY;
  const decayed = c * Math.exp(-ageDays / HALFLIFE_DAYS[kind as FactKind]);
  return clamp01(decayed);
}
