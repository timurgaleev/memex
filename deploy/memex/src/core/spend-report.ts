/**
 * Where the money went: the spend ledger rolled up by model, by feature and by
 * spender over the last N days, with what the totals cannot see.
 *
 * Coverage matters as much as the totals. A call on an unpriced model books an
 * unknown (NULL) cost and a call that failed before Bedrock reported usage books
 * no tokens, so both are counted and named rather than silently folded in.
 */
import type { Engine } from "./engine/interface.ts";

export interface SpendGroup {
  key: string | null;
  calls: number;
  usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface SpendReport {
  since: string;
  days: number;
  total_usd: number;
  calls: number;
  by_model: SpendGroup[];
  by_operation: SpendGroup[];
  by_client: SpendGroup[];
  coverage: {
    /** Calls whose model has no price: their cost is missing from every total. */
    unpriced_calls: number;
    unpriced_models: string[];
    /** Calls that failed before the provider reported usage. */
    no_usage_calls: number;
  };
}

const GROUP_COLUMNS = { by_model: "model", by_operation: "operation", by_client: "client_id" } as const;

export async function spendReport(engine: Engine, opts: { days?: number; now?: Date } = {}): Promise<SpendReport> {
  const days = opts.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error(`days must be a whole number from 1 to 366 (got ${days})`);
  }
  const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString();

  const groups = {} as Record<keyof typeof GROUP_COLUMNS, SpendGroup[]>;
  for (const [name, column] of Object.entries(GROUP_COLUMNS) as [keyof typeof GROUP_COLUMNS, string][]) {
    const r = await engine.query<Record<string, unknown>>(
      `SELECT ${column} AS key, count(*)::int AS calls,
              COALESCE(SUM(spend_cents), 0)::float8 / 100 AS usd,
              COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
         FROM mcp_spend_log
        WHERE created_at >= $1::timestamptz
        GROUP BY ${column}
        ORDER BY usd DESC, calls DESC`,
      [since],
    );
    groups[name] = r.rows.map((row) => ({
      key: (row.key as string | null) ?? null,
      calls: Number(row.calls),
      usd: Number(row.usd),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
    }));
  }

  const cov = await engine.query<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE spend_cents IS NULL)::int AS unpriced_calls,
            count(*) FILTER (WHERE input_tokens IS NULL)::int AS no_usage_calls,
            COALESCE(array_agg(DISTINCT model) FILTER (WHERE spend_cents IS NULL), '{}') AS unpriced_models
       FROM mcp_spend_log
      WHERE created_at >= $1::timestamptz`,
    [since],
  );
  const c = cov.rows[0] ?? {};
  const byModel = groups.by_model;
  return {
    since,
    days,
    total_usd: byModel.reduce((s, g) => s + g.usd, 0),
    calls: byModel.reduce((s, g) => s + g.calls, 0),
    ...groups,
    coverage: {
      unpriced_calls: Number(c.unpriced_calls ?? 0),
      unpriced_models: ((c.unpriced_models as (string | null)[] | null) ?? []).filter((m): m is string => !!m),
      no_usage_calls: Number(c.no_usage_calls ?? 0),
    },
  };
}
