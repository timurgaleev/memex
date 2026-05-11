/**
 * `memex gmail poll [--max N] [--since H] [--dry-run]` — manually
 * trigger one Gmail poll. Production polling runs via the durable
 * jobs queue (`gmail.poll` kind). This command is for ops, smoke
 * tests, and dry-runs.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { pollGmail } from "../recipes/gmail.ts";

export interface GmailCommandOptions {
  sub: "poll";
  max?: number;
  sinceHours?: number;
  dryRun?: boolean;
}

export async function runGmail(opts: GmailCommandOptions): Promise<void> {
  if (opts.sub !== "poll") {
    throw new Error(`runGmail: unsupported subcommand '${opts.sub}'`);
  }
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const pollOpts: Parameters<typeof pollGmail>[1] = {};
    if (opts.max !== undefined) pollOpts.maxMessages = opts.max;
    if (opts.sinceHours !== undefined) pollOpts.sinceHours = opts.sinceHours;
    if (opts.dryRun) pollOpts.dryRun = true;
    const r = await pollGmail(storage, pollOpts);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await storage.close();
  }
}
