/**
 * `memex check-resolvable` — wikilink coverage report.
 *
 * Walks every `wikilink` entity in the corpus, asks the resolver
 * registry whether it points at a real document, prints a counts
 * table + path list of orphans.
 *
 * Designed for cron use: pass `--threshold N` to exit non-zero when
 * the unresolved-rate exceeds N%, so it can be piped into an alert.
 *
 * Read-only. To rewrite source files, see `reconcile-links --apply`
 *.
 */
import type { Engine } from "../core/engine/interface.ts";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { wikilinkResolver } from "../core/resolvers/builtin/wikilink.ts";
import { registerResolver, getResolver } from "../core/resolvers/registry.ts";

export interface CheckResolvableCmdOptions {
  /** Cap on orphan list returned (counts in the header are always full). */
  reportLimit?: number;
  /** Unresolved-rate (0–100) above which the command exits non-zero. */
  threshold?: number;
  /**
   * When true, warnings flip the exit code as well as errors. Default
   * mode only fails on errors, so advisory checks (orphan ratio below
   * threshold) don't break CI.
   */
  strict?: boolean;
}

export interface CheckIssue {
  rule: string;
  severity: "error" | "warning";
  message: string;
  /** Free-form details — ids, counts, sample paths. */
  detail?: Record<string, unknown>;
}

export interface CheckResolvableReport {
  ok: boolean;
  total: number;
  resolved: number;
  unresolved: number;
  coverage: number;
  unresolvedRate: number;
  threshold?: number;
  strict?: boolean;
  /** Failing checks. Anything here flips ok=false. */
  errors: CheckIssue[];
  /** Advisory checks. Flip ok=false only with --strict. */
  warnings: CheckIssue[];
  /**
   * Stable empty slot. Future deferred checks land here without
   * breaking downstream consumers that already read `.deferred`.
   */
  deferred: CheckIssue[];
  orphans: { name: string; mentionCount: number }[];
}

/**
 * Compute the report against an arbitrary engine. Pure-ish — no
 * config loading, no stdout, no exit-code mutation. Tests call this
 * directly; the CLI wrapper layers Storage init + JSON emit on top.
 */
export async function buildCheckResolvableReport(
  engine: Engine,
  opts: CheckResolvableCmdOptions = {},
): Promise<CheckResolvableReport> {
  const reportLimit = opts.reportLimit ?? 50;
  const threshold = opts.threshold;

  registerResolver(wikilinkResolver);
  const resolver = getResolver("wikilink");
  if (!resolver) {
    throw new Error("check-resolvable: wikilink resolver not registered");
  }

  const rows = await engine.query<{ name: string; mention_count: number }>(
    `SELECT e.name, COUNT(em.chunk_id)::int AS mention_count
       FROM entities e
       LEFT JOIN entity_mentions em ON em.entity_id = e.id
      WHERE e.type = 'wikilink'
      GROUP BY e.name
      ORDER BY mention_count DESC, e.name`,
  );

  let resolved = 0;
  const orphans: { name: string; mentionCount: number }[] = [];
  for (const row of rows.rows) {
    const res = await resolver.resolve(row.name, { engine });
    if (res.documentId !== null) {
      resolved++;
    } else {
      orphans.push({ name: row.name, mentionCount: row.mention_count });
    }
  }
  const total = rows.rows.length;
  const unresolved = total - resolved;
  const coverage = total === 0 ? 100 : round2((resolved / total) * 100);
  const unresolvedRate = total === 0 ? 0 : round2((unresolved / total) * 100);

  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

  if (threshold !== undefined && unresolvedRate > threshold) {
    errors.push({
      rule: "orphan-rate-above-threshold",
      severity: "error",
      message: `unresolved rate ${unresolvedRate}% exceeds threshold ${threshold}%`,
      detail: { unresolvedRate, threshold },
    });
  }
  if (unresolved > 0) {
    warnings.push({
      rule: "orphans-present",
      severity: "warning",
      message: `${unresolved} of ${total} wikilink(s) do not resolve to a document`,
      detail: { unresolved, total, sample: orphans.slice(0, 5) },
    });
  }

  const strict = opts.strict ?? false;
  const ok = errors.length === 0 && (!strict || warnings.length === 0);

  return {
    ok,
    total,
    resolved,
    unresolved,
    coverage,
    unresolvedRate,
    ...(threshold !== undefined ? { threshold } : {}),
    ...(strict ? { strict: true } : {}),
    errors,
    warnings,
    deferred: [],
    orphans: orphans.slice(0, reportLimit),
  };
}

export async function runCheckResolvable(
  opts: CheckResolvableCmdOptions = {},
): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const report = await buildCheckResolvableReport(storage.engine(), opts);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
