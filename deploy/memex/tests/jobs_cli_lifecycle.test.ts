/**
 * `memex jobs submit|progress|remove|prune|smoke` — the CLI wiring over the
 * core lifecycle surface (core/jobs/lifecycle.ts + Queue.prune/remove).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJobs } from "../src/commands/jobs.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-jobs-cli-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => (console.log = orig) };
}

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function run(opts: Parameters<typeof runJobs>[0]): Promise<Record<string, unknown>> {
  const cap = capture();
  const prevExit = process.exitCode;
  try {
    await runJobs({ ...opts, configPath: cfgPath });
  } finally {
    cap.restore();
    process.exitCode = prevExit;
  }
  return JSON.parse(cap.lines.join("\n")) as Record<string, unknown>;
}

describe("memex jobs lifecycle CLI", () => {
  it("submit validates the kind and enqueues", async () => {
    await expect(
      run({ sub: "submit", kind: "Bad Kind!" }),
    ).rejects.toThrow(/invalid kind/);
    const out = await run({
      sub: "submit",
      kind: "test.noop",
      id: "job-cli-1",
      priority: 2,
      maxRetries: 0,
      payload: { a: 1 },
    });
    expect(out.ok).toBe(true);
    const job = out.job as { id: string; kind: string; status: string; payload: unknown };
    expect(job.id).toBe("job-cli-1");
    expect(job.kind).toBe("test.noop");
    expect(job.status).toBe("pending");
  });

  it("progress reads the envelope; remove refuses a live row", async () => {
    const p = await run({ sub: "progress", id: "job-cli-1" });
    expect(p.ok).toBe(true);
    expect(p.status).toBe("pending");
    const r = await run({ sub: "remove", id: "job-cli-1" });
    expect(r.ok).toBe(false); // pending → not removable
  });

  it("remove deletes a terminal row after cancel", async () => {
    await run({ sub: "cancel", id: "job-cli-1" });
    const r = await run({ sub: "remove", id: "job-cli-1" });
    expect(r.ok).toBe(true);
    const gone = await run({ sub: "progress", id: "job-cli-1" });
    expect(gone.ok).toBe(false);
  });

  it("prune deletes old terminal rows only", async () => {
    await run({ sub: "submit", kind: "test.noop", id: "job-cli-2", maxRetries: 0 });
    await run({ sub: "cancel", id: "job-cli-2" });
    // Age floor in the future-ward direction: olderThanDays 0 → cutoff now →
    // the just-cancelled row qualifies.
    const pruned = await run({ sub: "prune", olderThanDays: 0 });
    expect(pruned.ok).toBe(true);
    expect(pruned.pruned as number).toBeGreaterThanOrEqual(1);
  });

  it("smoke round-trips a noop job through the real worker path", async () => {
    const out = await run({ sub: "smoke" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("succeeded");
  });
});
