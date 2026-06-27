/**
 * advisor/collectors.ts — the deterministic advisor collectors.
 *
 * Each collector is read-only, LLM-free, and reshapes a signal memex already
 * computes into ranked findings. None of them open Bedrock or write a row. Every
 * collector runs in its OWN try/catch in run.ts, so a missing table or an engine
 * quirk on one never aborts the report.
 *
 * Sources reused (not rebuilt):
 *   - pending migrations  : discoverMigrations() vs the `migrations` table
 *     (same set apply-migrations.ts applies).
 *   - embedding coverage / stalled+failed jobs : brainHealthMetrics()
 *     (the exact primitive doctor.ts + status.ts read).
 *   - version drift       : the version the op passes (package.json) vs the
 *     version the running binary reports — purely local, no network.
 *   - setup smells        : process.env (MEMEX_INTERNAL_TOKEN), same warning
 *     surface as the public guard's legacy fall-through.
 */
import { discoverMigrations } from "../migrate.ts";
import { brainHealthMetrics } from "../source-health.ts";
import packageJson from "../../../package.json" with { type: "json" };
import type { AdvisorCollector, AdvisorFinding } from "./types.ts";

/**
 * Pending schema migrations — the one high-severity signal. An un-migrated brain
 * can be missing columns/indexes newer code expects. Storage init applies
 * migrations on boot, so this only fires when a just-pulled migration hasn't
 * been applied yet (daemon not bounced). The fix is idempotent.
 */
export const collectMigration: AdvisorCollector = {
  id: "migration",
  collect: async (ctx) => {
    let pending: { id: number; name: string }[] = [];
    try {
      // Discover the shipped set, then subtract what the `migrations` table has
      // already recorded. A brand-new brain with no migrations table yields no
      // rows → every shipped migration counts as pending (correct: it is).
      const files = discoverMigrations();
      const seen = new Set<number>();
      try {
        const r = await ctx.engine.query<{ id: number }>(
          "SELECT id FROM migrations",
        );
        for (const row of r.rows) seen.add(Number(row.id));
      } catch {
        // No migrations table yet → nothing recorded, all files are pending.
      }
      pending = files.filter((f) => !seen.has(f.id)).map((f) => ({ id: f.id, name: f.name }));
    } catch {
      return []; // can't enumerate the migration set → say nothing
    }
    if (pending.length === 0) return [];
    const names = pending.map((p) => `${p.id}_${p.name}`).join(", ");
    return [
      {
        id: "pending_migration",
        severity: "high",
        title: `${pending.length} schema migration${pending.length === 1 ? " is" : "s are"} pending — apply before relying on newer features.`,
        detail: `Newer memex code assumes the latest schema; an un-migrated brain can fail or under-perform. Pending: ${names}.`,
        fix_command: "memex apply-migrations",
        collector: "migration",
      },
    ];
  },
};

/**
 * Version drift — the running binary reports a different version than the
 * package.json it was built from. Deterministic + local (NO network: memex has
 * no update cache; versioning is git tags). A mismatch means the live process is
 * stale relative to the checked-out source — restart to pick up the new build.
 *
 * ponytail: inert under memex's single baked-image container deploy — `built`
 * (this import) and the running version are the same package.json, so they never
 * differ in production. The comparison is correct + unit-tested, and fires the
 * moment a caller feeds a distinct runtime version (e.g. a future
 * running-vs-on-disk split); retained for that + reference parity.
 */
export const collectVersion: AdvisorCollector = {
  id: "version",
  collect: async (ctx) => {
    const built = packageJson.version;
    if (typeof built !== "string" || built.length === 0) return [];
    if (built === ctx.version) return [];
    return [
      {
        id: "version_drift",
        severity: "low",
        title: `Running version ${ctx.version} differs from the built package (${built}).`,
        detail: "The live process predates the current build. Restart the daemon to run the latest code.",
        collector: "version",
      },
    ];
  },
};

/**
 * Stalled / dead jobs + a failed-job signal. memex's queue uses status
 * 'running' + `lock_until` (the reference's 'active' + minion_jobs). A running
 * row whose lock lapsed, or whose stall_count has climbed, is wedged and stops
 * backfill/sync from progressing. Failed jobs in the last 24h are the one
 * unambiguous "something broke" signal — read from brainHealthMetrics so the
 * advisor and the doctor agree.
 */
export const collectStalledJobs: AdvisorCollector = {
  id: "stalled-jobs",
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];

    try {
      const r = await ctx.engine.query<{ kind: string; n: number | string }>(
        `SELECT kind, COUNT(*)::int AS n
           FROM jobs
          WHERE status = 'running'
            AND (lock_until < NOW() OR stall_count >= 2)
          GROUP BY kind
          ORDER BY n DESC, kind ASC`,
      );
      for (const row of r.rows) {
        const n = Number(row.n);
        if (!Number.isFinite(n) || n <= 0) continue;
        findings.push({
          id: `stalled_job:${row.kind}`,
          severity: "medium",
          title: `${n} "${row.kind}" job${n === 1 ? "" : "s"} look stalled (lock lapsed / retrying).`,
          detail: "A wedged worker stops backfill / re-index from progressing.",
          fix_command: "memex jobs list",
          collector: "stalled-jobs",
        });
      }
    } catch {
      /* jobs table absent / engine quirk → no stalled-jobs finding */
    }

    try {
      const h = await brainHealthMetrics(ctx.engine);
      if (h.failed_jobs_24h > 0) {
        findings.push({
          id: "failed_jobs_24h",
          severity: "medium",
          title: `${h.failed_jobs_24h} job${h.failed_jobs_24h === 1 ? "" : "s"} failed in the last 24h.`,
          detail: "Inspect the failures and re-run or cancel them — a failing handler can block dependent work.",
          fix_command: "memex jobs list",
          collector: "stalled-jobs",
        });
      }
    } catch {
      /* metrics unavailable → skip the failed-jobs finding */
    }

    return findings;
  },
};

/**
 * Embedding coverage — of the chunks that SHOULD carry a vector (non-code),
 * how many actually do. Low coverage means the vector arm of hybrid search is
 * blind to that content (keyword/FTS still sees it). Same metric the doctor's
 * `source-health` check reports; the fix is the embed backfill.
 */
export const collectEmbedCoverage: AdvisorCollector = {
  id: "embed-coverage",
  collect: async (ctx) => {
    let h;
    try {
      h = await brainHealthMetrics(ctx.engine);
    } catch {
      return []; // metrics unavailable → nothing to advise
    }
    // Nothing embeddable yet (empty brain) → not a gap.
    if (h.embeddable_chunks === 0) return [];
    const missing = h.embeddable_chunks - h.embedded_chunks;
    if (missing <= 0 || h.embed_coverage_pct >= 0.7) return [];
    const pct = Math.round(h.embed_coverage_pct * 100);
    return [
      {
        id: "low_embed_coverage",
        severity: "medium",
        title: `Only ${pct}% of embeddable content is embedded — semantic search is degraded.`,
        detail: `${missing} chunk${missing === 1 ? " is" : "s are"} missing an embedding. Backfill to restore the vector arm of hybrid search.`,
        fix_command: "memex embed",
        collector: "embed-coverage",
      },
    ];
  },
};

/**
 * Usage shape — the graph-hygiene half of the reference's `usage-shape`
 * collector. The embedding-coverage finding it also carries lives in
 * `collectEmbedCoverage` here, so this collector adds only the two link-graph
 * gaps: islanded pages (no inbound AND no outbound link — invisible to graph
 * traversal) and dead links (a `target_slug` that resolves to no live page).
 *
 * Definitions match the reference's getHealth: orphan = islanded (a hub that
 * only links out is working as intended, not an orphan); dead link = a link
 * whose `target_slug` resolves to no live page. Both counts come from ONE round
 * trip; this scan is heavier than the metric collectors, so — like the reference
 * — it belongs to the explicit `advisor` run, not a hot sync-cadence path.
 *
 * Soft-delete adaptation: the reference HARD-deletes pages (the link rows
 * cascade away with them), so a dead page contributes no edges to either count.
 * memex SOFT-deletes (sets `deleted_at`, the link rows survive), so to preserve
 * the reference's semantics a link to/from a soft-deleted page must count as a
 * NON-edge. Both counts therefore gate every edge on a live page at both ends:
 * orphan = no inbound edge FROM a live page and no outbound edge TO a live page;
 * dead link = a live-source link whose target is not a live page (a link from a
 * dead source is itself unreachable, so it is not a "dead link" to fix). A
 * self-loop reads as non-orphan — faithful to the reference, whose orphan check
 * is satisfied by either direction of any edge, self-loop included.
 */
export const collectUsageShape: AdvisorCollector = {
  id: "usage-shape",
  collect: async (ctx) => {
    let row: { page_count: number; orphan_pages: number; dead_links: number } | undefined;
    try {
      const r = await ctx.engine.query<{ page_count: number; orphan_pages: number; dead_links: number }>(
        `SELECT
           (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS page_count,
           (SELECT count(*) FROM pages p
              WHERE p.deleted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM links l JOIN pages s ON s.slug = l.source_slug AND s.deleted_at IS NULL
                   WHERE l.target_slug = p.slug
                )
                AND NOT EXISTS (
                  SELECT 1 FROM links l JOIN pages t ON t.slug = l.target_slug AND t.deleted_at IS NULL
                   WHERE l.source_slug = p.slug
                )
           )::int AS orphan_pages,
           (SELECT count(*) FROM links l
              WHERE EXISTS (
                SELECT 1 FROM pages s WHERE s.slug = l.source_slug AND s.deleted_at IS NULL
              )
                AND NOT EXISTS (
                  SELECT 1 FROM pages t WHERE t.slug = l.target_slug AND t.deleted_at IS NULL
                )
           )::int AS dead_links`,
      );
      row = r.rows[0];
    } catch {
      return []; // pages/links table absent or engine quirk → say nothing
    }
    if (!row || Number(row.page_count) === 0) return []; // empty brain → no graph to advise on

    const findings: AdvisorFinding[] = [];
    const orphans = Number(row.orphan_pages);
    const dead = Number(row.dead_links);

    if (orphans > 0) {
      findings.push({
        id: "orphan_pages",
        severity: "info",
        title: `${orphans} page${orphans === 1 ? " has" : "s have"} no links in or out.`,
        detail: "Islanded pages do not surface through graph traversal — connect or review them.",
        fix_command: "memex orphans",
        collector: "usage-shape",
      });
    }
    if (dead > 0) {
      findings.push({
        id: "dead_links",
        severity: "info",
        title: `${dead} link${dead === 1 ? "" : "s"} point to a page that no longer exists.`,
        detail: "A link whose target was deleted or never created clutters the graph and misleads traversal.",
        fix_command: "memex doctor",
        collector: "usage-shape",
      });
    }
    return findings;
  },
};

/**
 * Setup smells — config/env misconfigurations the owner usually wants to know
 * about. memex has no DB config-key plane, so the one deterministic, security-
 * relevant smell is the internal-auth token being unset: with no
 * MEMEX_INTERNAL_TOKEN, any peer on the docker bridge can call write tools
 * unauthenticated (the public_guard's documented legacy fall-through).
 */
export const collectSetupSmells: AdvisorCollector = {
  id: "setup-smells",
  collect: async () => {
    const findings: AdvisorFinding[] = [];
    const internalToken = (process.env["MEMEX_INTERNAL_TOKEN"] ?? "").trim();
    if (internalToken.length === 0) {
      findings.push({
        id: "internal_token_unset",
        severity: "medium",
        title: "MEMEX_INTERNAL_TOKEN is unset — internal write tools are open on the bridge.",
        detail: "Without the shared token any peer on the docker bridge can call write tools with no auth. Set the secret and restart so the internal endpoint fails closed.",
        fix_command: "memex (set MEMEX_INTERNAL_TOKEN from <secrets_prefix>/memex-internal-token, then restart)",
        collector: "setup-smells",
      });
    }
    return findings;
  },
};
