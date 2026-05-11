/**
 * `memex reconcile-links` — find broken `[[wikilinks]]`.
 *
 * Read-only. Prints a JSON report. doesn't auto-rewrite the
 * source files; that's a one-line follow-up command (`reconcile-links
 * --apply`) we can ship later when we're confident in the resolver
 * registry. For now, surface the data so humans can fix.
 */
import { Storage } from "../core/storage.ts";
import { reconcileLinksPhase } from "../core/cycle/reconcile-links.ts";
import { loadConfig } from "../core/config.ts";

export interface ReconcileLinksCmdOptions {
  /** Cap on unresolved entries returned. Default 100. */
  reportLimit?: number;
}

export async function runReconcileLinks(
  opts: ReconcileLinksCmdOptions = {},
): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const phaseOpts: Parameters<typeof reconcileLinksPhase>[1] = {};
    if (opts.reportLimit !== undefined) phaseOpts.reportLimit = opts.reportLimit;
    const r = await reconcileLinksPhase(storage.engine(), phaseOpts);
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  } finally {
    await storage.close();
  }
}
