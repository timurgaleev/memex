/**
 * `memex page-retype` — correct the type of many pages at once.
 *
 * Preview is the default: without `--apply` this prints what would move and
 * changes nothing. The refusals live in core/page-retype.ts and are evaluated
 * against the matched rows, so a preview shows the same refusal an apply would
 * hit rather than discovering it later.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { planRetype, applyRetype, type RetypeSelector } from "../core/page-retype.ts";

export interface PageRetypeCmdOptions {
  to: string;
  from?: string;
  slugs?: string[];
  pathPrefix?: string;
  sourceId?: string;
  apply?: boolean;
  json?: boolean;
}

export async function runPageRetype(opts: PageRetypeCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig());
  await storage.init();
  try {
    const sel: RetypeSelector = {};
    if (opts.from !== undefined) sel.from = opts.from;
    if (opts.slugs !== undefined) sel.slugs = opts.slugs;
    if (opts.pathPrefix !== undefined) sel.pathPrefix = opts.pathPrefix;
    if (opts.sourceId !== undefined) sel.sourceId = opts.sourceId;

    const plan = await planRetype(storage.engine(), opts.to, sel);
    if (plan.refusal !== null) {
      console.error(plan.refusal);
      return 1;
    }
    if (!opts.apply) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dry_run: true,
            to: plan.to,
            matched: plan.matches.length,
            by_type: plan.byType,
            sample: plan.matches.slice(0, 20).map((m) => m.slug),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const r = await applyRetype(storage.engine(), plan, "page-retype");
    console.log(
      JSON.stringify({ ok: true, dry_run: false, to: plan.to, updated: r.updated }, null, 2),
    );
    return 0;
  } finally {
    await storage.close();
  }
}
