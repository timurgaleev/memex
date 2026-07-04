/**
 * Typed numeric metric claims + find_trajectory regression / drift (mig070).
 *
 * Covers the four surfaces the feature threads through:
 *   - addFact persists + normalizes claim_metric/value/unit/period/event_type.
 *   - the `## Facts` fence parses + round-trips the typed columns (and stays
 *     narrow when no row is typed).
 *   - reconcile projects the fence's typed cells into entity_facts.
 *   - findTrajectory metric/kind filters + the pure regression + drift stats,
 *     all tenant-scoped.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import {
  parseFactsFence,
  renderFactsFence,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
} from "../src/core/facts-fence.ts";
import {
  findTrajectory,
  findTrajectoryStats,
  detectRegressions,
  computeDriftScore,
  resolveRegressionThreshold,
  type TrajectoryPoint,
} from "../src/core/insights.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-metric-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Insert one metric-claim fact directly (addFact carries no valid_from). */
async function insertMetricFact(args: {
  entity: string;
  fact: string;
  metric: string;
  value: number;
  validFrom: string;
  sourceId?: string;
  withEmbedding?: boolean;
}): Promise<void> {
  const emb = args.withEmbedding
    ? JSON.stringify(deterministicEmbed(args.fact))
    : null;
  await storage.engine().query(
    `INSERT INTO entity_facts
       (entity_slug, fact, confidence, claim_metric, claim_value, claim_unit,
        valid_from, embedding, source_id)
     VALUES ($1, $2, 1.0, $3, $4, 'usd', $5, $6::vector, $7)`,
    [
      args.entity,
      args.fact,
      args.metric,
      args.value,
      args.validFrom,
      emb,
      args.sourceId ?? "default",
    ],
  );
}

/** Hand-build a TrajectoryPoint for the pure-function tests. */
function mkPoint(over: Partial<TrajectoryPoint>): TrajectoryPoint {
  return {
    source: "fact",
    at: "2024-01-01T00:00:00Z",
    text: "x",
    kind: null,
    id: 1,
    metric: null,
    value: null,
    unit: null,
    period: null,
    event_type: null,
    embedding: null,
    ...over,
  };
}

describe("addFact — typed metric-claim persistence", () => {
  it("persists and normalizes claim fields", async () => {
    await addFact(storage, {
      entity_slug: "companies/acme",
      fact: "MRR reached 50000 USD monthly",
      claim_metric: "MRR",
      claim_value: 50000,
      claim_unit: "USD",
      claim_period: "monthly",
    });
    const r = await storage.engine().query<{
      claim_metric: string | null;
      claim_value: string | null;
      claim_unit: string | null;
      claim_period: string | null;
      event_type: string | null;
    }>(
      `SELECT claim_metric, claim_value, claim_unit, claim_period, event_type
         FROM entity_facts WHERE entity_slug = $1`,
      ["companies/acme"],
    );
    expect(r.rows[0]!.claim_metric).toBe("mrr"); // lowercased snake_case
    expect(Number(r.rows[0]!.claim_value)).toBe(50000);
    expect(r.rows[0]!.claim_unit).toBe("USD");
    expect(r.rows[0]!.claim_period).toBe("monthly");
    expect(r.rows[0]!.event_type).toBeNull();
  });

  it("normalizes an event_type label and drops a non-finite value", async () => {
    await addFact(storage, {
      entity_slug: "people/marco",
      fact: "changed jobs",
      event_type: "Job Change",
      claim_value: Number.NaN,
    });
    const r = await storage.engine().query<{
      event_type: string | null;
      claim_value: string | null;
    }>(
      `SELECT event_type, claim_value FROM entity_facts WHERE entity_slug = $1`,
      ["people/marco"],
    );
    expect(r.rows[0]!.event_type).toBe("job_change");
    expect(r.rows[0]!.claim_value).toBeNull();
  });

  it("leaves an ordinary fact's claim columns NULL", async () => {
    await addFact(storage, { entity_slug: "people/plain", fact: "likes tea" });
    const r = await storage.engine().query<{ claim_metric: string | null }>(
      `SELECT claim_metric FROM entity_facts WHERE entity_slug = $1`,
      ["people/plain"],
    );
    expect(r.rows[0]!.claim_metric).toBeNull();
  });
});

describe("facts fence — typed-claim columns", () => {
  const typedFence = [
    FACTS_FENCE_BEGIN,
    "| # | claim | kind | confidence | notability | valid_from | valid_until | source | claim_metric | claim_value | claim_unit | claim_period | event_type |",
    "|---|-------|------|------------|------------|------------|-------------|--------|--------------|-------------|------------|--------------|------------|",
    "| 1 | MRR hit 50k | fact | 1 | high | 2024-01-01 |  | bo call | MRR | 50,000 | usd | monthly |  |",
    "| 2 | Marco changed jobs | event | 1 |  | 2024-02-01 |  | note |  |  |  |  | Job Change |",
    FACTS_FENCE_END,
  ].join("\n");

  it("parses typed cells with normalization + thousands separator", () => {
    const facts = parseFactsFence(typedFence);
    expect(facts).toHaveLength(2);
    expect(facts[0]!.claimMetric).toBe("mrr");
    expect(facts[0]!.claimValue).toBe(50000);
    expect(facts[0]!.claimUnit).toBe("usd");
    expect(facts[0]!.claimPeriod).toBe("monthly");
    expect(facts[1]!.eventType).toBe("job_change");
    expect(facts[1]!.claimMetric).toBeUndefined();
  });

  it("round-trips through render → parse", () => {
    const facts = parseFactsFence(typedFence);
    const round = parseFactsFence(renderFactsFence(facts));
    expect(round[0]!.claimMetric).toBe("mrr");
    expect(round[0]!.claimValue).toBe(50000);
    expect(round[1]!.eventType).toBe("job_change");
  });

  it("stays narrow (no typed columns) when no row is typed", () => {
    const narrow: ParsedFact[] = [
      { rowNum: 1, claim: "plain claim", confidence: 1, active: true },
    ];
    const rendered = renderFactsFence(narrow);
    expect(rendered.includes("claim_metric")).toBe(false);
  });
});

describe("reconcile — projects fence typed cells into entity_facts", () => {
  it("writes claim_metric/value from the fence", async () => {
    const body = [
      "# companies/beta",
      "",
      "## Facts",
      "",
      FACTS_FENCE_BEGIN,
      "| # | claim | kind | confidence | notability | valid_from | valid_until | source | claim_metric | claim_value | claim_unit | claim_period | event_type |",
      "|---|-------|------|------------|------------|------------|-------------|--------|--------------|-------------|------------|--------------|------------|",
      "| 1 | ARR 1.2M | fact | 1 |  | 2024-03-01 |  | deck | arr | 1200000 | usd | annual |  |",
      FACTS_FENCE_END,
    ].join("\n");
    const page = await putPage(storage, {
      slug: "companies/beta",
      type: "company",
      markdown_body: body,
    });
    const res = await reconcileFactsForPage(storage, "companies/beta", page.content_hash);
    expect(res.added).toBe(1);
    const r = await storage.engine().query<{
      claim_metric: string | null;
      claim_value: string | null;
    }>(
      `SELECT claim_metric, claim_value FROM entity_facts
         WHERE source_markdown_slug = $1`,
      ["companies/beta"],
    );
    expect(r.rows[0]!.claim_metric).toBe("arr");
    expect(Number(r.rows[0]!.claim_value)).toBe(1200000);
  });
});

describe("detectRegressions", () => {
  it("fires on a >=10% consecutive drop, once per drop", () => {
    const pts = [
      mkPoint({ id: 1, at: "2024-01-01T00:00:00Z", metric: "mrr", value: 100 }),
      mkPoint({ id: 2, at: "2024-02-01T00:00:00Z", metric: "mrr", value: 105 }),
      mkPoint({ id: 3, at: "2024-03-01T00:00:00Z", metric: "mrr", value: 90 }),
      mkPoint({ id: 4, at: "2024-04-01T00:00:00Z", metric: "mrr", value: 95 }),
    ];
    const regs = detectRegressions(pts);
    expect(regs).toHaveLength(1);
    expect(regs[0]!.metric).toBe("mrr");
    expect(regs[0]!.from_value).toBe(105);
    expect(regs[0]!.to_value).toBe(90);
    expect(regs[0]!.from_date).toBe("2024-02-01");
    expect(regs[0]!.delta_pct).toBeLessThan(-0.1);
  });

  it("does NOT fire on a sub-threshold (<10%) drop", () => {
    const pts = [
      mkPoint({ id: 1, at: "2024-01-01T00:00:00Z", metric: "mrr", value: 100 }),
      mkPoint({ id: 2, at: "2024-02-01T00:00:00Z", metric: "mrr", value: 95 }),
    ];
    expect(detectRegressions(pts)).toHaveLength(0);
  });

  it("groups per metric — no false cross-metric drop", () => {
    const pts = [
      mkPoint({ id: 1, at: "2024-01-01T00:00:00Z", metric: "arr", value: 1000 }),
      mkPoint({ id: 2, at: "2024-02-01T00:00:00Z", metric: "team_size", value: 5 }),
      mkPoint({ id: 3, at: "2024-03-01T00:00:00Z", metric: "arr", value: 1100 }),
    ];
    // arr goes 1000 → 1100 (up); team_size is a lone point. No regression.
    expect(detectRegressions(pts)).toHaveLength(0);
  });

  it("skips a metric starting at exactly 0 (no relative delta)", () => {
    const pts = [
      mkPoint({ id: 1, at: "2024-01-01T00:00:00Z", metric: "churn", value: 0 }),
      mkPoint({ id: 2, at: "2024-02-01T00:00:00Z", metric: "churn", value: -5 }),
    ];
    expect(detectRegressions(pts)).toHaveLength(0);
  });
});

describe("computeDriftScore", () => {
  it("returns null with fewer than 3 embedded points", () => {
    const pts = [
      mkPoint({ id: 1, embedding: deterministicEmbed("alpha") }),
      mkPoint({ id: 2, embedding: deterministicEmbed("beta") }),
    ];
    expect(computeDriftScore(pts)).toBeNull();
  });

  it("is ~0 for identical embeddings (no drift)", () => {
    const e = deterministicEmbed("same text");
    const pts = [
      mkPoint({ id: 1, embedding: [...e] }),
      mkPoint({ id: 2, embedding: [...e] }),
      mkPoint({ id: 3, embedding: [...e] }),
    ];
    const drift = computeDriftScore(pts)!;
    expect(drift).toBeGreaterThanOrEqual(0);
    expect(drift).toBeLessThan(1e-6);
  });

  it("is high for orthogonal embeddings", () => {
    const a = new Array(1024).fill(0);
    a[0] = 1;
    const b = new Array(1024).fill(0);
    b[1] = 1;
    const c = new Array(1024).fill(0);
    c[2] = 1;
    const pts = [
      mkPoint({ id: 1, embedding: a }),
      mkPoint({ id: 2, embedding: b }),
      mkPoint({ id: 3, embedding: c }),
    ];
    expect(computeDriftScore(pts)).toBeCloseTo(1, 5);
  });
});

describe("resolveRegressionThreshold", () => {
  it("defaults to 0.1 and rejects out-of-range env", () => {
    expect(resolveRegressionThreshold(undefined)).toBe(0.1);
    expect(resolveRegressionThreshold("2")).toBe(0.1);
    expect(resolveRegressionThreshold("0.25")).toBe(0.25);
  });
});

describe("findTrajectory — metric filter + stats", () => {
  it("filters to a metric and carries value on each point", async () => {
    await putPage(storage, { slug: "companies/gamma", type: "company" });
    await insertMetricFact({
      entity: "companies/gamma",
      fact: "MRR 100",
      metric: "mrr",
      value: 100,
      validFrom: "2024-01-01",
    });
    await insertMetricFact({
      entity: "companies/gamma",
      fact: "team size 4",
      metric: "team_size",
      value: 4,
      validFrom: "2024-02-01",
    });
    const pts = await findTrajectory(storage, "companies/gamma", { metric: "MRR" });
    expect(pts).toHaveLength(1);
    expect(pts[0]!.metric).toBe("mrr");
    expect(pts[0]!.value).toBe(100);
  });

  it("computes a regression via findTrajectoryStats over the metric series", async () => {
    await putPage(storage, { slug: "companies/delta", type: "company" });
    const series: Array<[string, number]> = [
      ["2024-01-01", 100],
      ["2024-02-01", 105],
      ["2024-03-01", 88], // 105 → 88 is a ~16% drop
      ["2024-04-01", 90],
    ];
    for (const [validFrom, value] of series) {
      await insertMetricFact({
        entity: "companies/delta",
        fact: `MRR ${value}`,
        metric: "mrr",
        value,
        validFrom,
        withEmbedding: true,
      });
    }
    const { points, stats } = await findTrajectoryStats(storage, "companies/delta");
    expect(points).toHaveLength(4);
    expect(stats.regressions).toHaveLength(1);
    expect(stats.regressions[0]!.to_value).toBe(88);
    // Four embedded points → drift_score is a number in [0,1].
    expect(stats.drift_score).not.toBeNull();
    expect(stats.drift_score!).toBeGreaterThanOrEqual(0);
    expect(stats.drift_score!).toBeLessThanOrEqual(1);
  });
});

describe("findTrajectory — tenancy", () => {
  it("scopes the metric series to the caller's source only", async () => {
    // source_id has an FK to sources(id) (mig047) — register both tenants.
    for (const id of ["tenant-a", "tenant-b"]) {
      await storage.engine().query(
        "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
        [id, `/${id}`],
      );
    }
    await putPage(storage, { slug: "companies/omega", type: "company" });
    // tenant-a: a clean 10% drop; tenant-b: an unrelated higher value that
    // would suppress the drop if the scope leaked.
    await insertMetricFact({
      entity: "companies/omega",
      fact: "a1",
      metric: "mrr",
      value: 100,
      validFrom: "2024-01-01",
      sourceId: "tenant-a",
    });
    await insertMetricFact({
      entity: "companies/omega",
      fact: "a2",
      metric: "mrr",
      value: 80,
      validFrom: "2024-02-01",
      sourceId: "tenant-a",
    });
    await insertMetricFact({
      entity: "companies/omega",
      fact: "b1",
      metric: "mrr",
      value: 500,
      validFrom: "2024-01-15",
      sourceId: "tenant-b",
    });

    const scoped = await findTrajectory(storage, "companies/omega", {
      metric: "mrr",
      sourceIds: ["tenant-a"],
    });
    expect(scoped.map((p) => p.value)).toEqual([100, 80]);
    expect(detectRegressions(scoped)).toHaveLength(1);

    // Unscoped sees all three; the interleaved tenant-b row breaks the pair.
    const all = await findTrajectory(storage, "companies/omega", { metric: "mrr" });
    expect(all).toHaveLength(3);
  });
});
