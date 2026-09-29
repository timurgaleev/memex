/**
 * Migration-runner retry on transient failures. A migration that trips a
 * statement_timeout (57014) or a connection reset is retried up to 3 times;
 * the whole transaction rolls back between attempts, so nothing is
 * half-recorded. A non-retryable error fails fast on the first attempt. On
 * exhaustion the runner throws `MigrationRetryExhausted`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  getIdleBlockers,
  MigrationRetryExhausted,
  runMigrations,
} from "../src/core/migrate.ts";

function tmpMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memex-mig-"));
  writeFileSync(join(dir, "001_test.sql"), "SELECT 1;");
  return dir;
}

const timeoutErr = () =>
  Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });

// A fake engine whose `transaction()` replays a scripted list of outcomes,
// one per call ("timeout" | "boom" | "ok"), so the retry loop is exercised
// deterministically. Everything else is a no-op returning empty rows.
function fakeEngine(outcomes: string[]) {
  let calls = 0;
  const engine = {
    kind: "pglite",
    async exec() {},
    async query() {
      return { rows: [] as unknown[] };
    },
    async transaction(fn: (tx: Engine) => Promise<unknown>) {
      const outcome = outcomes[calls++] ?? "ok";
      if (outcome === "timeout") throw timeoutErr();
      if (outcome === "boom") throw new Error("syntax error at or near");
      return fn({
        exec: async () => {},
        query: async () => ({ rows: [] }),
      } as unknown as Engine);
    },
    get calls() {
      return calls;
    },
  };
  return engine;
}

describe("migration runner retry", () => {
  beforeAll(() => {
    process.env.MEMEX_MIGRATE_BACKOFF_MS = "0";
  });
  afterAll(() => {
    delete process.env.MEMEX_MIGRATE_BACKOFF_MS;
  });

  test("retries a transient statement_timeout and then succeeds", async () => {
    const dir = tmpMigrationsDir();
    const engine = fakeEngine(["timeout", "ok"]);
    const res = await runMigrations(engine as unknown as Engine, dir);
    expect(res.applied).toHaveLength(1);
    expect(engine.calls).toBe(2); // one failure + one success
  });

  test("throws MigrationRetryExhausted after 3 timeouts", async () => {
    const dir = tmpMigrationsDir();
    const engine = fakeEngine(["timeout", "timeout", "timeout"]);
    let thrown: unknown;
    try {
      await runMigrations(engine as unknown as Engine, dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MigrationRetryExhausted);
    expect(engine.calls).toBe(3);
  });

  test("a non-retryable error fails fast on the first attempt", async () => {
    const dir = tmpMigrationsDir();
    const engine = fakeEngine(["boom"]);
    let thrown: unknown;
    try {
      await runMigrations(engine as unknown as Engine, dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(MigrationRetryExhausted);
    expect(engine.calls).toBe(1); // no retry
  });

  test("getIdleBlockers returns [] on a non-postgres engine", async () => {
    const engine = fakeEngine([]);
    expect(await getIdleBlockers(engine as unknown as Engine)).toEqual([]);
  });
});
