#!/usr/bin/env bun
/**
 * memex CLI entrypoint.
 */
import { runInit } from "./commands/init.ts";
import { runServe } from "./commands/serve.ts";
import { runIndex } from "./commands/index.ts";
import { runSearch } from "./commands/search.ts";
import { runReindex } from "./commands/reindex.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runIntegrity } from "./commands/integrity.ts";
import { runEval } from "./commands/eval.ts";
import { runBacklinks } from "./commands/backlinks.ts";
import { runExtract } from "./commands/extract.ts";
import { runReconcileLinks } from "./commands/reconcile-links.ts";
import { runCheckResolvable } from "./commands/check-resolvable.ts";
import { runSkillify, runSkillifyCheck } from "./commands/skillify.ts";
import { runJobs } from "./commands/jobs.ts";
import type { JobStatus } from "./core/jobs/types.ts";
import { runEvalReplay } from "./commands/eval-replay.ts";
import type { EvalTag } from "./core/eval-replay.ts";
import { runFriction } from "./commands/friction.ts";
import { runEvalExport } from "./commands/eval-export.ts";
import { runEvalPrune } from "./commands/eval-prune.ts";
import { runApplyMigrations } from "./commands/apply-migrations.ts";
import {
  runSources,
  isSourceKind,
  isSyncPolicy,
  isIndexedPolicy,
} from "./commands/sources.ts";
import { runCode, type CodeSub } from "./commands/code.ts";

const VALID_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
import { runOrphans } from "./commands/orphans.ts";
import { runPages } from "./commands/pages.ts";
import { runLint } from "./commands/lint.ts";
import { runReports } from "./commands/reports.ts";
import { runSkillpack } from "./commands/skillpack.ts";
import { runMigrateEngine } from "./commands/migrate-engine.ts";
import { runCache } from "./commands/cache.ts";
import { runCall } from "./commands/call.ts";
import { runStatus } from "./commands/status.ts";
import { runEmbed } from "./commands/embed.ts";
import { runSearchModes } from "./commands/search-modes.ts";
import { resolveExitCode } from "./cli-exit.ts";
import type { EntityType } from "./core/entities.ts";

interface ParsedArgs {
  cmd: string | undefined;
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

function parseArgs(raw: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const cmd = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const token = raw[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const next = raw[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(token, next);
        i++;
      } else {
        flags.add(token);
      }
    } else {
      positional.push(token);
    }
  }
  return { cmd, flags, values, positional };
}

function printUsage(): void {
  console.log("Usage: memex <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  init --pglite                initialize ~/.memex/ + PGLite db");
  console.log("  serve --http --host H --port N");
  console.log("                               start HTTP server (loopback only)");
  console.log("  index <path>                 read a markdown file and index it");
  console.log("  search <query> [--k N]       hybrid retrieve over the corpus");
  console.log("  search modes                 read-only view of the active ranking knobs");
  console.log("  reindex [--all] [--vault P] [--source vault|code|all] [--paths CSV]");
  console.log("                               walk the vault and/or code roots, index changed (or all) files");
  console.log("  code-def <name> [--json]     definition sites for <name>");
  console.log("  code-refs <name> [--json]    non-defining identifier references for <name>");
  console.log("  code-callers <name> [--json] symbols whose body calls <name>");
  console.log("  code-callees <path>:<line> [--json]");
  console.log("                               symbols called from inside the symbol covering <path>:<line>");
  console.log("  doctor                       self-diagnostics — exits 0 on healthy");
  console.log("  integrity [--vault P]        vault-vs-index drift report");
  console.log("  eval [--k N]                 retrieval quality harness against tests/eval/qrels.json");
  console.log("  backlinks <name> [--type T] [--limit N]");
  console.log("                               documents that mention this entity (default type=wikilink)");
  console.log("  extract [--all] [--vault P]  re-run regex entity extraction over existing chunks (cheap)");
  console.log("  reconcile-links [--limit N]  list wikilinks that don't resolve to a document");
  console.log("  check-resolvable [--limit N] [--threshold P] [--strict]");
  console.log("                               wikilink coverage report; --strict elevates warnings into the exit-1 path");
  console.log("  skillify <prompt> [--out PATH] [--slug S] [--dry-run]");
  console.log("                               draft a skill *.md from a one-line prompt (Nova Lite + linter)");
  console.log("  skillify check <slug> [--strict]");
  console.log("                               validate an existing skill against the contract; --strict elevates warnings");
  console.log("  jobs list [--status S] [--kind K] [--limit N]");
  console.log("  jobs stats                   counts grouped by status");
  console.log("  jobs show|retry|cancel <id>  inspect/reset/cancel a single job");
  console.log("  cache stats                  query-cache rows: total/fresh/stale vs the clock");
  console.log("  cache prune|clear            drop only stale rows / drop every row");
  console.log("  call <tool> [--args '<json>']");
  console.log("                               invoke an MCP tool locally (internal ingress)");
  console.log("  status                       one-shot snapshot: counts + health + cache");
  console.log("  embed [--limit N] [--dry-run]");
  console.log("                               backfill embeddings for non-code chunks missing a vector");
  console.log("  eval-replay capture <id> --query Q --tag good|bad [--expected-doc D] [--k N] [--search-mode hybrid|keyword]");
  console.log("  eval-replay list [--tag T] [--limit N]");
  console.log("  eval-replay run [--tag T] [--limit N] [--promote]");
  console.log("                               capture / replay real queries; --promote sets new baseline");
  console.log("  eval-replay delete <id>      remove a captured query");
  console.log("  eval-export [--source firehose|curated] [--since H] [--limit N] [--out PATH]");
  console.log("                               JSONL dump of eval_candidates (default) or eval_queries");
  console.log("  eval-prune [--keep-days N] [--apply] [--tool-name T]");
  console.log("                               trim old rows from eval_candidates; --apply to actually delete");
  console.log("  apply-migrations [--dry-run]");
  console.log("                               manual migration runner (init runs them automatically)");
  console.log("  sources list [--kind K]      JSON list of registered sources");
  console.log("  sources show <id>            full row for one source");
  console.log("  sources register <id> --kind K --path-prefix P [--description D]");
  console.log("                               [--sync-policy synced|local-only|mirror]");
  console.log("                               [--indexed-policy verbatim|hashed-only|tombstoned]");
  console.log("                               [--rate-limit-per-minute N] [--respect-quiet-hours]");
  console.log("                               [--boost-weight N]");
  console.log("  sources update <id> [...same flags as register, all optional...]");
  console.log("                               [--no-respect-quiet-hours] to clear the flag");
  console.log("  sources delete <id>          refuses if any document still references it");
  console.log("  friction analyze [--since H] [--limit N]");
  console.log("                               counts + recent + top-repeats from friction_events");
  console.log("  friction list [--kind K] [--skill S] [--since H] [--limit N]");
  console.log("                               flat JSON list of recent events");
  console.log("  friction render [--kind K] [--skill S] [--since H] [--limit N] [--no-redact]");
  console.log("                               markdown table; redacts query/reason by default");
  console.log("  friction log --kind K [--query Q] [--reason R] [--source-path P] [--skill S] [--severity confused|error|blocker|nit]");
  console.log("                               record a friction event; kinds: search-miss|wrong-answer|tool-error|low-confidence|other|delight|phase-marker|interrupted");
  console.log("  friction propose-fix [--skill S | --top-skills N] [--since H] [--example-limit N]");
  console.log("                               Nova Lite suggests skill-text edits to reduce friction");
  console.log("  orphans                      DB hygiene report + safe deletions");
  console.log("  pages [--limit N] [--filter S] catalogue of known wikilink targets");
  console.log("  lint                         frontmatter conformance check");
  console.log("  reports [--since H]          trend report from cycle_snapshots");
  console.log("  skillpack [--out PATH]       bundle deploy/skills/ as a tar.gz with manifest");
  console.log("  migrate-engine --from X --to Y [--dry-run] [--pglite-path P] [--postgres-url U]");
  console.log("                               copy data between Engine adapters");
  console.log("  --help                       show this help");
}

async function main(argv: readonly string[]): Promise<number> {
  const { cmd, flags, values, positional } = parseArgs(argv);

  switch (cmd) {
    case "init": {
      const pglite = flags.has("--pglite");
      await runInit({ pglite });
      return 0;
    }
    case "serve": {
      const http = flags.has("--http");
      const host = values.get("--host") ?? process.env.MEMEX_HOST ?? "127.0.0.1";
      const portStr = values.get("--port") ?? process.env.BRAIN_PORT ?? "18790";
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`memex serve: invalid port ${portStr}`);
      }
      await runServe({ http, host, port });
      return 0;
    }
    case "index": {
      const path = positional[0];
      if (!path) {
        console.error("memex index: <path> is required");
        return 1;
      }
      await runIndex({ path });
      return 0;
    }
    case "reindex": {
      const all = flags.has("--all");
      const vault = values.get("--vault");
      const sourceStr = values.get("--source");
      if (
        sourceStr !== undefined &&
        sourceStr !== "vault" &&
        sourceStr !== "code" &&
        sourceStr !== "all"
      ) {
        throw new Error(
          `memex reindex: invalid --source '${sourceStr}' (expected vault|code|all)`,
        );
      }
      const paths = values.get("--paths");
      const opts: Parameters<typeof runReindex>[0] = { all };
      if (vault) opts.vault = vault;
      if (sourceStr) opts.source = sourceStr as "vault" | "code" | "all";
      if (paths) opts.codePaths = paths;
      await runReindex(opts);
      return 0;
    }
    case "code-def":
    case "code-refs":
    case "code-callers":
    case "code-callees": {
      const sub = cmd as CodeSub;
      const opts: Parameters<typeof runCode>[0] = { sub };
      if (flags.has("--json")) opts.json = true;
      if (sub === "code-callees") {
        opts.target = positional[0];
        if (!opts.target) {
          console.error(`memex ${sub}: <path>:<line> is required`);
          return 1;
        }
      } else {
        opts.name = positional.join(" ").trim();
        if (!opts.name) {
          console.error(`memex ${sub}: <name> is required`);
          return 1;
        }
      }
      await runCode(opts);
      return 0;
    }
    case "doctor": {
      await runDoctor();
      return 0;
    }
    case "status": {
      await runStatus();
      return 0;
    }
    case "integrity": {
      const vault = values.get("--vault");
      await runIntegrity(vault ? { vault } : {});
      return 0;
    }
    case "eval": {
      const kStr = values.get("--k");
      const k = kStr ? Number(kStr) : undefined;
      if (k !== undefined && (!Number.isInteger(k) || k < 1 || k > 100)) {
        throw new Error(`memex eval: invalid --k ${kStr}`);
      }
      await runEval(k !== undefined ? { k } : {});
      return 0;
    }
    case "backlinks": {
      const name = positional.join(" ");
      if (!name) {
        console.error("memex backlinks: <name> is required");
        return 1;
      }
      const typeStr = values.get("--type");
      const limitStr = values.get("--limit");
      const opts: Parameters<typeof runBacklinks>[0] = { name };
      if (typeStr) {
        if (typeStr !== "wikilink" && typeStr !== "tag" && typeStr !== "date") {
          throw new Error(`memex backlinks: invalid --type ${typeStr}`);
        }
        opts.type = typeStr as EntityType;
      }
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          throw new Error(`memex backlinks: invalid --limit ${limitStr}`);
        }
        opts.limit = n;
      }
      await runBacklinks(opts);
      return 0;
    }
    case "extract": {
      const all = flags.has("--all");
      const vault = values.get("--vault");
      await runExtract(vault ? { all, vault } : { all });
      return 0;
    }
    case "reconcile-links": {
      const limitStr = values.get("--limit");
      const opts: Parameters<typeof runReconcileLinks>[0] = {};
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          throw new Error(`memex reconcile-links: invalid --limit ${limitStr}`);
        }
        opts.reportLimit = n;
      }
      await runReconcileLinks(opts);
      return 0;
    }
    case "friction": {
      const sub = positional[0];
      if (
        sub !== "analyze" &&
        sub !== "propose-fix" &&
        sub !== "list" &&
        sub !== "render" &&
        sub !== "log"
      ) {
        console.error(
          "memex friction: subcommand required (analyze|propose-fix|list|render|log)",
        );
        return 1;
      }
      const opts: Parameters<typeof runFriction>[0] = { sub };
      const sinceStr = values.get("--since");
      if (sinceStr !== undefined) {
        const n = Number(sinceStr);
        if (!Number.isFinite(n) || n < 1 || n > 24 * 365) {
          throw new Error(`memex friction: invalid --since ${sinceStr}`);
        }
        opts.sinceHours = n;
      }
      const limitStr = values.get("--limit");
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          throw new Error(`memex friction: invalid --limit ${limitStr}`);
        }
        opts.limit = n;
      }
      if (sub === "propose-fix") {
        const skill = values.get("--skill");
        if (skill) opts.skill = skill;
        const topStr = values.get("--top-skills");
        if (topStr !== undefined) {
          const n = Number(topStr);
          if (!Number.isInteger(n) || n < 1 || n > 50) {
            throw new Error(`memex friction: invalid --top-skills ${topStr}`);
          }
          opts.topSkills = n;
        }
        const exStr = values.get("--example-limit");
        if (exStr !== undefined) {
          const n = Number(exStr);
          if (!Number.isInteger(n) || n < 1 || n > 50) {
            throw new Error(`memex friction: invalid --example-limit ${exStr}`);
          }
          opts.exampleLimit = n;
        }
      }
      if (sub === "list" || sub === "render" || sub === "log") {
        const k = values.get("--kind");
        if (
          k === "search-miss" ||
          k === "wrong-answer" ||
          k === "tool-error" ||
          k === "low-confidence" ||
          k === "other" ||
          k === "delight" ||
          k === "phase-marker" ||
          k === "interrupted"
        ) {
          opts.kind = k;
        } else if (k !== undefined) {
          throw new Error(`memex friction: invalid --kind ${k}`);
        }
        const skill = values.get("--skill");
        if (skill) opts.skill = skill;
      }
      if (sub === "render" && flags.has("--no-redact")) opts.noRedact = true;
      if (sub === "log") {
        const q = values.get("--query");
        if (q) opts.query = q;
        const r = values.get("--reason");
        if (r) opts.reason = r;
        const sp = values.get("--source-path");
        if (sp) opts.sourcePath = sp;
        const sev = values.get("--severity");
        if (
          sev === "confused" ||
          sev === "error" ||
          sev === "blocker" ||
          sev === "nit"
        ) {
          opts.severity = sev;
        } else if (sev !== undefined) {
          throw new Error(`memex friction log: invalid --severity ${sev}`);
        }
      }
      await runFriction(opts);
      return 0;
    }
    case "eval-export": {
      const opts: Parameters<typeof runEvalExport>[0] = {};
      const src = values.get("--source");
      if (src === "firehose" || src === "curated") opts.source = src;
      else if (src !== undefined) {
        throw new Error(`memex eval-export: invalid --source ${src}`);
      }
      const since = values.get("--since");
      if (since !== undefined) {
        const n = Number(since);
        if (!Number.isFinite(n) || n < 1 || n > 24 * 365) {
          throw new Error(`memex eval-export: invalid --since ${since}`);
        }
        opts.sinceHours = n;
      }
      const limit = values.get("--limit");
      if (limit !== undefined) {
        const n = Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
          throw new Error(`memex eval-export: invalid --limit ${limit}`);
        }
        opts.limit = n;
      }
      const out = values.get("--out");
      if (out) opts.out = out;
      await runEvalExport(opts);
      return 0;
    }
    case "eval-prune": {
      const opts: Parameters<typeof runEvalPrune>[0] = {};
      const keep = values.get("--keep-days");
      if (keep !== undefined) {
        const n = Number(keep);
        if (!Number.isFinite(n) || n < 1 || n > 365 * 10) {
          throw new Error(`memex eval-prune: invalid --keep-days ${keep}`);
        }
        opts.keepDays = n;
      }
      if (flags.has("--apply")) opts.apply = true;
      const tool = values.get("--tool-name");
      if (tool) opts.toolName = tool;
      await runEvalPrune(opts);
      return 0;
    }
    case "apply-migrations": {
      const opts: Parameters<typeof runApplyMigrations>[0] = {};
      if (flags.has("--dry-run")) opts.dryRun = true;
      await runApplyMigrations(opts);
      return 0;
    }
    case "cache": {
      const sub = positional[0];
      if (sub !== "stats" && sub !== "prune" && sub !== "clear") {
        console.error("memex cache: subcommand required (stats|prune|clear)");
        return 1;
      }
      await runCache({ sub });
      return 0;
    }
    case "embed": {
      // `--limit` with no value parses as a bare flag — reject it rather than
      // silently running an uncapped backfill (which would defeat the cost cap).
      if (flags.has("--limit")) {
        console.error("memex embed: --limit requires a positive integer value");
        return 1;
      }
      const limitStr = values.get("--limit");
      const opts: Parameters<typeof runEmbed>[0] = {};
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n <= 0) {
          console.error("memex embed: --limit must be a positive integer");
          return 1;
        }
        opts.limit = n;
      }
      if (flags.has("--dry-run")) opts.dryRun = true;
      return await runEmbed(opts);
    }
    case "call": {
      const tool = positional[0];
      if (!tool) {
        console.error(
          `memex call: <tool> is required (e.g. memex call search --args '{"q":"..."}')`,
        );
        return 1;
      }
      const opts: Parameters<typeof runCall>[0] = { tool };
      const argsJson = values.get("--args");
      if (argsJson !== undefined) opts.argsJson = argsJson;
      return await runCall(opts);
    }
    case "sources": {
      const sub = positional[0];
      if (
        sub !== "list" &&
        sub !== "show" &&
        sub !== "register" &&
        sub !== "update" &&
        sub !== "delete"
      ) {
        console.error(
          "memex sources: subcommand required (list|show|register|update|delete)",
        );
        return 1;
      }
      const opts: Parameters<typeof runSources>[0] = { sub };
      if (sub === "show" || sub === "register" || sub === "update" || sub === "delete") {
        opts.id = positional[1];
      }
      const kind = values.get("--kind");
      if (kind) {
        if (!isSourceKind(kind)) {
          throw new Error(`memex sources: invalid --kind '${kind}'`);
        }
        opts.kind = kind;
      }
      const pp = values.get("--path-prefix");
      if (pp) opts.pathPrefix = pp;
      const sp = values.get("--sync-policy");
      if (sp) {
        if (!isSyncPolicy(sp)) {
          throw new Error(`memex sources: invalid --sync-policy '${sp}'`);
        }
        opts.syncPolicy = sp;
      }
      const ip = values.get("--indexed-policy");
      if (ip) {
        if (!isIndexedPolicy(ip)) {
          throw new Error(`memex sources: invalid --indexed-policy '${ip}'`);
        }
        opts.indexedPolicy = ip;
      }
      const rl = values.get("--rate-limit-per-minute");
      if (rl !== undefined) {
        const n = Number(rl);
        if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
          throw new Error(`memex sources: invalid --rate-limit-per-minute ${rl}`);
        }
        opts.rateLimitPerMinute = n;
      }
      if (flags.has("--respect-quiet-hours")) opts.respectQuietHours = true;
      if (flags.has("--no-respect-quiet-hours")) opts.respectQuietHours = false;
      const bw = values.get("--boost-weight");
      if (bw !== undefined) {
        const n = Number(bw);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          throw new Error(`memex sources: invalid --boost-weight ${bw}`);
        }
        opts.boostWeight = n;
      }
      const desc = values.get("--description");
      if (desc !== undefined) opts.description = desc;
      await runSources(opts);
      return 0;
    }
    case "eval-replay": {
      const sub = positional[0];
      if (sub !== "capture" && sub !== "list" && sub !== "delete" && sub !== "run") {
        console.error("memex eval-replay: subcommand required (capture|list|delete|run)");
        return 1;
      }
      const opts: Parameters<typeof runEvalReplay>[0] = { sub };
      if (sub === "capture") {
        opts.id = positional[1];
        const q = values.get("--query");
        if (q) opts.query = q;
        const tag = values.get("--tag");
        if (tag === "good" || tag === "bad") opts.tag = tag as EvalTag;
        const expected = values.get("--expected-doc");
        if (expected) opts.expectedDocId = expected;
        const kStr = values.get("--k");
        if (kStr !== undefined) {
          const n = Number(kStr);
          if (!Number.isInteger(n) || n < 1 || n > 100) {
            throw new Error(`memex eval-replay capture: invalid --k ${kStr}`);
          }
          opts.k = n;
        }
        const src = values.get("--source");
        if (src) opts.source = src;
        const notes = values.get("--notes");
        if (notes) opts.notes = notes;
        const mode = values.get("--search-mode");
        if (mode === "hybrid" || mode === "keyword") opts.searchMode = mode;
        else if (mode !== undefined) {
          throw new Error(`memex eval-replay capture: invalid --search-mode ${mode}`);
        }
      } else if (sub === "delete") {
        opts.id = positional[1];
      } else if (sub === "list" || sub === "run") {
        const tag = values.get("--tag");
        if (tag === "good" || tag === "bad") opts.filterTag = tag as EvalTag;
        const lStr = values.get("--limit");
        if (lStr !== undefined) {
          const n = Number(lStr);
          if (!Number.isInteger(n) || n < 1 || n > 1000) {
            throw new Error(`memex eval-replay: invalid --limit ${lStr}`);
          }
          opts.limit = n;
        }
        if (sub === "run" && flags.has("--promote")) opts.promote = true;
      }
      await runEvalReplay(opts);
      return 0;
    }
    case "jobs": {
      const sub = positional[0];
      if (
        sub !== "list" &&
        sub !== "stats" &&
        sub !== "retry" &&
        sub !== "cancel" &&
        sub !== "show"
      ) {
        console.error(
          `memex jobs: subcommand required (list|stats|show|retry|cancel)`,
        );
        return 1;
      }
      const opts: Parameters<typeof runJobs>[0] = { sub };
      if (sub === "list") {
        const statusStr = values.get("--status");
        if (statusStr) {
          const parts = statusStr.split(",").map((s) => s.trim());
          for (const p of parts) {
            if (!VALID_JOB_STATUSES.has(p as JobStatus)) {
              throw new Error(`memex jobs: invalid --status '${p}'`);
            }
          }
          opts.status = parts as JobStatus[];
        }
        const kindStr = values.get("--kind");
        if (kindStr) opts.kind = kindStr;
        const limitStr = values.get("--limit");
        if (limitStr !== undefined) {
          const n = Number(limitStr);
          if (!Number.isInteger(n) || n < 1 || n > 500) {
            throw new Error(`memex jobs: invalid --limit ${limitStr}`);
          }
          opts.limit = n;
        }
      } else if (sub === "show" || sub === "retry" || sub === "cancel") {
        const id = positional[1];
        if (!id) {
          console.error(`memex jobs ${sub}: <id> is required`);
          return 1;
        }
        opts.id = id;
      }
      await runJobs(opts);
      return 0;
    }
    case "skillify": {
      // Subcommand routing: `skillify check <slug>` is a separate path.
      // Bare-prompt invocation (`skillify "<prompt>"`) is the legacy + scaffold path.
      if (positional[0] === "check") {
        const slug = positional[1];
        if (!slug) {
          console.error("memex skillify check: <slug> is required");
          return 1;
        }
        const opts: Parameters<typeof runSkillifyCheck>[0] = { slug };
        if (flags.has("--strict")) opts.strict = true;
        await runSkillifyCheck(opts);
        return 0;
      }
      // Allow `skillify scaffold <prompt>` as an explicit alias of bare-prompt.
      const promptParts =
        positional[0] === "scaffold" ? positional.slice(1) : positional;
      const prompt = promptParts.join(" ").trim();
      if (!prompt) {
        console.error("memex skillify: <prompt> is required");
        return 1;
      }
      const opts: Parameters<typeof runSkillify>[0] = { prompt };
      const out = values.get("--out");
      if (out) opts.out = out;
      const slug = values.get("--slug");
      if (slug) opts.slug = slug;
      if (flags.has("--dry-run")) opts.dryRun = true;
      await runSkillify(opts);
      return 0;
    }
    case "check-resolvable": {
      const limitStr = values.get("--limit");
      const thresholdStr = values.get("--threshold");
      const opts: Parameters<typeof runCheckResolvable>[0] = {};
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          throw new Error(`memex check-resolvable: invalid --limit ${limitStr}`);
        }
        opts.reportLimit = n;
      }
      if (thresholdStr !== undefined) {
        const n = Number(thresholdStr);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          throw new Error(
            `memex check-resolvable: invalid --threshold ${thresholdStr} (expected 0-100)`,
          );
        }
        opts.threshold = n;
      }
      if (flags.has("--strict")) opts.strict = true;
      await runCheckResolvable(opts);
      return 0;
    }
    case "orphans": {
      await runOrphans();
      return 0;
    }
    case "pages": {
      const limitStr = values.get("--limit");
      const filter = values.get("--filter");
      const opts: Parameters<typeof runPages>[0] = {};
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n < 1 || n > 5000) {
          throw new Error(`memex pages: invalid --limit ${limitStr}`);
        }
        opts.limit = n;
      }
      if (filter) opts.filter = filter;
      await runPages(opts);
      return 0;
    }
    case "lint": {
      await runLint();
      return 0;
    }
    case "reports": {
      const sinceStr = values.get("--since");
      const opts: Parameters<typeof runReports>[0] = {};
      if (sinceStr !== undefined) {
        const n = Number(sinceStr);
        if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
          throw new Error(`memex reports: invalid --since ${sinceStr}`);
        }
        opts.sinceHours = n;
      }
      await runReports(opts);
      return 0;
    }
    case "skillpack": {
      const out = values.get("--out");
      const opts: Parameters<typeof runSkillpack>[0] = {};
      if (out) opts.out = out;
      await runSkillpack(opts);
      return 0;
    }
    case "migrate-engine": {
      const from = values.get("--from");
      const to = values.get("--to");
      if (
        (from !== "pglite" && from !== "postgres") ||
        (to !== "pglite" && to !== "postgres")
      ) {
        throw new Error(
          "memex migrate-engine: --from and --to are required (pglite|postgres)",
        );
      }
      const opts: Parameters<typeof runMigrateEngine>[0] = {
        from: from as "pglite" | "postgres",
        to: to as "pglite" | "postgres",
      };
      if (flags.has("--dry-run")) opts.dryRun = true;
      const pPath = values.get("--pglite-path");
      if (pPath) opts.pgliteDbPath = pPath;
      const pUrl = values.get("--postgres-url");
      if (pUrl) opts.postgresUrl = pUrl;
      const batch = values.get("--batch-size");
      if (batch) opts.batchSize = Number(batch);
      await runMigrateEngine(opts);
      return 0;
    }
    case "search": {
      // `search modes` — read-only ranking-config view (no query, no storage).
      if (positional.length === 1 && positional[0] === "modes") {
        runSearchModes();
        return 0;
      }
      const query = positional.join(" ");
      if (!query) {
        console.error("memex search: <query> is required");
        return 1;
      }
      const kStr = values.get("--k");
      const k = kStr ? Number(kStr) : undefined;
      if (k !== undefined && (!Number.isInteger(k) || k < 1 || k > 100)) {
        throw new Error(`memex search: invalid --k ${kStr}`);
      }
      await runSearch(k !== undefined ? { query, k } : { query });
      return 0;
    }
    case undefined:
    case "--help":
    case "-h":
    case "help":
      printUsage();
      return 0;
    default:
      console.error(`memex: unknown command '${cmd}'`);
      printUsage();
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(resolveExitCode(code, process.exitCode)),
  (err) => {
    console.error(`[memex] error:`, err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
