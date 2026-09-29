/**
 * Switches for the background work `serve` starts at boot, and a maintenance
 * mode that turns all of it off.
 *
 * A data comparison across an upgrade needs a brain that writes nothing on its
 * own: no boot code sweep, no jobs worker, no cycle, no boot OAuth token sweep.
 * The switches are read from the real environment only (after the legacy-name
 * shim); `runtime_config` can never set them, so a leftover row cannot stop the
 * worker for good or restart work during a maintenance window.
 *
 * Parsing fails closed. An empty value counts as unset, because compose passes
 * every switch as `NAME=` on a normal start. Any value other than `0`/`1` is
 * invalid and lands on the quiet side: maintenance on, a switch off.
 */

export const MAINTENANCE_ENV = "MEMRAIN_MAINTENANCE";
export const BOOT_CODE_SWEEP_ENV = "MEMRAIN_BOOT_CODE_SWEEP";
export const JOBS_WORKER_ENV = "MEMRAIN_JOBS_WORKER";
export const CYCLE_ENV = "MEMRAIN_CYCLE";

export interface Quiescence {
  /** Maintenance mode: every switch below is off and the boot token sweep is skipped. */
  maintenance: boolean;
  bootCodeSweep: boolean;
  jobsWorker: boolean;
  cycle: boolean;
  /** Switch names whose value was neither empty, `0` nor `1`. */
  invalid: string[];
}

type Parsed = { on: boolean; invalid: boolean };

function parseSwitch(raw: string | undefined, unset: boolean, invalid: boolean): Parsed {
  if (raw === undefined || raw === "") return { on: unset, invalid: false };
  if (raw === "1") return { on: true, invalid: false };
  if (raw === "0") return { on: false, invalid: false };
  return { on: invalid, invalid: true };
}

export function resolveQuiescence(
  env: Record<string, string | undefined> = process.env,
): Quiescence {
  const invalid: string[] = [];
  const read = (name: string, unset: boolean, onInvalid: boolean): boolean => {
    const p = parseSwitch(env[name], unset, onInvalid);
    if (p.invalid) invalid.push(name);
    return p.on;
  };
  const maintenance = read(MAINTENANCE_ENV, false, true);
  const bootCodeSweep = read(BOOT_CODE_SWEEP_ENV, true, false);
  const jobsWorker = read(JOBS_WORKER_ENV, true, false);
  const cycle = read(CYCLE_ENV, true, false);
  return {
    maintenance,
    bootCodeSweep: bootCodeSweep && !maintenance,
    jobsWorker: jobsWorker && !maintenance,
    cycle: cycle && !maintenance,
    invalid,
  };
}

/** True when nothing started at boot can write on its own. */
export function isQuiet(q: Quiescence): boolean {
  return q.maintenance || (!q.bootCodeSweep && !q.jobsWorker && !q.cycle);
}

const onOff = (b: boolean): string => (b ? "on" : "off");

/**
 * The serve boot lines, names and states only: one per invalid switch, then
 * the state line whenever anything is off.
 */
export function quiescenceBootLines(q: Quiescence): string[] {
  const lines = q.invalid.map(
    (name) =>
      `[memrain] invalid quiescence switch ${name}; treated as ${name === MAINTENANCE_ENV ? "on" : "off"}`,
  );
  if (q.maintenance || !q.bootCodeSweep || !q.jobsWorker || !q.cycle) {
    lines.push(
      `[memrain] maintenance=${onOff(q.maintenance)} code_sweep=${onOff(q.bootCodeSweep)} ` +
        `jobs_worker=${onOff(q.jobsWorker)} cycle=${onOff(q.cycle)}`,
    );
  }
  return lines;
}
