/**
 * Ops-facing doctor probes (core/doctor-ops.ts): stale cycle locks, job queue
 * depth/wedge, applied-vs-available schema version, embedding-width drift.
 * PGLite in-process store; substrate tables come from the migrations run by
 * storage.init().
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  checkStaleLocks,
  checkQueueHealth,
  checkSchemaVersion,
  checkEmbeddingWidth,
  checkInvalidIndexes,
  checkDuplicatePages,
} from "../src/core/doctor-ops.ts";
import { buildRemediationEnvelope, runDoctor } from "../src/commands/doctor.ts";
import { buildRemediationPlan } from "../src/core/remediation.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-doctor-ops-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("checkStaleLocks", () => {
  it("reports none on a clean store", async () => {
    const r = await checkStaleLocks(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no stale");
  });

  it("counts a lock past its TTL", async () => {
    await storage.engine().exec(
      `INSERT INTO cycle_locks (id, holder_pid, ttl_expires_at)
       VALUES ('cycle:test', 123, NOW() - INTERVAL '1 hour')`,
    );
    const r = await checkStaleLocks(storage.engine());
    expect(r.ok).toBe(true); // informational — reclaimed on next acquire
    expect(r.detail).toContain("1 cycle lock");
  });
});

describe("checkQueueHealth", () => {
  it("reports empty on a clean store", async () => {
    const r = await checkQueueHealth(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("pending=0");
  });

  it("counts pending and flags a wedged running job", async () => {
    await storage.engine().exec(
      `INSERT INTO jobs (id, kind, status) VALUES ('j1', 'embed', 'pending')`,
    );
    await storage.engine().exec(
      `INSERT INTO jobs (id, kind, status, started_at)
       VALUES ('j2', 'embed', 'running', NOW() - INTERVAL '2 hours')`,
    );
    const r = await checkQueueHealth(storage.engine());
    expect(r.detail).toContain("pending=1");
    expect(r.ok).toBe(false); // j2 wedged past the 1h default threshold
    expect(r.detail).toContain("wedged");
  });
});

describe("checkSchemaVersion", () => {
  it("is up to date on a freshly migrated store", async () => {
    const r = await checkSchemaVersion(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("up to date");
  });

  it("points the pending-migration hint at a verb the CLI actually dispatches", async () => {
    // Drop the top applied row so `available` outruns `applied` and the hint
    // branch fires.
    await storage
      .engine()
      .exec("DELETE FROM migrations WHERE id = (SELECT MAX(id) FROM migrations)");
    const r = await checkSchemaVersion(storage.engine());
    expect(r.ok).toBe(false);

    const verb = /run `memex ([a-z-]+)`/.exec(r.detail)?.[1];
    expect(verb).toBeDefined();
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
    expect(cli).toContain(`case "${verb}":`);
  });
});

describe("checkEmbeddingWidth", () => {
  it("reports no embeddings on a fresh store", async () => {
    const r = await checkEmbeddingWidth(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no embeddings");
  });
});

describe("checkInvalidIndexes", () => {
  it("reports all valid on a freshly-migrated store", async () => {
    const r = await checkInvalidIndexes(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("all indexes valid");
  });

  it("flips ok:false when an index is marked indisvalid=false", async () => {
    // Simulate a failed/interrupted build: build a throwaway index, then flip
    // its pg_index.indisvalid to false (what an aborted CONCURRENTLY leaves).
    const e = storage.engine();
    await e.exec(
      "CREATE INDEX IF NOT EXISTS doctor_test_idx ON documents(source_path)",
    );
    await e.exec(
      "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'doctor_test_idx'::regclass",
    );
    const r = await checkInvalidIndexes(e);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("doctor_test_idx");
  });
});

describe("checkDuplicatePages", () => {
  const insertPage = (slug: string, hash: string) =>
    storage.engine().exec(
      `INSERT INTO pages (slug, type, content_hash) VALUES ('${slug}', 'note', '${hash}')`,
    );

  it("reports none on a clean store", async () => {
    const r = await checkDuplicatePages(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no duplicate pages");
  });

  it("groups two live pages sharing source_id + content_hash", async () => {
    await insertPage("notes/a", "hash-dup");
    await insertPage("notes/b", "hash-dup");
    const r = await checkDuplicatePages(storage.engine());
    expect(r.ok).toBe(true); // informational — retrieval still works
    expect(r.detail).toContain("1 duplicate page group");
    expect(r.detail).toContain("notes/a, notes/b");
  });

  it("ignores distinct hashes and soft-deleted twins", async () => {
    await insertPage("notes/a", "hash-one");
    await insertPage("notes/b", "hash-two");
    await insertPage("notes/c", "hash-two");
    await storage
      .engine()
      .exec("UPDATE pages SET deleted_at = NOW() WHERE slug = 'notes/c'");
    const r = await checkDuplicatePages(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no duplicate pages");
  });
});

describe("buildRemediationEnvelope", () => {
  it("stays green when every check passed and the plan is empty", () => {
    const checks = [
      { name: "config", ok: true },
      { name: "schema-version", ok: true },
    ];
    const env = buildRemediationEnvelope(
      buildRemediationPlan({ signals: checks.map((c) => ({ check: c.name, ok: c.ok })) }),
      checks,
    );
    expect(env.ok).toBe(true);
    expect(env.failing_checks).toBeUndefined();
  });

  it("cannot report an all-clear for a failing check the classifier has no action for", () => {
    // schema-version is not one of the check names classifyRemediation acts on,
    // so the plan comes back empty even though the brain is unhealthy.
    const checks = [
      { name: "config", ok: true },
      { name: "schema-version", ok: false },
    ];
    const plan = buildRemediationPlan({
      signals: checks.map((c) => ({ check: c.name, ok: c.ok })),
    });
    expect(plan.actions).toHaveLength(0);

    const env = buildRemediationEnvelope(plan, checks);
    expect(env.ok).toBe(false);
    expect(env.failing_checks).toEqual(["schema-version"]);
  });

  it("names every failing check, not just the first", () => {
    const checks = [
      { name: "pglite", ok: false },
      { name: "queue-health", ok: false },
      { name: "eval-trend", ok: true },
    ];
    const env = buildRemediationEnvelope(
      buildRemediationPlan({ signals: checks.map((c) => ({ check: c.name, ok: c.ok })) }),
      checks,
    );
    expect(env.ok).toBe(false);
    expect(env.failing_checks).toEqual(["pglite", "queue-health"]);
  });
});

/** The emitted `--remediate` envelope plus the exit code the run left behind. */
interface RemediateRun {
  emitted: {
    ok: boolean;
    submitted: boolean;
    mode: string;
    dry_run?: boolean;
    plan: { ok: boolean; failing_checks?: string[] };
  };
  exitCode: number | undefined;
}

/**
 * Drive the real `runDoctor` against a throwaway brain and capture what it
 * printed. Asserting on the envelope builder alone is what let the top-level
 * `ok` and the exit code drift from the plan's verdict, so the contract is
 * pinned on what a monitoring wrapper actually sees.
 */
async function runRemediate(dir: string, breakVault: boolean): Promise<RemediateRun> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "brain.pglite");
  const cfgPath = join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: dbPath },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      // An unreadable vault reds the `vault` check while the engine underneath
      // stays perfectly healthy — the case that used to report a green brain.
      storage: breakVault ? { vault: join(dir, "no-such-vault") } : {},
    }),
  );

  // os.homedir() caches at process start in Bun, so the config path is passed
  // explicitly; the vault env is cleared so the config's own value decides.
  const prevVault = process.env.MEMEX_VAULT_PATH;
  delete process.env.MEMEX_VAULT_PATH;
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  let exitCode: number | undefined;
  try {
    await runDoctor({ configPath: cfgPath, argv: ["--remediate"] });
    exitCode = process.exitCode;
  } finally {
    console.log = origLog;
    process.exitCode = prevExit;
    if (prevVault !== undefined) process.env.MEMEX_VAULT_PATH = prevVault;
  }
  return { emitted: JSON.parse(captured.join("\n")), exitCode };
}

describe("doctor --remediate envelope", () => {
  it("reports ok and exits zero on a healthy brain", async () => {
    const { emitted, exitCode } = await runRemediate(join(tmp, "healthy"), false);
    expect(emitted.mode).toBe("remediate");
    expect(emitted.submitted).toBe(true);
    expect(emitted.dry_run).toBe(true); // no --execute / --yes
    expect(emitted.ok).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("exits non-zero and reports ok:false when a check failed, while still saying the submission ran", async () => {
    const { emitted, exitCode } = await runRemediate(join(tmp, "broken"), true);
    expect(emitted.plan.failing_checks).toContain("vault");
    // The brain is not healthy, and a cron probe reads the exit code…
    expect(emitted.ok).toBe(false);
    expect(exitCode).toBe(1);
    // …while the submission itself ran fine, and that stays visible.
    expect(emitted.submitted).toBe(true);
  });
});
