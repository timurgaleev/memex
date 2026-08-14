/**
 * `memex friction <subcommand>` — friction logbook tooling.
 *
 * Subcommands:
 *   analyze [--since H] [--limit N]      counts + recent + top-repeats
 *   propose-fix [--skill S | --top-skills N] [--since H] [--limit N]
 *                                        Claude Haiku suggests skill-text edits
 *
 * The propose-fix surface is print-only by design — auto-applying
 * model-suggested skill edits needs a friction-on-friction safeguard
 * before we wire it up.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  analyzeFriction,
  listFrictionEvents,
  logFriction,
  renderFrictionMarkdown,
  type FrictionKind,
  type FrictionSeverity,
} from "../core/friction.ts";
import { proposeFixes } from "../core/friction-propose.ts";

export type FrictionSub =
  | "analyze"
  | "propose-fix"
  | "list"
  | "render"
  | "log";

export interface FrictionCmdOptions {
  sub: FrictionSub;
  sinceHours?: number;
  limit?: number;
  // propose-fix
  skill?: string;
  topSkills?: number;
  exampleLimit?: number;
  // list / render
  kind?: FrictionKind;
  // render
  noRedact?: boolean;
  // log
  query?: string;
  reason?: string;
  sourcePath?: string;
  severity?: FrictionSeverity;
}

export async function runFriction(opts: FrictionCmdOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const engine = storage.engine();
    switch (opts.sub) {
      case "analyze": {
        const aOpts: Parameters<typeof analyzeFriction>[1] = {};
        if (opts.sinceHours !== undefined) aOpts.sinceHours = opts.sinceHours;
        if (opts.limit !== undefined) aOpts.limit = opts.limit;
        const r = await analyzeFriction(engine, aOpts);
        console.log(JSON.stringify({ ok: true, ...r }, null, 2));
        return;
      }
      case "list": {
        const lOpts: Parameters<typeof listFrictionEvents>[1] = {};
        if (opts.sinceHours !== undefined) lOpts.sinceHours = opts.sinceHours;
        if (opts.limit !== undefined) lOpts.limit = opts.limit;
        if (opts.kind) lOpts.kind = opts.kind;
        if (opts.skill) lOpts.skill = opts.skill;
        const events = await listFrictionEvents(engine, lOpts);
        console.log(
          JSON.stringify(
            { ok: true, count: events.length, events },
            null,
            2,
          ),
        );
        return;
      }
      case "render": {
        const lOpts: Parameters<typeof listFrictionEvents>[1] = {};
        if (opts.sinceHours !== undefined) lOpts.sinceHours = opts.sinceHours;
        if (opts.limit !== undefined) lOpts.limit = opts.limit;
        if (opts.kind) lOpts.kind = opts.kind;
        if (opts.skill) lOpts.skill = opts.skill;
        const events = await listFrictionEvents(engine, lOpts);
        const md = renderFrictionMarkdown(events, {
          redact: !opts.noRedact,
        });
        process.stdout.write(md);
        return;
      }
      case "log": {
        if (!opts.kind) throw new Error("memex friction log: --kind is required");
        const input: Parameters<typeof logFriction>[1] = { kind: opts.kind };
        if (opts.query) input.query = opts.query;
        if (opts.reason) input.reason = opts.reason;
        if (opts.sourcePath) input.sourcePath = opts.sourcePath;
        if (opts.severity) input.severity = opts.severity;
        if (opts.skill) input.extra = { skill: opts.skill };
        await logFriction(engine, input);
        console.log(JSON.stringify({ ok: true }, null, 2));
        return;
      }
      case "propose-fix": {
        if (!opts.skill && opts.topSkills === undefined) {
          throw new Error(
            "memex friction propose-fix: --skill or --top-skills is required",
          );
        }
        const pOpts: Parameters<typeof proposeFixes>[2] = {};
        if (opts.sinceHours !== undefined) pOpts.sinceHours = opts.sinceHours;
        if (opts.exampleLimit !== undefined) pOpts.exampleLimit = opts.exampleLimit;
        const cfg = opts.skill
          ? ({ mode: "skill", skill: opts.skill } as const)
          : ({ mode: "top", topSkills: opts.topSkills! } as const);
        const proposals = await proposeFixes(engine, cfg, pOpts);
        console.log(
          JSON.stringify(
            { ok: true, count: proposals.length, proposals },
            null,
            2,
          ),
        );
        return;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memex friction: unknown subcommand '${_exhaustive}'`);
      }
    }
  } finally {
    await storage.close();
  }
}
