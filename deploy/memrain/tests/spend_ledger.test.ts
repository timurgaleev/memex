/**
 * DB-backed spend ledger (migration 081 + budget.ts ledger API): spend log
 * rollup, per-client daily cap check against oauth_clients.budget_usd_per_day,
 * reserve → settle / release, and the TTL sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  checkClientBudget,
  daySpendUsd,
  expireStaleReservations,
  logSpend,
  releaseReservation,
  reserveSpend,
  settleSpend,
} from "../src/core/budget.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-spend-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage.engine().query(
    `INSERT INTO oauth_clients (client_id, client_name, budget_usd_per_day)
     VALUES ('capped', 'Capped Client', 1.00),
            ('uncapped', 'Uncapped Client', NULL)`,
  );
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("spend log rollup", () => {
  it("sums today's actuals per client", async () => {
    await logSpend(storage.engine(), {
      clientId: "capped",
      operation: "think",
      costUsd: 0.25,
      provider: "bedrock",
      model: "sonnet",
    });
    await logSpend(storage.engine(), {
      clientId: "capped",
      operation: "think",
      costUsd: 0.1,
    });
    await logSpend(storage.engine(), { clientId: "uncapped", operation: "x", costUsd: 9 });
    expect(await daySpendUsd(storage.engine(), "capped")).toBeCloseTo(0.35, 6);
  });
});

describe("checkClientBudget", () => {
  it("allows under the cap, blocks at/over it; uncapped and unknown always allowed", async () => {
    await logSpend(storage.engine(), { clientId: "capped", operation: "x", costUsd: 0.4 });
    let c = await checkClientBudget(storage.engine(), "capped");
    expect(c.allowed).toBe(true);
    expect(c.capUsd).toBe(1);
    expect(c.remainingUsd).toBeCloseTo(0.6, 6);

    await logSpend(storage.engine(), { clientId: "capped", operation: "x", costUsd: 0.6 });
    c = await checkClientBudget(storage.engine(), "capped");
    expect(c.allowed).toBe(false);
    expect(c.remainingUsd).toBe(0);

    expect((await checkClientBudget(storage.engine(), "uncapped")).allowed).toBe(true);
    expect((await checkClientBudget(storage.engine(), "no-such-client")).allowed).toBe(true);
  });
});

describe("reserve → settle / release", () => {
  // CONTRACT CHANGE: settle no longer writes its own ledger row. Every paid
  // Bedrock call books itself against the calling client now
  // (`runWithSpendClient` wraps the whole dispatch), so a settle that also
  // logged the handler-reported total would charge the same tokens twice.
  // Settle closes the hold and records `actual_cents` on the reservation for
  // the audit trail; the spend itself is already in the log.
  it("holds the estimate, then releases the hold on settle without re-logging", async () => {
    const r = await reserveSpend(storage.engine(), {
      clientId: "capped",
      estimatedUsd: 0.5,
      model: "sonnet",
      provider: "bedrock",
    });
    if (!r.reserved) throw new Error("expected reservation");
    // The hold counts toward today's spend while pending.
    expect(await daySpendUsd(storage.engine(), "capped")).toBeCloseTo(0.5, 6);

    const s = await settleSpend(storage.engine(), r.reservationId, 0.3);
    expect(s.settled).toBe(true);
    // Hold gone, and nothing was double-booked: the paid call's own row is the
    // only record of the spend, and this test never made one.
    expect(await daySpendUsd(storage.engine(), "capped")).toBeCloseTo(0, 6);
    const settled = await storage.engine().query<{ actual_cents: number }>(
      `SELECT actual_cents::float8 AS actual_cents FROM mcp_spend_reservations
        WHERE reservation_id = $1 AND status = 'settled'`,
      [r.reservationId],
    );
    expect(settled.rows[0]?.actual_cents).toBeCloseTo(30, 6);
    // Idempotent: a second settle is a no-op.
    expect((await settleSpend(storage.engine(), r.reservationId, 0.3)).settled).toBe(false);
    expect(await daySpendUsd(storage.engine(), "capped")).toBeCloseTo(0, 6);
  });

  it("rejects a reserve whose estimate would break the cap", async () => {
    await logSpend(storage.engine(), { clientId: "capped", operation: "x", costUsd: 0.8 });
    const r = await reserveSpend(storage.engine(), {
      clientId: "capped",
      estimatedUsd: 0.5,
      model: "sonnet",
      provider: "bedrock",
    });
    expect(r.reserved).toBe(false);
    if (!r.reserved) expect(r.reason).toBe("budget_exhausted");
  });

  it("release frees the hold without spending", async () => {
    const r = await reserveSpend(storage.engine(), {
      clientId: "capped",
      estimatedUsd: 0.5,
      model: "sonnet",
      provider: "bedrock",
    });
    if (!r.reserved) throw new Error("expected reservation");
    await releaseReservation(storage.engine(), r.reservationId);
    expect(await daySpendUsd(storage.engine(), "capped")).toBe(0);
  });

  it("TTL sweep expires stale pending holds", async () => {
    const past = new Date(Date.now() - 10 * 60_000);
    const r = await reserveSpend(storage.engine(), {
      clientId: "capped",
      estimatedUsd: 0.5,
      model: "sonnet",
      provider: "bedrock",
      ttlMs: 1000,
      now: past,
    });
    if (!r.reserved) throw new Error("expected reservation");
    expect(await expireStaleReservations(storage.engine())).toBe(1);
    expect(await daySpendUsd(storage.engine(), "capped")).toBe(0);
  });
});
