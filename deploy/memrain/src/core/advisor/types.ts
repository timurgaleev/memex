/**
 * advisor/types.ts — shared types for the `advisor` MCP tool.
 *
 * The advisor is a read-only, brain-state-aware recommender: it runs a fixed set
 * of deterministic collectors and returns a ranked list of findings for THIS
 * brain right now, each with a severity, a one-line why-it-matters, and the
 * exact fix command. It NEVER mutates and NEVER calls an LLM — it only reshapes
 * signals memex already computes (doctor / status / migrate / jobs) into ranked,
 * actionable findings. Print-never-execute: the MCP client shows the user and
 * asks before running any fix command.
 */
import type { Engine } from "../engine/interface.ts";

/**
 * Severity ladder. `high` is the only "act before relying on the brain" tier;
 * `medium`/`low` are quality gaps; `info` is FYI. (memex uses high/medium/low/
 * info — it matches the doctor's own categorization vocabulary and the
 * eval-gate severity language already in the codebase.)
 */
export type AdvisorSeverity = "high" | "medium" | "low" | "info";

export interface AdvisorFinding {
  /** Stable id (e.g. 'pending_migration', 'low_embed_coverage'). */
  id: string;
  severity: AdvisorSeverity;
  /** One-line why-it-matters. */
  title: string;
  /** Optional extra context. */
  detail?: string;
  /**
   * The exact command the user can run to fix it, as a single string (e.g.
   * "memex embed"). Omitted when there is no single mechanical fix. The advisor
   * never runs this itself — it is surfaced for the client to show the user.
   */
  fix_command?: string;
  /** Which collector emitted it (also the secondary sort key for ranking). */
  collector: string;
}

export interface AdvisorContext {
  engine: Engine;
  /** Serving memex version (package.json). */
  version: string;
  now: Date;
  /**
   * Caller's tenant read scope. Collectors that read tenant-owned data (the
   * chronicle collector) MUST scope to it and stay silent when it is absent —
   * a source-scoped read never leaks another tenant's rows. The brain-health
   * collectors (migration / jobs / embed coverage) are whole-brain operator
   * signals and ignore this.
   */
  sourceIds?: readonly string[];
}

export interface AdvisorCollector {
  id: string;
  collect: (ctx: AdvisorContext) => Promise<AdvisorFinding[]>;
}

export interface AdvisorReport {
  version: string;
  generated_at: string;
  findings: AdvisorFinding[];
  /** Highest severity present, for at-a-glance triage. null when empty. */
  worst: AdvisorSeverity | null;
}
