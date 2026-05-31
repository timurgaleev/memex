/**
 * Friction — log "agent confused" events for triage.
 *
 * The chat surface (or any caller) can append a row when retrieval
 * misses, an answer feels wrong, or a tool errors out. The data flows
 * into reports so we can spot patterns over time.
 *
 * No PII filtering here — caller decides what to log. Default scope:
 * keep it on EFS / RDS, never exposed via the public MCP HTTPS surface
 *.
 */
import type { Engine } from "./engine/interface.ts";

export type FrictionKind =
  | "search-miss"
  | "wrong-answer"
  | "tool-error"
  | "low-confidence"
  | "other"
  // Positive marker — log when a recall produced an unexpectedly good
  // hit so propose-fix can learn from successes too.
  | "delight"
  // Lifecycle markers — pair (start, end) around an operation. The
  // `marker` extra discriminates which side; analyse joins them by
  // run id from `extra.run_id`.
  | "phase-marker"
  // The agent abandoned the operation (timeout, user interrupt, OOM).
  | "interrupted";

/**
 * Canonical set of valid `FrictionKind` values. The MCP dispatcher
 * (src/mcp/dispatch.ts) imports this — keeping one truth-table avoids
 * silent allowlist drift across callers.
 */
export const VALID_FRICTION_KINDS: ReadonlySet<FrictionKind> = new Set([
  "search-miss",
  "wrong-answer",
  "tool-error",
  "low-confidence",
  "other",
  "delight",
  "phase-marker",
  "interrupted",
]);

/**
 * Optional triage severity. Only meaningful for negative events;
 * `delight` and `phase-marker` rows leave this null. Mirrors the
 * categories the agent already produces in chat retrospectives.
 */
export type FrictionSeverity = "confused" | "error" | "blocker" | "nit";

export interface FrictionLogInput {
  kind: FrictionKind;
  query?: string;
  reason?: string;
  sourcePath?: string;
  severity?: FrictionSeverity;
  extra?: Record<string, unknown>;
}

export interface FrictionEvent {
  id: number;
  capturedAt: string;
  kind: FrictionKind;
  query: string | null;
  reason: string | null;
  sourcePath: string | null;
  severity: FrictionSeverity | null;
  extra: Record<string, unknown>;
}

export async function logFriction(
  engine: Engine,
  input: FrictionLogInput,
): Promise<void> {
  if (input.severity !== undefined) {
    const allowed: FrictionSeverity[] = ["confused", "error", "blocker", "nit"];
    if (!allowed.includes(input.severity)) {
      throw new Error(
        `logFriction: severity must be one of ${allowed.join("|")} (got ${input.severity})`,
      );
    }
  }
  await engine.query(
    `INSERT INTO friction_events (kind, query, reason, source_path, severity, extra)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.kind,
      input.query ?? null,
      input.reason ?? null,
      input.sourcePath ?? null,
      input.severity ?? null,
      JSON.stringify(input.extra ?? {}),
    ],
  );
}

export interface FrictionAnalyzeOptions {
  /** Window in hours. Default 168 (one week). */
  sinceHours?: number;
  /** Cap on rows returned. Default 100. */
  limit?: number;
}

export interface FrictionAnalysis {
  byKind: Record<FrictionKind | string, number>;
  topRepeats: { query: string; count: number }[];
  recent: FrictionEvent[];
}

export interface ListFrictionOptions {
  /** Window in hours. Default 168 (one week). */
  sinceHours?: number;
  /** Cap on rows returned. Default 50. */
  limit?: number;
  /** Filter by kind. */
  kind?: FrictionKind;
  /** Filter by extra->>'skill'. */
  skill?: string;
}

interface RawFrictionRow {
  id: number;
  captured_at: string | Date;
  kind: string;
  query: string | null;
  reason: string | null;
  source_path: string | null;
  severity: string | null;
  extra: Record<string, unknown> | string | null;
}

function rowToEvent(r: RawFrictionRow): FrictionEvent {
  let extra: Record<string, unknown> = {};
  if (r.extra) {
    if (typeof r.extra === "string") {
      try {
        extra = JSON.parse(r.extra) as Record<string, unknown>;
      } catch {
        extra = {};
      }
    } else {
      extra = r.extra;
    }
  }
  return {
    id: r.id,
    capturedAt:
      r.captured_at instanceof Date
        ? r.captured_at.toISOString()
        : r.captured_at,
    kind: r.kind as FrictionKind,
    query: r.query,
    reason: r.reason,
    sourcePath: r.source_path,
    severity: (r.severity as FrictionSeverity | null) ?? null,
    extra,
  };
}

export async function listFrictionEvents(
  engine: Engine,
  opts: ListFrictionOptions = {},
): Promise<FrictionEvent[]> {
  const sinceHours = opts.sinceHours ?? 168;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const wheres: string[] = [
    `captured_at > NOW() - ($1 || ' hours')::interval`,
  ];
  const params: unknown[] = [String(sinceHours)];
  if (opts.kind) {
    params.push(opts.kind);
    wheres.push(`kind = $${params.length}`);
  }
  if (opts.skill) {
    params.push(opts.skill);
    wheres.push(`extra->>'skill' = $${params.length}`);
  }
  params.push(limit);
  const rows = await engine.query<RawFrictionRow>(
    `SELECT id, captured_at::text, kind, query, reason, source_path, severity, extra
       FROM friction_events
      WHERE ${wheres.join(" AND ")}
      ORDER BY captured_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(rowToEvent);
}

const REDACT_FIELDS: Array<keyof FrictionEvent> = ["query", "reason"];
const REDACT_PLACEHOLDER = "[redacted]";

/**
 * Markdown-shaped render of a friction event list. Default redacts
 * free-text fields (query, reason) — they're the highest PII surface.
 * Pass `redact=false` for an internal triage view that includes them.
 */
export function renderFrictionMarkdown(
  events: FrictionEvent[],
  opts: { redact?: boolean } = {},
): string {
  const redact = opts.redact ?? true;
  if (events.length === 0) return "_no friction events in window_\n";
  const out: string[] = [];
  out.push("| captured_at | kind | skill | query | reason | source_path |");
  out.push("|---|---|---|---|---|---|");
  for (const e of events) {
    const skill =
      typeof e.extra["skill"] === "string"
        ? (e.extra["skill"] as string)
        : "";
    const view: Record<string, string> = {
      captured_at: e.capturedAt,
      kind: e.kind,
      skill,
      query: redact && e.query ? REDACT_PLACEHOLDER : (e.query ?? ""),
      reason: redact && e.reason ? REDACT_PLACEHOLDER : (e.reason ?? ""),
      source_path: e.sourcePath ?? "",
    };
    out.push(
      `| ${view["captured_at"]} | ${view["kind"]} | ${view["skill"]} | ${escapeMd(view["query"]!)} | ${escapeMd(view["reason"]!)} | ${escapeMd(view["source_path"]!)} |`,
    );
  }
  return out.join("\n") + "\n";
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

// REDACT_FIELDS retained for future per-field redaction policies.
void REDACT_FIELDS;

export async function analyzeFriction(
  engine: Engine,
  opts: FrictionAnalyzeOptions = {},
): Promise<FrictionAnalysis> {
  const sinceHours = opts.sinceHours ?? 168;
  const limit = opts.limit ?? 100;

  const byKindRows = await engine.query<{ kind: string; c: number }>(
    `SELECT kind, COUNT(*)::int AS c
     FROM friction_events
     WHERE captured_at > NOW() - ($1 || ' hours')::interval
     GROUP BY kind`,
    [String(sinceHours)],
  );
  const byKind: Record<string, number> = {};
  for (const r of byKindRows.rows) byKind[r.kind] = r.c;

  const topRepeats = await engine.query<{ query: string; c: number }>(
    `SELECT query, COUNT(*)::int AS c
     FROM friction_events
     WHERE query IS NOT NULL
       AND captured_at > NOW() - ($1 || ' hours')::interval
     GROUP BY query
     HAVING COUNT(*) > 1
     ORDER BY c DESC
     LIMIT 20`,
    [String(sinceHours)],
  );

  const recentRows = await engine.query<RawFrictionRow>(
    `SELECT id, captured_at::text, kind, query, reason, source_path, severity, extra
     FROM friction_events
     WHERE captured_at > NOW() - ($1 || ' hours')::interval
     ORDER BY captured_at DESC
     LIMIT $2`,
    [String(sinceHours), limit],
  );

  const recent: FrictionEvent[] = recentRows.rows.map(rowToEvent);

  return {
    byKind,
    topRepeats: topRepeats.rows.map((r) => ({
      query: r.query,
      count: r.c,
    })),
    recent,
  };
}
