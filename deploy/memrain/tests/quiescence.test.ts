/**
 * Quiescence switches: the resolver table, fail-closed parsing (an empty value
 * is unset, anything else unknown lands on the quiet side), the legacy name
 * through the env shim, and that runtime_config can never set a switch.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_CODE_SWEEP_ENV,
  CYCLE_ENV,
  JOBS_WORKER_ENV,
  MAINTENANCE_ENV,
  isQuiet,
  quiescenceBootLines,
  resolveQuiescence,
} from "../src/core/quiescence.ts";
import { mapLegacyEnv } from "../src/core/env-compat.ts";
import { Storage } from "../src/core/storage.ts";
import {
  applyRuntimeEnvOverlay,
  ENV_ONLY_KEYS,
  setRuntimeConfig,
} from "../src/core/runtime-config.ts";
import { putRuntimeConfigRow } from "./helpers/runtime-config-row.ts";

const SWITCHES = [BOOT_CODE_SWEEP_ENV, JOBS_WORKER_ENV, CYCLE_ENV] as const;
const FIELD = {
  [BOOT_CODE_SWEEP_ENV]: "bootCodeSweep",
  [JOBS_WORKER_ENV]: "jobsWorker",
  [CYCLE_ENV]: "cycle",
} as const;

describe("resolveQuiescence", () => {
  it("unset: maintenance off, every switch on", () => {
    expect(resolveQuiescence({})).toEqual({
      maintenance: false,
      bootCodeSweep: true,
      jobsWorker: true,
      cycle: true,
      invalid: [],
    });
  });

  it("maintenance=1 forces every switch off, whatever they say", () => {
    const q = resolveQuiescence({
      [MAINTENANCE_ENV]: "1",
      [BOOT_CODE_SWEEP_ENV]: "1",
      [JOBS_WORKER_ENV]: "1",
      [CYCLE_ENV]: "1",
    });
    expect(q).toEqual({
      maintenance: true,
      bootCodeSweep: false,
      jobsWorker: false,
      cycle: false,
      invalid: [],
    });
    expect(isQuiet(q)).toBe(true);
  });

  it("maintenance=0 is off", () => {
    expect(resolveQuiescence({ [MAINTENANCE_ENV]: "0" }).maintenance).toBe(false);
  });

  for (const name of SWITCHES) {
    it(`${name}=0 turns off only its own target`, () => {
      const q = resolveQuiescence({ [name]: "0" });
      expect(q.maintenance).toBe(false);
      for (const other of SWITCHES) {
        expect(q[FIELD[other]]).toBe(other !== name);
      }
      expect(q.invalid).toEqual([]);
      expect(isQuiet(q)).toBe(false);
    });

    it(`${name}=1 is on`, () => {
      expect(resolveQuiescence({ [name]: "1" })[FIELD[name]]).toBe(true);
    });
  }

  it("all three switches off without maintenance is quiet", () => {
    const q = resolveQuiescence({
      [BOOT_CODE_SWEEP_ENV]: "0",
      [JOBS_WORKER_ENV]: "0",
      [CYCLE_ENV]: "0",
    });
    expect(q.maintenance).toBe(false);
    expect(isQuiet(q)).toBe(true);
  });

  for (const bad of ["true", "yes", "2", " 1", "on", "1 "]) {
    it(`invalid maintenance value ${JSON.stringify(bad)} counts as on`, () => {
      const q = resolveQuiescence({ [MAINTENANCE_ENV]: bad });
      expect(q.maintenance).toBe(true);
      expect(q.bootCodeSweep).toBe(false);
      expect(q.jobsWorker).toBe(false);
      expect(q.cycle).toBe(false);
      expect(q.invalid).toEqual([MAINTENANCE_ENV]);
    });

    for (const name of SWITCHES) {
      it(`invalid ${name} value ${JSON.stringify(bad)} counts as off`, () => {
        const q = resolveQuiescence({ [name]: bad });
        expect(q[FIELD[name]]).toBe(false);
        expect(q.maintenance).toBe(false);
        expect(q.invalid).toEqual([name]);
      });
    }
  }

  it("an empty value (NAME= as compose passes it) is unset, not invalid", () => {
    const q = resolveQuiescence({
      [MAINTENANCE_ENV]: "",
      [BOOT_CODE_SWEEP_ENV]: "",
      [JOBS_WORKER_ENV]: "",
      [CYCLE_ENV]: "",
    });
    expect(q).toEqual({
      maintenance: false,
      bootCodeSweep: true,
      jobsWorker: true,
      cycle: true,
      invalid: [],
    });
    expect(quiescenceBootLines(q)).toEqual([]);
  });

  it("the legacy MEMEX_MAINTENANCE=1 works through the env shim", () => {
    const env: Record<string, string | undefined> = { MEMEX_MAINTENANCE: "1" };
    mapLegacyEnv(env);
    expect(resolveQuiescence(env).maintenance).toBe(true);
  });

  it("reads the real environment by default", () => {
    const saved = process.env[MAINTENANCE_ENV];
    process.env[MAINTENANCE_ENV] = "1";
    try {
      expect(resolveQuiescence().maintenance).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[MAINTENANCE_ENV];
      else process.env[MAINTENANCE_ENV] = saved;
    }
  });
});

describe("quiescenceBootLines", () => {
  it("prints nothing when everything is on", () => {
    expect(quiescenceBootLines(resolveQuiescence({}))).toEqual([]);
  });

  it("lists the states whenever anything is off", () => {
    expect(quiescenceBootLines(resolveQuiescence({ [MAINTENANCE_ENV]: "1" }))).toEqual([
      "[memrain] maintenance=on code_sweep=off jobs_worker=off cycle=off",
    ]);
    expect(quiescenceBootLines(resolveQuiescence({ [CYCLE_ENV]: "0" }))).toEqual([
      "[memrain] maintenance=off code_sweep=on jobs_worker=on cycle=off",
    ]);
  });

  it("names an invalid switch and the state it was treated as, never its value", () => {
    const lines = quiescenceBootLines(
      resolveQuiescence({ [MAINTENANCE_ENV]: "secretish", [JOBS_WORKER_ENV]: "nope" }),
    );
    expect(lines).toContain(`[memrain] invalid quiescence switch ${MAINTENANCE_ENV}; treated as on`);
    expect(lines).toContain(`[memrain] invalid quiescence switch ${JOBS_WORKER_ENV}; treated as off`);
    expect(lines.join("\n")).not.toContain("secretish");
    expect(lines.join("\n")).not.toContain("nope");
  });
});

describe("runtime_config cannot set a switch", () => {
  let dir: string;
  let storage: Storage;
  const keys = [MAINTENANCE_ENV, ...SWITCHES, "MEMRAIN_REQUIRE_POSTGRES"];
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const k of keys) {
      for (const name of [k, k.replace(/^MEMRAIN_/, "MEMEX_")]) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
    }
    dir = mkdtempSync(join(tmpdir(), "memex-quiescence-"));
    storage = new Storage({ dbPath: dir });
    await storage.init();
  });

  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [name, v] of saved) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });

  it("the overlay denylist covers all four switches and the Postgres guard", () => {
    for (const k of keys) expect(ENV_ONLY_KEYS.has(k)).toBe(true);
  });

  it("skips rows for every switch under both prefixes and logs each by name", async () => {
    const e = storage.engine();
    const rows = keys.flatMap((k) => [k, k.replace(/^MEMRAIN_/, "MEMEX_")]);
    // A MEMRAIN_ row shadows its MEMEX_ twin, so seed the legacy ones on a
    // second pass to see both spellings refused.
    for (const k of keys) await putRuntimeConfigRow(e, k.replace(/^MEMRAIN_/, "MEMEX_"), "0");
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    try {
      expect(await applyRuntimeEnvOverlay(e)).toEqual([]);
      for (const k of keys) await setRuntimeConfig(e, k, "0");
      expect(await applyRuntimeEnvOverlay(e)).toEqual([]);
    } finally {
      console.error = orig;
    }
    for (const name of rows) {
      expect(process.env[name]).toBeUndefined();
      expect(errs.some((l) => l.includes(`runtime_config ${name} ignored`))).toBe(true);
    }
    expect(resolveQuiescence()).toEqual(resolveQuiescence({}));
  });
});
