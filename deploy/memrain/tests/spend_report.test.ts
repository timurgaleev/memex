/**
 * The spend report rolls the ledger up by model, feature and spender, and
 * names the calls its totals cannot see.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { spendReport } from "../src/core/spend-report.ts";

let tmp: string;
let storage: Storage;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-spend-report-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function row(op: string, model: string, client: string | null, cents: number | null, tokens: number | null, ageDays = 0) {
  await storage.engine().query(
    `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, model, input_tokens, output_tokens, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval)`,
    [client, op, cents, model, tokens, tokens === null ? null : 0, String(ageDays)],
  );
}

describe("spendReport", () => {
  it("groups the window by model, feature and spender", async () => {
    await row("embedding", "titan", null, 10, 100);
    await row("embedding", "titan", "alice", 30, 300);
    await row("think", "sonnet", "alice", 200, 1000);
    await row("think", "sonnet", "alice", 999, 1000, 30); // outside the window
    const r = await spendReport(storage.engine(), { days: 7 });
    expect(r.calls).toBe(3);
    expect(r.total_usd).toBeCloseTo(2.4, 9);
    expect(r.by_model.map((g) => [g.key, g.calls, g.usd])).toEqual([
      ["sonnet", 1, 2],
      ["titan", 2, 0.4],
    ]);
    expect(r.by_operation[0]).toMatchObject({ key: "think", input_tokens: 1000 });
    expect(r.by_client.map((g) => g.key)).toEqual(["alice", null]);
  });

  it("names what the totals cannot see", async () => {
    await row("think", "unpriced-model", "bob", null, 50);
    await row("think", "sonnet", "bob", 0, null);
    await row("think", "sonnet", "bob", 40, null); // booked before tokens were kept
    const r = await spendReport(storage.engine(), { days: 1 });
    expect(r.coverage).toEqual({
      unpriced_calls: 1,
      unpriced_models: ["unpriced-model"],
      no_usage_calls: 1,
      tokens_unrecorded_calls: 1,
    });
    expect(r.total_usd).toBeCloseTo(0.4, 9);
  });

  it("refuses a window it cannot mean", async () => {
    await expect(spendReport(storage.engine(), { days: 0 })).rejects.toThrow("days");
    await expect(spendReport(storage.engine(), { days: 1.5 })).rejects.toThrow("days");
  });
});
