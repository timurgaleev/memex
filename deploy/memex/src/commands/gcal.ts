/**
 * `memex gcal poll [--horizon-days N] [--max N] [--dry-run]` —
 * manually trigger one Google Calendar poll. Production polling runs
 * via the durable jobs queue (`gcal.poll` kind). This command is for
 * ops, smoke tests, and dry-runs.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { pollGcal } from "../recipes/gcal.ts";

export interface GcalCommandOptions {
  sub: "poll";
  horizonDays?: number;
  max?: number;
  dryRun?: boolean;
}

export async function runGcal(opts: GcalCommandOptions): Promise<void> {
  if (opts.sub !== "poll") {
    throw new Error(`runGcal: unsupported subcommand '${opts.sub}'`);
  }
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const pollOpts: Parameters<typeof pollGcal>[1] = {};
    if (opts.horizonDays !== undefined) pollOpts.horizonDays = opts.horizonDays;
    if (opts.max !== undefined) pollOpts.maxEvents = opts.max;
    if (opts.dryRun) pollOpts.dryRun = true;
    const r = await pollGcal(storage, pollOpts);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await storage.close();
  }
}
