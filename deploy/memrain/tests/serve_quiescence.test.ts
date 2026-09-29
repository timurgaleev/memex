/**
 * serve's boot work under the quiescence switches: in maintenance nothing that
 * writes on its own starts (code source registration and sweep, jobs worker,
 * cycle loop, boot OAuth token sweep), even with code roots and a cycle
 * interval configured. Each switch alone disables only its own target. The
 * controls prove the spies and the pending-job check are not vacuous.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { loadConfig } from "../src/core/config.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import {
  BOOT_CODE_SWEEP_ENV,
  CYCLE_ENV,
  JOBS_WORKER_ENV,
  MAINTENANCE_ENV,
  resolveQuiescence,
} from "../src/core/quiescence.ts";
import {
  bootTokenSweep,
  startBackgroundWork,
  type BackgroundDeps,
} from "../src/commands/serve.ts";
import type { Worker } from "../src/core/jobs/worker.ts";

type Config = ReturnType<typeof loadConfig>;

const ENV_KEYS = ["MEMEX_CODE_PATHS", "MEMEX_DREAM_INTERVAL_S"] as const;
const saved = new Map<string, string | undefined>();
let dir: string;
let storage: Storage;
const config = {} as Config;

function spies(workerIntervalMs = 20) {
  const deps = {
    registerSource: mock(async () => {}),
    sweepCodeRoots: mock(async () => ({
      scanned: 0,
      reindexed: 0,
      skipped: 0,
      parseErrors: 0,
      errors: [],
      perRoot: [],
    })),
    startCycleLoop: mock(() => ({ stop: async () => {} })),
    startWorker: mock((_w: Worker) => {}),
    workerIntervalMs,
  };
  return deps;
}

async function boot(env: Record<string, string>, deps: ReturnType<typeof spies>) {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    const r = startBackgroundWork(
      storage,
      config,
      resolveQuiescence(env),
      deps as unknown as BackgroundDeps,
    );
    // Let the fire-and-forget code sweep reach its call.
    await new Promise((res) => setTimeout(res, 10));
    return r;
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  dir = mkdtempSync(join(tmpdir(), "memex-serve-quiescence-"));
  process.env.MEMEX_CODE_PATHS = dir;
  process.env.MEMEX_DREAM_INTERVAL_S = "60";
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("startBackgroundWork", () => {
  it("control: with every switch on, all boot work starts", async () => {
    const deps = spies();
    const { worker } = await boot({}, deps);
    await worker.stop();
    expect(deps.registerSource).toHaveBeenCalledTimes(1);
    expect(deps.sweepCodeRoots).toHaveBeenCalledTimes(1);
    expect(deps.startWorker).toHaveBeenCalledTimes(1);
    expect(deps.startCycleLoop).toHaveBeenCalledTimes(1);
  });

  it("maintenance starts nothing, even with code roots and a cycle interval set", async () => {
    const deps = spies();
    const { worker, cycle } = await boot({ [MAINTENANCE_ENV]: "1" }, deps);
    await worker.stop();
    expect(cycle).toBeNull();
    expect(deps.registerSource).not.toHaveBeenCalled();
    expect(deps.sweepCodeRoots).not.toHaveBeenCalled();
    expect(deps.startWorker).not.toHaveBeenCalled();
    expect(deps.startCycleLoop).not.toHaveBeenCalled();
  });

  const cases: Array<[string, Array<keyof ReturnType<typeof spies>>]> = [
    [BOOT_CODE_SWEEP_ENV, ["registerSource", "sweepCodeRoots"]],
    [JOBS_WORKER_ENV, ["startWorker"]],
    [CYCLE_ENV, ["startCycleLoop"]],
  ];
  for (const [name, targets] of cases) {
    it(`${name}=0 disables only ${targets.join(" + ")}`, async () => {
      const deps = spies();
      const { worker } = await boot({ [name]: "0" }, deps);
      await worker.stop();
      for (const fn of ["registerSource", "sweepCodeRoots", "startWorker", "startCycleLoop"] as const) {
        if (targets.includes(fn)) expect(deps[fn]).not.toHaveBeenCalled();
        else expect(deps[fn]).toHaveBeenCalledTimes(1);
      }
    });
  }

  it("a submitted job stays pending for 3 worker intervals in maintenance; control drains it", async () => {
    const interval = 20;
    const queue = new Queue(storage.engine());
    const statusOf = async (id: string) =>
      (await storage.engine().query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [id]))
        .rows[0]?.status;

    const quiet = { ...spies(interval), startWorker: (w: Worker) => w.start() };
    const held = await boot({ [MAINTENANCE_ENV]: "1" }, quiet as ReturnType<typeof spies>);
    const job = await queue.enqueue({ kind: "quiescence_probe", maxRetries: 0 });
    await new Promise((res) => setTimeout(res, interval * 3 + 100));
    await held.worker.stop();
    expect(await statusOf(job.id)).toBe("pending");

    const live = { ...spies(interval), startWorker: (w: Worker) => w.start() };
    const running = await boot({}, live as ReturnType<typeof spies>);
    const deadline = Date.now() + 5000;
    while ((await statusOf(job.id)) === "pending" && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, interval));
    }
    await running.worker.stop();
    expect(await statusOf(job.id)).not.toBe("pending");
  });
});

describe("bootTokenSweep", () => {
  const past = () => Math.floor(Date.now() / 1000) - 3600;

  async function seedExpired(hash: string): Promise<void> {
    const e = storage.engine();
    await e.query(
      `INSERT INTO oauth_clients (client_id, client_name) VALUES ($1, 'c') ON CONFLICT DO NOTHING`,
      ["cl-quiescence"],
    );
    await e.query(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, expires_at)
       VALUES ($1, 'access', 'cl-quiescence', $2)`,
      [hash, past()],
    );
  }

  const present = async (hash: string) =>
    (await storage.engine().query(`SELECT 1 FROM oauth_tokens WHERE token_hash = $1`, [hash]))
      .rows.length === 1;

  it("maintenance never calls the sweep and the expired row survives", async () => {
    await seedExpired("tok-maint");
    const provider = new OAuthProvider({ engine: storage.raw() });
    const sweep = mock(() => provider.sweepExpiredTokens());
    await bootTokenSweep({ sweepExpiredTokens: sweep }, resolveQuiescence({ [MAINTENANCE_ENV]: "1" }));
    expect(sweep).not.toHaveBeenCalled();
    expect(await present("tok-maint")).toBe(true);
  });

  it("control: without maintenance the same row is swept", async () => {
    const provider = new OAuthProvider({ engine: storage.raw() });
    const err = console.error;
    console.error = () => {};
    try {
      await bootTokenSweep(provider, resolveQuiescence({}));
    } finally {
      console.error = err;
    }
    expect(await present("tok-maint")).toBe(false);
  });
});
