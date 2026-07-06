/**
 * Remediation handler wiring — the serve-time registration path.
 *
 * remediation.test.ts covers the handler's dispatch logic in isolation; this
 * file proves the end-to-end path `doctor --remediate` depends on: once
 * `registerRemediationHandlers()` runs (as `serve` now does at worker
 * startup), an enqueued `remediation` job is claimed and executed by the
 * Worker instead of dead-lettering with "no handler registered".
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { _resetHandlersForTesting } from "../src/core/jobs/handlers.ts";
import { registerRemediationHandlers } from "../src/core/jobs/remediation-handlers.ts";
import { REMEDIATION_JOB_KIND } from "../src/core/remediation.ts";

let tmp: string;
let storage: Storage;
let queue: Queue;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-remwire-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
  _resetHandlersForTesting();
});

afterEach(async () => {
  _resetHandlersForTesting();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("remediation worker wiring", () => {
  it("without registration, a remediation job fails with 'no handler registered'", async () => {
    const job = await queue.enqueue({
      kind: REMEDIATION_JOB_KIND,
      payload: { action: "reembed-source", source_id: "s1" },
      maxRetries: 0,
    });
    const worker = new Worker(queue);
    await worker.drainOnce();
    const final = await queue.get(job.id);
    expect(final?.status).toBe("failed");
    expect(final?.lastError).toContain("no handler registered");
  });

  it("after registerRemediationHandlers(), the same job runs end-to-end", async () => {
    const reembedded: string[] = [];
    registerRemediationHandlers({
      reembedSource: async (sourceId) => {
        reembedded.push(sourceId);
        return { chunks: 7 };
      },
    });
    const job = await queue.enqueue({
      kind: REMEDIATION_JOB_KIND,
      payload: { action: "reembed-source", source_id: "s1" },
      maxRetries: 0,
    });
    const worker = new Worker(queue);
    await worker.drainOnce();
    const final = await queue.get(job.id);
    expect(final?.status).toBe("succeeded");
    expect(reembedded).toEqual(["s1"]);
    expect(final?.result).toMatchObject({
      action: "reembed-source",
      source_id: "s1",
      chunks: 7,
    });
  });
});
