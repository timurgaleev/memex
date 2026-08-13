/**
 * Money: what a paid Bedrock call costs, what it is allowed to cost, and where
 * the dollar went. Three layers, in that order:
 *
 *   - Pricing (`priceFor` / `costUsd`) — per-1M-token rates on Bedrock
 *     (eu-west-1 cross-region inference), matched by model-family substring so
 *     an exact version suffix doesn't have to be enumerated. Chat and
 *     embedding are separate tables: they bill on different axes.
 *   - Ceilings — the in-process `BudgetTracker` (one call site, one process)
 *     and the durable per-client reservation ledger below. A cap with NO
 *     pricing match HARD-FAILS: never spend against an unpriced model.
 *   - Attribution (`trackedInvoke`, bottom of file) — the chokepoint every
 *     paid call passes through, booking a labelled row per call. Accounting
 *     only; it never refuses a call.
 */
import { randomUUID } from "node:crypto";
import { appendAudit, auditDir } from "./audit-week-file.ts";
import type { Engine } from "./engine/interface.ts";
import type { SonnetUsage } from "./llm/sonnet.ts";

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number;
}

/** Bedrock per-1M CHAT pricing by model-family substring (lowercased match). */
export const MODEL_PRICING: { match: string; price: ModelPricing }[] = [
  // `opus` must precede `sonnet`/`haiku`: first substring match wins, and the
  // deep tier's opus id must not fall through to a cheaper row's pricing.
  { match: "opus", price: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  { match: "sonnet", price: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { match: "haiku", price: { inputPer1M: 1.0, outputPer1M: 5.0 } },
];

/**
 * Bedrock per-1M EMBEDDING pricing — a different axis from chat, so it is a
 * different table. An embedding call bills INPUT tokens only; there is no
 * output side at all, so `outputPer1M` is a truthful zero rather than a chat
 * rate borrowed to make the row typecheck. Consulted BEFORE the chat table so
 * a future embedder whose id happens to carry a chat family substring can
 * never be priced as a chat model.
 */
export const EMBEDDING_PRICING: { match: string; price: ModelPricing }[] = [
  // amazon.titan-embed-text-v2:0 — $0.02 per 1M input tokens.
  { match: "titan-embed", price: { inputPer1M: 0.02, outputPer1M: 0 } },
];

export function priceFor(modelId: string): ModelPricing | null {
  const id = modelId.toLowerCase();
  for (const { match, price } of EMBEDDING_PRICING) {
    if (id.includes(match)) return price;
  }
  for (const { match, price } of MODEL_PRICING) {
    if (id.includes(match)) return price;
  }
  return null;
}

/** Cost in USD for one call's token usage on a given model. */
export function costUsd(modelId: string, usage: SonnetUsage): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  return (
    (usage.inputTokens / 1_000_000) * p.inputPer1M +
    (usage.outputTokens / 1_000_000) * p.outputPer1M
  );
}

/** Bedrock bills a prompt-cache READ at ~10% and a cache WRITE at ~125% of the
 *  normal input rate. */
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

/** Token usage as the Converse API reports it, prompt-cache fields included. */
export interface ReportedUsage extends SonnetUsage {
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/**
 * Fold prompt-cache tokens into an equivalent plain-input count. The price
 * table knows ONE input rate per model, so cached tokens have to be translated
 * into the uncached tokens they cost the same as — otherwise a cache read is
 * either dropped (spend under-reported) or charged at 10× its real price.
 */
export function chargeableUsage(u: ReportedUsage): SonnetUsage {
  const cacheRead = u.cacheReadInputTokens ?? 0;
  const cacheWrite = u.cacheWriteInputTokens ?? 0;
  return {
    inputTokens: Math.ceil(
      u.inputTokens + cacheWrite * CACHE_WRITE_RATE + cacheRead * CACHE_READ_RATE,
    ),
    outputTokens: u.outputTokens,
  };
}

export type BudgetReason = "cost" | "no_pricing";

export class BudgetExhausted extends Error {
  constructor(
    public readonly reason: BudgetReason,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

export interface BudgetSnapshot {
  spentUsd: number;
  maxCostUsd: number;
  callsRecorded: number;
}

export class BudgetTracker {
  private spent = 0;
  private calls = 0;

  constructor(
    private readonly maxCostUsd: number,
    private readonly label: string = "facts-extract",
  ) {}

  /** Would recording this model's call (best-effort cost) exceed the cap? Used
   *  to skip a call BEFORE spending when the prior spend already left no room.
   *  An unpriced model is treated as "would exceed" — consistent with `record`,
   *  which hard-fails rather than spend against an unpriced model. */
  wouldExceed(modelId: string, estUsage: SonnetUsage): boolean {
    if (priceFor(modelId) === null) return true;
    return this.spent + costUsd(modelId, estUsage) > this.maxCostUsd;
  }

  /**
   * Record a completed call's actual usage. Throws BudgetExhausted when the cap
   * is reached (cost) or the model has no pricing (no_pricing) — the cap is a
   * real ceiling. Writes a best-effort audit line.
   */
  record(modelId: string, usage: SonnetUsage): void {
    if (priceFor(modelId) === null) {
      throw new BudgetExhausted(
        "no_pricing",
        `no pricing for model '${modelId}' — refusing to spend against an unpriced model`,
      );
    }
    const c = costUsd(modelId, usage);
    this.spent += c;
    this.calls += 1;
    this.audit(modelId, usage, c);
    if (this.spent > this.maxCostUsd) {
      throw new BudgetExhausted(
        "cost",
        `budget exhausted: spent $${this.spent.toFixed(4)} > cap $${this.maxCostUsd.toFixed(2)} (label=${this.label})`,
      );
    }
  }

  totalSpent(): number {
    return this.spent;
  }

  snapshot(): BudgetSnapshot {
    return {
      spentUsd: this.spent,
      maxCostUsd: this.maxCostUsd,
      callsRecorded: this.calls,
    };
  }

  private audit(modelId: string, usage: SonnetUsage, cost: number): void {
    const dir = auditDir();
    if (!dir) return;
    appendAudit(dir, {
      kind: "budget",
      label: this.label,
      model_id: modelId,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: Number(cost.toFixed(6)),
      cumulative_usd: Number(this.spent.toFixed(6)),
      at: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// DB-backed spend ledger (migration 081) — durable, cross-process accounting
// behind oauth_clients.budget_usd_per_day. The in-process BudgetTracker above
// caps ONE call site within ONE process; this ledger is what makes a per-
// client daily cap real: actuals in mcp_spend_log, in-flight estimates in
// mcp_spend_reservations (reserve → settle/release, TTL-swept on crash).
// Amounts are stored as NUMERIC cents (fractional cents allowed); the API
// speaks USD.
// ---------------------------------------------------------------------------

/** Default reservation TTL — long enough for one LLM call, short enough that
 *  a crashed process frees its held budget quickly. */
export const SPEND_RESERVATION_TTL_MS = 120_000;

const CENTS_PER_USD = 100;

function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`spend amount must be a non-negative finite USD number (got ${usd})`);
  }
  return usd * CENTS_PER_USD;
}

/** UTC day start for the rolling per-day window (deterministic, session-
 *  timezone-independent — computed here, never via date_trunc in SQL). */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface SpendLogInput {
  clientId?: string | null;
  tokenName?: string | null;
  operation: string;
  costUsd: number;
  provider?: string | null;
  model?: string | null;
}

/** Append one completed paid call to the durable spend log. */
export async function logSpend(engine: Engine, e: SpendLogInput): Promise<void> {
  if (typeof e.operation !== "string" || e.operation.length === 0) {
    throw new Error("logSpend: operation must be a non-empty string");
  }
  await engine.query(
    `INSERT INTO mcp_spend_log (client_id, token_name, operation, spend_cents, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      e.clientId ?? null,
      e.tokenName ?? null,
      e.operation,
      usdToCents(e.costUsd),
      e.provider ?? null,
      e.model ?? null,
    ],
  );
}

/**
 * A client's spend so far in the current UTC day: settled actuals PLUS
 * currently-held (pending, unexpired) reservation estimates — so a check
 * during an in-flight call counts that call's held budget.
 */
export async function daySpendUsd(
  engine: Engine,
  clientId: string,
  now: Date = new Date(),
): Promise<number> {
  const dayStart = utcDayStart(now).toISOString();
  const r = await engine.query<{ actual: string | number | null; held: string | number | null }>(
    `SELECT
       (SELECT COALESCE(SUM(spend_cents), 0)
          FROM mcp_spend_log
         WHERE client_id = $1 AND created_at >= $2::timestamptz) AS actual,
       (SELECT COALESCE(SUM(estimated_cents), 0)
          FROM mcp_spend_reservations
         WHERE client_id = $1 AND status = 'pending'
           AND created_at >= $2::timestamptz
           AND expires_at > $3::timestamptz) AS held`,
    [clientId, dayStart, now.toISOString()],
  );
  const row = r.rows[0];
  const cents = Number(row?.actual ?? 0) + Number(row?.held ?? 0);
  return cents / CENTS_PER_USD;
}

export interface ClientBudgetCheck {
  /** False when a cap exists and today's spend (incl. held) already meets it. */
  allowed: boolean;
  /** The client's configured daily cap; null = no cap configured. */
  capUsd: number | null;
  spentUsd: number;
  /** Remaining headroom; null when uncapped. */
  remainingUsd: number | null;
}

/**
 * Check a client against its oauth_clients.budget_usd_per_day. A client with
 * no cap (NULL) — or an unknown client id (legacy PAT paths) — is allowed.
 */
export async function checkClientBudget(
  engine: Engine,
  clientId: string,
  now: Date = new Date(),
): Promise<ClientBudgetCheck> {
  const r = await engine.query<{ budget_usd_per_day: string | number | null }>(
    `SELECT budget_usd_per_day FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const raw = r.rows[0]?.budget_usd_per_day ?? null;
  const capUsd = raw === null ? null : Number(raw);
  const spentUsd = await daySpendUsd(engine, clientId, now);
  if (capUsd === null || !Number.isFinite(capUsd)) {
    return { allowed: true, capUsd: null, spentUsd, remainingUsd: null };
  }
  return {
    allowed: spentUsd < capUsd,
    capUsd,
    spentUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd),
  };
}

export interface ReserveSpendInput {
  clientId: string;
  estimatedUsd: number;
  model: string;
  provider: string;
  /** Reservation TTL override (ms). */
  ttlMs?: number;
  /** Clock seam (tests). */
  now?: Date;
}

export type ReserveSpendResult =
  | { reserved: true; reservationId: string }
  | { reserved: false; reason: "budget_exhausted"; check: ClientBudgetCheck };

/**
 * Pre-flight hold: reject when the client's cap leaves no room for the
 * ESTIMATE on top of today's spend (actuals + other holds), else insert a
 * pending reservation. The cap check + insert run under a per-client
 * advisory xact lock so racing reserves serialize instead of both reading
 * the pre-insert sum and overshooting the daily cap. Harmless on PGLite
 * (single connection — no concurrency to serialize).
 */
export async function reserveSpend(
  engine: Engine,
  input: ReserveSpendInput,
): Promise<ReserveSpendResult> {
  const now = input.now ?? new Date();
  const estCents = usdToCents(input.estimatedUsd);
  const reservationId = randomUUID();
  const ttl = input.ttlMs ?? SPEND_RESERVATION_TTL_MS;
  return engine.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `memex_spend:${input.clientId}`,
    ]);
    const check = await checkClientBudget(tx, input.clientId, now);
    if (
      check.capUsd !== null &&
      check.spentUsd + estCents / CENTS_PER_USD > check.capUsd
    ) {
      return { reserved: false, reason: "budget_exhausted", check };
    }
    await tx.query(
      `INSERT INTO mcp_spend_reservations
         (reservation_id, client_id, estimated_cents, model, provider, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6::timestamptz, $7::timestamptz)`,
      [
        reservationId,
        input.clientId,
        estCents,
        input.model,
        input.provider,
        now.toISOString(),
        new Date(now.getTime() + ttl).toISOString(),
      ],
    );
    return { reserved: true, reservationId };
  });
}

/**
 * Settle a reservation with the ACTUAL cost: marks it settled and appends the
 * actual to mcp_spend_log in one transaction. Idempotent — a second settle of
 * the same id is a no-op (no duplicate log row).
 */
export async function settleSpend(
  engine: Engine,
  reservationId: string,
  actualUsd: number,
  operation: string = "llm",
): Promise<{ settled: boolean }> {
  const actualCents = usdToCents(actualUsd);
  return engine.transaction(async (tx) => {
    const upd = await tx.query<{
      client_id: string;
      model: string;
      provider: string;
    }>(
      `UPDATE mcp_spend_reservations
          SET status = 'settled', actual_cents = $2, settled_at = NOW()
        WHERE reservation_id = $1 AND status = 'pending'
        RETURNING client_id, model, provider`,
      [reservationId, actualCents],
    );
    const row = upd.rows[0];
    if (!row) return { settled: false };
    await tx.query(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, provider, model)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.client_id, operation, actualCents, row.provider, row.model],
    );
    return { settled: true };
  });
}

/** Release a hold without spending (the call failed before costing money). */
export async function releaseReservation(
  engine: Engine,
  reservationId: string,
): Promise<{ released: boolean }> {
  const r = await engine.query<{ reservation_id: string }>(
    `UPDATE mcp_spend_reservations
        SET status = 'expired', settled_at = NOW()
      WHERE reservation_id = $1 AND status = 'pending'
      RETURNING reservation_id`,
    [reservationId],
  );
  return { released: r.rows.length > 0 };
}

/** TTL sweep: expire pending holds whose window lapsed (crashed callers).
 *  Safe to run from any cycle phase; returns the count expired. */
export async function expireStaleReservations(
  engine: Engine,
  now: Date = new Date(),
): Promise<number> {
  const r = await engine.query<{ reservation_id: string }>(
    `UPDATE mcp_spend_reservations
        SET status = 'expired', settled_at = NOW()
      WHERE status = 'pending' AND expires_at <= $1::timestamptz
      RETURNING reservation_id`,
    [now.toISOString()],
  );
  return r.rows.length;
}

// ---------------------------------------------------------------------------
// Paid-call chokepoint — the ONE wrapper every Bedrock invoke goes through.
//
// Before this, spend was un-attributable: eight sites each built their own
// command, the three search ones threaded no BudgetTracker at all, and the
// tracker itself only ever wrote to an audit FILE that is disabled unless
// MEMEX_AUDIT_DIR is set — so on the live deployment the cost was computed and
// thrown away. `trackedInvoke` books every call into mcp_spend_log under an
// operation label naming the feature, which is what makes "where did the $42
// go" answerable with a GROUP BY.
//
// This is accounting, NOT enforcement: it never refuses a call and never
// touches a budget ceiling. Ceilings stay exactly where they were —
// BudgetTracker (per-call-site, in-process) and reserveSpend (per-client,
// durable).
// ---------------------------------------------------------------------------

/** memex's only paid provider. */
const DEFAULT_SPEND_PROVIDER = "bedrock";

export interface TrackedCall {
  /** The feature this call is spent ON — the ledger's attribution key. */
  operation: string;
  /** Resolved model id, as it actually went on the wire (prices the call). */
  model: string;
  /** Defaults to "bedrock". */
  provider?: string;
}

/** Sink a wrapped call reports its ACTUAL billed usage to, as soon as the
 *  model reports it — which may be well before the call returns. */
export interface SpendMeter {
  report(usage: ReportedUsage): void;
}

/**
 * The ledger's engine. A module-level sink rather than a threaded argument
 * because the paid sites are leaf helpers (embed a string, classify a query)
 * that have no business taking a database handle. Wired once by whoever opens
 * the DB; until then the chokepoint is a no-op passthrough, exactly like
 * telemetry before its first `setEngine`.
 */
let _ledgerEngine: Engine | null = null;

export function setSpendLedgerEngine(engine: Engine | null): void {
  _ledgerEngine = engine;
}

/** Model ids already warned about — one line per unpriced model, not per call. */
const _unpricedWarned = new Set<string>();

/**
 * Run a paid model call and book it.
 *
 * `send` receives a meter and reports the usage Bedrock billed. The booking
 * happens in a `finally`, so a call that reported usage and THEN threw (a
 * parse failure, a dimension check, an aborted read of a delivered response)
 * is still billed — those tokens were charged to the account whether or not
 * the caller got an answer out of them. A call that threw before any usage was
 * reported still writes a $0 row: the attempt is attributable even when it
 * bought nothing.
 */
export async function trackedInvoke<T>(
  call: TrackedCall,
  send: (meter: SpendMeter) => Promise<T>,
): Promise<T> {
  let usage: SonnetUsage = { inputTokens: 0, outputTokens: 0 };
  const meter: SpendMeter = {
    // A second report REPLACES the first: a retry inside `send` (the cachePoint
    // fallback) is one logical call that was billed once, at whatever the
    // attempt that actually reached the model consumed.
    report: (u) => void (usage = chargeableUsage(u)),
  };
  try {
    return await send(meter);
  } finally {
    await bookSpend(call, usage);
  }
}

/**
 * Append one call to the durable ledger. Every failure is logged and swallowed:
 * accounting must never break a paid path, the same contract search telemetry
 * already keeps.
 */
async function bookSpend(call: TrackedCall, usage: SonnetUsage): Promise<void> {
  const engine = _ledgerEngine;
  if (!engine) return;
  if (priceFor(call.model) === null && !_unpricedWarned.has(call.model)) {
    _unpricedWarned.add(call.model);
    console.warn(
      `[memex] spend ledger: no pricing for model '${call.model}' — its calls ` +
        `book $0, so the ledger under-reports until MODEL_PRICING/EMBEDDING_PRICING learns it`,
    );
  }
  try {
    await logSpend(engine, {
      operation: call.operation,
      costUsd: costUsd(call.model, usage),
      provider: call.provider ?? DEFAULT_SPEND_PROVIDER,
      model: call.model,
    });
  } catch (err) {
    console.warn(
      `[memex] spend ledger write failed for '${call.operation}': ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
