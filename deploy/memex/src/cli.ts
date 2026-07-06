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
import { runEvalProbe } from "./commands/eval-probe.ts";
import { runBacklinks } from "./commands/backlinks.ts";
import { runExtract } from "./commands/extract.ts";
import { runExtractConversationFactsCli } from "./commands/extract-conversation-facts.ts";
import { runThinkCli } from "./commands/think.ts";
import { runReconcileLinks } from "./commands/reconcile-links.ts";
import { runCheckResolvable } from "./commands/check-resolvable.ts";
import { runSkillify, runSkillifyCheck } from "./commands/skillify.ts";
import { runJobs } from "./commands/jobs.ts";
import type { JobStatus } from "./core/jobs/types.ts";
import { runEvalReplay } from "./commands/eval-replay.ts";
import type { EvalTag } from "./core/eval-replay.ts";
import { runFriction } from "./commands/friction.ts";
import { runEvalExport } from "./commands/eval-export.ts";
import { runExport } from "./commands/export.ts";
import { runEvalPrune } from "./commands/eval-prune.ts";
import { runApplyMigrations } from "./commands/apply-migrations.ts";
import {
  runSources,
  isSourceKind,
  isSyncPolicy,
  isIndexedPolicy,
} from "./commands/sources.ts";
import { runCode, type CodeSub } from "./commands/code.ts";
import { runTenant, type TenantSub } from "./commands/tenant.ts";
import { runAuth } from "./commands/auth.ts";

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
import { runSearchStats, runSearchTune } from "./commands/search-stats.ts";
import { runSearchDiagnose } from "./commands/search-diagnose.ts";
import { runConfig, type ConfigSub } from "./commands/config.ts";
import { runCapture } from "./commands/capture.ts";
import { runQuarantine, type QuarantineSub } from "./commands/quarantine.ts";
import {
  runEvalRunAll,
  runEvalCompareCmd,
  runEvalGate,
} from "./commands/eval-compare.ts";
import { parseEvalConfig, type EvalKnobConfig } from "./commands/eval.ts";
import { runSalience } from "./commands/salience.ts";
import { runWatch } from "./commands/watch.ts";
import { runCycle, parsePhasesArg } from "./commands/cycle.ts";
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
  console.log("  search <query> [--k N] [--explain]");
  console.log("                               hybrid retrieve over the corpus (--explain = per-signal attribution)");
  console.log("  search modes                 read-only view of the active ranking knobs");
  console.log("  search stats [--days N] [--json]");
  console.log("                               telemetry rollup: volume, cache hit rate, intent/mode mix, rank-1 drift");
  console.log("  search tune [--apply] [--json]");
  console.log("                               ranking recommendations from the stats; --apply writes via `config`");
  console.log("  search diagnose <query> --target <slug> [--source ID] [--json]");
  console.log("                               arm-by-arm probe: where does the target surface (keyword/vector/alias/hybrid)?");
  console.log("  reindex [--all] [--vault P] [--source vault|code|all] [--paths CSV] [--rechunk-stale] [--reconcile-deletes]");
  console.log("  reindex --contextual [--force] [--dry-run] [--limit N]");
  console.log("                               whole-corpus from-DB re-embed under the contextual-retrieval wrapper");
  console.log("                               walk the vault and/or code roots, index changed (or all) files");
  console.log("                               (--reconcile-deletes soft-deletes vault docs whose file is gone)");
  console.log("  code-def <name> [--json]     definition sites for <name>");
  console.log("  code-refs <name> [--json]    non-defining identifier references for <name>");
  console.log("  code-callers <name> [--json] symbols whose body calls <name>");
  console.log("  code-callees <path>:<line> [--json]");
  console.log("                               symbols called from inside the symbol covering <path>:<line>");
  console.log("  doctor                       self-diagnostics — exits 0 on healthy");
  console.log("  integrity [--vault P]        vault-vs-index drift report");
  console.log("  eval [--k N] [--qrels P] [--rrf-k N] [--expand|--no-expand] [--rerank] [--max-pool]");
  console.log("       [--graph-signals] [--cosine-rescore] [--relational-arm] [--dedup-type-ratio X]");
  console.log("       [--config-a <json|path>] [--config-b <json|path>]");
  console.log("                               retrieval quality harness; --config-b = A/B compare");
  console.log("  eval run-all [--modes a,b,c] [--qrels P] [--k N] [--out P]");
  console.log("                               run the suite once per search mode, append JSONL results");
  console.log("  eval compare [--input P] [--json]");
  console.log("                               per-mode comparison table from the results log");
  console.log("  eval gate [--baseline P] [--max-drop X] [--min-recall X] [--write-baseline]");
  console.log("                               regression gate vs a stored baseline (exit 1 on drop)");
  console.log("  eval-probe [--limit N]       replay eval set, append a row to eval_snapshots (nightly probe)");
  console.log("  backlinks <name> [--type T] [--limit N]");
  console.log("                               documents that mention this entity (default type=wikilink)");
  console.log("  extract [--all] [--vault P]  re-run regex entity extraction over existing chunks (cheap)");
  console.log("  extract --stale [--source-id S] [--catch-up] [--dry-run] [--json]  re-extract links for stale pages");
  console.log("  reconcile-links [--limit N]  list wikilinks that don't resolve to a document");
  console.log("  check-resolvable [--limit N] [--threshold P] [--strict]");
  console.log("                               wikilink coverage report; --strict elevates warnings into the exit-1 path");
  console.log("  skillify <prompt> [--out PATH] [--slug S] [--dry-run]");
  console.log("                               draft a skill *.md from a one-line prompt (Claude Haiku + linter)");
  console.log("  skillify check <slug> [--strict]");
  console.log("                               validate an existing skill against the contract; --strict elevates warnings");
  console.log("  jobs list [--status S] [--kind K] [--limit N]");
  console.log("  jobs stats                   counts grouped by status");
  console.log("  jobs show|retry|cancel <id>  inspect/reset/cancel a single job");
  console.log("  jobs submit <kind> [--id X] [--priority N] [--max-retries N] [--payload '<json>']");
  console.log("  jobs progress <id>           status + handler-reported progress");
  console.log("  jobs remove <id>             delete one terminal job row");
  console.log("  jobs prune [--older-than-days N] [--status s1,s2]");
  console.log("                               delete old terminal jobs (default 30d)");
  console.log("  jobs smoke                   end-to-end queue self-test");
  console.log("  cache stats                  query-cache rows: total/fresh/stale vs the clock");
  console.log("  cache prune|clear            drop only stale rows / drop every row");
  console.log("  call <tool> [--args '<json>']");
  console.log("                               invoke an MCP tool locally (internal ingress)");
  console.log("  status                       one-shot snapshot: counts + health + cache");
  console.log("  salience [--type T] [--days N] [--limit N]");
  console.log("                               pages ranked by deterministic salience score");
  console.log("  cycle [--phases a,b,c] [--stale-days N]");
  console.log("                               run one maintenance cycle on demand (backfills)");
  console.log("  embed [<slug>] [--slugs a,b] [--all] [--stale] [--source ID] [--limit N] [--dry-run]");
  console.log("                               backfill missing vectors; <slug>/--slugs/--all re-embed targets,");
  console.log("                               --stale also refreshes signature-stale rows");
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
  console.log("                               Claude Haiku suggests skill-text edits to reduce friction");
  console.log("  orphans                      DB hygiene report + safe deletions");
  console.log("  pages [--limit N] [--filter S] catalogue of known wikilink targets");
  console.log("  lint [<dir|file.md>] [--fix] [--dry-run]");
  console.log("                               DB frontmatter conformance (no target) or file lint with auto-repair");
  console.log("  reports [--since H]          trend report from cycle_snapshots");
  console.log("  skillpack [--out PATH]       bundle deploy/skills/ as a tar.gz with manifest");
  console.log("  migrate-engine --from X --to Y [--dry-run] [--pglite-path P] [--postgres-url U]");
  console.log("                               copy data between Engine adapters");
  console.log("  tenant add <id> [--name D]   register a tenant source (idempotent)");
  console.log("  tenant grant <sub> --source <id> [--read <id1,id2,...>]");
  console.log("                               upsert a write-source + federated-read grant for a JWT subject");
  console.log("  tenant list                  JSON list of all subject grants");
  console.log("  tenant revoke <sub>          delete the grant for a JWT subject");
  console.log("  auth register-client <name> [--scopes S] [--source SRC] [--federated-read a,b]");
  console.log("                               [--token-endpoint-auth-method none|client_secret_post|client_secret_basic]");
  console.log("                               register a client_credentials OAuth client (prints secret once;");
  console.log("                               'none' = public PKCE client, no secret)");
  console.log("  auth list-clients            JSON list of registered OAuth clients");
  console.log("  auth revoke-client <id>      hard-delete a client (cascades to its tokens)");
  console.log("  auth grant-token <id> <secret> [--scopes S]");
  console.log("                               mint an access token locally (= POST /token)");
  console.log("  auth create <name> [--takes-holders a,b]");
  console.log("                               mint a long-lived personal access token (prints once)");
  console.log("  auth list                    JSON list of personal access tokens (no hashes)");
  console.log("  auth revoke <name>           soft-revoke a personal access token");
  console.log("  auth permissions <name> set-takes-holders a,b");
  console.log("                               replace the token's takes-visibility allow-list");
  console.log("  auth test <url> --token <token>");
  console.log("                               live MCP smoke: initialize + tools/list + a real stats call");
  console.log("  think <question> [--k N] [--budget USD] [--json] [--save] [--take '<claim>']");
  console.log("        [--since D] [--until D] [--anchor a,b] [--rounds N] [--model ID] [--with-calibration]");
  console.log("                               paid Sonnet synthesis across the brain (opt-in, MEMEX_THINK=1);");
  console.log("                               --save persists a synthesis/ page, --take queues a take");
  console.log("  config show|get|set|unset    DB-plane MEMEX_* knob overrides (no redeploy; env still wins)");
  console.log("  config unset --pattern <pfx> bulk-delete keys by prefix");
  console.log("  capture [<text>] [--stdin] [--file P] [--slug S] [--type T] [--source ID] [--title T]");
  console.log("                               one-command note capture → page + search mirror");
  console.log("  quarantine list [--include-flagged] [--json]");
  console.log("  quarantine clear <slug|path> [--force]");
  console.log("  quarantine scan [--limit N] [--apply]");
  console.log("                               operator surface for the content-sanity gate");
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
      if (flags.has("--rechunk-stale")) opts.rechunkStale = true;
      if (flags.has("--reconcile-deletes")) opts.reconcileDeletes = true;
      if (flags.has("--contextual")) opts.contextual = true;
      if (flags.has("--force")) opts.force = true;
      if (flags.has("--dry-run")) opts.dryRun = true;
      const ctxLimitStr = values.get("--limit");
      if (ctxLimitStr !== undefined) {
        const n = Number(ctxLimitStr);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`memex reindex: invalid --limit ${ctxLimitStr}`);
        }
        opts.limit = n;
      }
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
      await runStatus(flags.has("--per-source") ? { perSource: true } : {});
      return 0;
    }
    case "integrity": {
      const vault = values.get("--vault");
      await runIntegrity(vault ? { vault } : {});
      return 0;
    }
    case "eval": {
      // Sub-subcommands: run-all / compare / gate (aggregate instruments).
      if (positional[0] === "run-all") {
        const runAllOpts: Parameters<typeof runEvalRunAll>[0] = {};
        const modesStr = values.get("--modes");
        if (modesStr) {
          runAllOpts.modes = modesStr.split(",").map((s) => s.trim()).filter(Boolean);
        }
        const qp = values.get("--qrels");
        if (qp) runAllOpts.qrelsPath = qp;
        const out = values.get("--out");
        if (out) runAllOpts.out = out;
        const kAll = values.get("--k");
        if (kAll !== undefined) {
          const n = Number(kAll);
          if (!Number.isInteger(n) || n < 1 || n > 100) {
            throw new Error(`memex eval run-all: invalid --k ${kAll}`);
          }
          runAllOpts.k = n;
        }
        return await runEvalRunAll(runAllOpts);
      }
      if (positional[0] === "compare") {
        const cmpOpts: Parameters<typeof runEvalCompareCmd>[0] = {};
        const input = values.get("--input");
        if (input) cmpOpts.input = input;
        if (flags.has("--json")) cmpOpts.json = true;
        return await runEvalCompareCmd(cmpOpts);
      }
      if (positional[0] === "gate") {
        const gateOpts: Parameters<typeof runEvalGate>[0] = {};
        const baseline = values.get("--baseline");
        if (baseline) gateOpts.baseline = baseline;
        const maxDrop = values.get("--max-drop");
        if (maxDrop !== undefined) {
          const n = Number(maxDrop);
          if (!Number.isFinite(n) || n < 0 || n > 1) {
            throw new Error(`memex eval gate: invalid --max-drop ${maxDrop}`);
          }
          gateOpts.maxDrop = n;
        }
        const minRecall = values.get("--min-recall");
        if (minRecall !== undefined) {
          const n = Number(minRecall);
          if (!Number.isFinite(n) || n < 0 || n > 1) {
            throw new Error(`memex eval gate: invalid --min-recall ${minRecall}`);
          }
          gateOpts.minRecall = n;
        }
        if (flags.has("--write-baseline")) gateOpts.writeBaseline = true;
        const qg = values.get("--qrels");
        if (qg) gateOpts.qrelsPath = qg;
        const kg = values.get("--k");
        if (kg !== undefined) {
          const n = Number(kg);
          if (!Number.isInteger(n) || n < 1 || n > 100) {
            throw new Error(`memex eval gate: invalid --k ${kg}`);
          }
          gateOpts.k = n;
        }
        return await runEvalGate(gateOpts);
      }

      const kStr = values.get("--k");
      const k = kStr ? Number(kStr) : undefined;
      if (k !== undefined && (!Number.isInteger(k) || k < 1 || k > 100)) {
        throw new Error(`memex eval: invalid --k ${kStr}`);
      }
      // Knob flags → the A-side config (reference parity: CLI overrides file).
      const cfg: EvalKnobConfig = values.has("--config-a")
        ? parseEvalConfig(values.get("--config-a")!)
        : {};
      const rrfKStr = values.get("--rrf-k");
      if (rrfKStr !== undefined) {
        const n = Number(rrfKStr);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          throw new Error(`memex eval: invalid --rrf-k ${rrfKStr}`);
        }
        cfg.rrfK = n;
      }
      if (flags.has("--expand")) cfg.expansion = true;
      if (flags.has("--no-expand")) cfg.expansion = false;
      if (flags.has("--rerank")) cfg.rerank = true;
      if (flags.has("--max-pool")) cfg.maxPool = true;
      if (flags.has("--graph-signals")) cfg.graphSignals = true;
      if (flags.has("--cosine-rescore")) cfg.cosineRescore = true;
      if (flags.has("--relational-arm")) cfg.relationalArm = true;
      const ratioStr = values.get("--dedup-type-ratio");
      if (ratioStr !== undefined) {
        const n = Number(ratioStr);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`memex eval: invalid --dedup-type-ratio ${ratioStr}`);
        }
        cfg.dedupTypeRatio = n;
      }
      const evalOpts: Parameters<typeof runEval>[0] = {};
      if (k !== undefined) evalOpts.k = k;
      const qrels = values.get("--qrels");
      if (qrels) evalOpts.qrelsPath = qrels;
      if (Object.keys(cfg).length > 0) evalOpts.config = cfg;
      if (values.has("--config-b")) {
        evalOpts.configB = parseEvalConfig(values.get("--config-b")!);
      }
      await runEval(evalOpts);
      return 0;
    }
    case "eval-probe": {
      const limitStr = values.get("--limit");
      const limit = limitStr ? Number(limitStr) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
        throw new Error(`memex eval-probe: invalid --limit ${limitStr}`);
      }
      const maxUsdStr = values.get("--max-usd");
      const maxUsd = maxUsdStr ? Number(maxUsdStr) : undefined;
      if (maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd <= 0)) {
        throw new Error(`memex eval-probe: invalid --max-usd ${maxUsdStr}`);
      }
      const probeOpts: Parameters<typeof runEvalProbe>[0] = {};
      if (limit !== undefined) probeOpts.limit = limit;
      if (maxUsd !== undefined) probeOpts.maxUsd = maxUsd;
      await runEvalProbe(probeOpts);
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
    case "salience": {
      // A flag with no value parses as a bare flag — reject it rather than
      // silently ignoring the filter the user thought they applied.
      for (const f of ["--type", "--days", "--limit"]) {
        if (flags.has(f)) {
          console.error(`memex salience: ${f} requires a value`);
          return 1;
        }
      }
      const typeStr = values.get("--type");
      const daysStr = values.get("--days");
      const limitStr = values.get("--limit");
      const opts: Parameters<typeof runSalience>[0] = {};
      if (typeStr) opts.type = typeStr;
      if (daysStr !== undefined) {
        const n = Number(daysStr);
        if (!Number.isInteger(n) || n < 0 || n > 36500) {
          throw new Error(`memex salience: invalid --days ${daysStr}`);
        }
        opts.days = n;
      }
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n < 1 || n > 200) {
          throw new Error(`memex salience: invalid --limit ${limitStr}`);
        }
        opts.limit = n;
      }
      await runSalience(opts);
      return 0;
    }
    case "watch": {
      if (flags.has("--help") || flags.has("-h")) {
        const { WATCH_HELP } = await import("./commands/watch.ts");
        process.stdout.write(WATCH_HELP);
        return 0;
      }
      const opts: Parameters<typeof runWatch>[0] = { json: flags.has("--json") };
      const wt = values.get("--window-turns");
      const mp = values.get("--max-pages");
      const mc = values.get("--min-confidence");
      if (wt !== undefined) {
        const n = Number(wt);
        if (!Number.isInteger(n) || n < 1) throw new Error(`memex watch: invalid --window-turns ${wt}`);
        opts.windowTurns = n;
      }
      if (mp !== undefined) {
        const n = Number(mp);
        if (!Number.isInteger(n) || n < 1) throw new Error(`memex watch: invalid --max-pages ${mp}`);
        opts.maxPages = n;
      }
      if (mc !== undefined) {
        const n = Number(mc);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`memex watch: invalid --min-confidence ${mc}`);
        opts.minConfidence = n;
      }
      await runWatch(opts);
      return 0;
    }
    case "cycle": {
      const phasesStr = values.get("--phases");
      const staleStr = values.get("--stale-days");
      for (const f of ["--phases", "--stale-days"]) {
        if (flags.has(f)) {
          console.error(`memex cycle: ${f} requires a value`);
          return 1;
        }
      }
      const opts: Parameters<typeof runCycle>[0] = {};
      // Call parsePhasesArg whenever --phases was given (even ""), so an empty
      // value fails loud rather than silently defaulting to ALL phases.
      if (phasesStr !== undefined) opts.phases = parsePhasesArg(phasesStr);
      if (staleStr !== undefined) {
        const n = Number(staleStr);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`memex cycle: invalid --stale-days ${staleStr}`);
        }
        opts.staleDays = n;
      }
      await runCycle(opts);
      return 0;
    }
    case "extract": {
      if (flags.has("--stale")) {
        const sourceId = values.get("--source-id");
        await runExtract({
          stale: true,
          dryRun: flags.has("--dry-run"),
          json: flags.has("--json"),
          catchUp: flags.has("--catch-up"),
          sourceIds: sourceId ? [sourceId] : undefined,
        });
        return 0;
      }
      const all = flags.has("--all");
      const vault = values.get("--vault");
      await runExtract(vault ? { all, vault } : { all });
      return 0;
    }
    case "extract-conversation-facts": {
      const file = positional[0] ?? values.get("--file");
      if (!file) {
        console.error(
          "memex extract-conversation-facts: <transcript-file> is required",
        );
        return 1;
      }
      const budgetStr = values.get("--budget");
      const args: Parameters<typeof runExtractConversationFactsCli>[0] = {
        file,
        json: flags.has("--json"),
      };
      const sourceSlug = values.get("--source-slug");
      if (sourceSlug) args.sourceSlug = sourceSlug;
      const dateContext = values.get("--date-context");
      if (dateContext) args.dateContext = dateContext;
      if (budgetStr !== undefined) {
        const n = Number(budgetStr);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(
            `memex extract-conversation-facts: invalid --budget ${budgetStr}`,
          );
        }
        args.maxBudgetUsd = n;
      }
      await runExtractConversationFactsCli(args);
      return 0;
    }
    case "think": {
      const question = positional.join(" ").trim() || values.get("--question");
      if (!question) {
        console.error("memex think: a <question> is required");
        return 1;
      }
      const args: Parameters<typeof runThinkCli>[0] = {
        question,
        json: flags.has("--json"),
      };
      const kStr = values.get("--k");
      if (kStr !== undefined) {
        const n = Number(kStr);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          throw new Error(`memex think: invalid --k ${kStr}`);
        }
        args.k = n;
      }
      const budgetStr = values.get("--budget");
      if (budgetStr !== undefined) {
        const n = Number(budgetStr);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`memex think: invalid --budget ${budgetStr}`);
        }
        args.maxBudgetUsd = n;
      }
      // Persistence + gather knobs (map 1:1 onto ThinkOptions).
      if (flags.has("--save")) args.save = true;
      const takeClaim = values.get("--take");
      if (takeClaim !== undefined) args.take = takeClaim;
      const sinceStr = values.get("--since");
      if (sinceStr) args.since = sinceStr;
      const untilStr = values.get("--until");
      if (untilStr) args.until = untilStr;
      const anchorStr = values.get("--anchor");
      if (anchorStr) {
        args.anchors = anchorStr.split(",").map((s) => s.trim()).filter(Boolean);
      }
      const roundsStr = values.get("--rounds");
      if (roundsStr !== undefined) {
        const n = Number(roundsStr);
        if (!Number.isInteger(n) || n < 1 || n > 3) {
          throw new Error(`memex think: invalid --rounds ${roundsStr} (1..3)`);
        }
        args.rounds = n;
      }
      const modelStr = values.get("--model");
      if (modelStr) args.modelId = modelStr;
      if (flags.has("--with-calibration")) args.withCalibration = true;
      await runThinkCli(args);
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
    case "export": {
      const opts: Parameters<typeof runExport>[0] = {};
      const dir = values.get("--dir");
      if (dir) opts.dir = dir;
      const src = values.get("--source");
      if (src) opts.sourceIds = src.split(",").map((s) => s.trim()).filter(Boolean);
      await runExport(opts);
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
      // Targeting (G51): positional slug(s) and/or --slugs CSV re-embed those
      // pages; --all re-embeds the whole embeddable corpus; --stale also
      // refreshes signature-stale rows; --source scopes any of the above.
      const slugSet = [
        ...positional,
        ...(values.get("--slugs")?.split(",") ?? []),
      ]
        .map((s) => s.trim())
        .filter(Boolean);
      if (slugSet.length > 0) opts.slugs = slugSet;
      if (flags.has("--all")) opts.all = true;
      if (flags.has("--stale")) opts.stale = true;
      const embedSource = values.get("--source");
      if (embedSource) opts.sourceId = embedSource;
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
        sub !== "show" &&
        sub !== "submit" &&
        sub !== "progress" &&
        sub !== "remove" &&
        sub !== "prune" &&
        sub !== "smoke"
      ) {
        console.error(
          `memex jobs: subcommand required (list|stats|show|retry|cancel|submit|progress|remove|prune|smoke)`,
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
      } else if (
        sub === "show" ||
        sub === "retry" ||
        sub === "cancel" ||
        sub === "progress" ||
        sub === "remove"
      ) {
        const id = positional[1];
        if (!id) {
          console.error(`memex jobs ${sub}: <id> is required`);
          return 1;
        }
        opts.id = id;
      } else if (sub === "submit") {
        const kind = positional[1];
        if (!kind) {
          console.error("memex jobs submit: <kind> is required");
          return 1;
        }
        opts.kind = kind;
        const id = values.get("--id");
        if (id) opts.id = id;
        const prio = values.get("--priority");
        if (prio !== undefined) {
          const n = Number(prio);
          if (!Number.isInteger(n) || n < 1 || n > 10) {
            throw new Error(`memex jobs submit: invalid --priority ${prio}`);
          }
          opts.priority = n;
        }
        const retries = values.get("--max-retries");
        if (retries !== undefined) {
          const n = Number(retries);
          if (!Number.isInteger(n) || n < 0 || n > 100) {
            throw new Error(`memex jobs submit: invalid --max-retries ${retries}`);
          }
          opts.maxRetries = n;
        }
        const payloadJson = values.get("--payload");
        if (payloadJson !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payloadJson);
          } catch {
            throw new Error("memex jobs submit: --payload must be valid JSON");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("memex jobs submit: --payload must be a JSON object");
          }
          opts.payload = parsed as Record<string, unknown>;
        }
      } else if (sub === "prune") {
        const days = values.get("--older-than-days");
        if (days !== undefined) {
          const n = Number(days);
          if (!Number.isFinite(n) || n < 0 || n > 3650) {
            throw new Error(`memex jobs prune: invalid --older-than-days ${days}`);
          }
          opts.olderThanDays = n;
        }
        const statusStr = values.get("--status");
        if (statusStr) {
          const parts = statusStr.split(",").map((s) => s.trim());
          for (const p of parts) {
            if (!VALID_JOB_STATUSES.has(p as JobStatus)) {
              throw new Error(`memex jobs prune: invalid --status '${p}'`);
            }
          }
          opts.status = parts as JobStatus[];
        }
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
      const lintOpts: Parameters<typeof runLint>[0] = {};
      // Accept the target in either order relative to the bare flags: a value
      // swallowed by `--fix <target>` is still the target.
      const target = positional[0] ?? values.get("--fix") ?? values.get("--dry-run");
      if (target) lintOpts.target = target;
      if (flags.has("--fix") || values.has("--fix")) lintOpts.fix = true;
      if (flags.has("--dry-run") || values.has("--dry-run")) lintOpts.dryRun = true;
      await runLint(lintOpts);
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
    case "tenant": {
      const sub = positional[0];
      if (sub !== "add" && sub !== "grant" && sub !== "list" && sub !== "revoke") {
        console.error("memex tenant: subcommand required (add|grant|list|revoke)");
        return 1;
      }
      const opts: Parameters<typeof runTenant>[0] = { sub: sub as TenantSub };
      if (sub === "add") {
        opts.id = positional[1];
        const name = values.get("--name");
        if (name) opts.name = name;
      } else if (sub === "grant") {
        opts.sub_jwt = positional[1];
        opts.source = values.get("--source");
        const readStr = values.get("--read");
        if (readStr) opts.read = readStr.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (sub === "revoke") {
        opts.sub_jwt = positional[1];
      }
      await runTenant(opts);
      return 0;
    }
    case "auth": {
      // Self-issued OAuth 2.1 provider management. Re-parses its own raw flags
      // (--grant-types/--scopes/--source/--federated-read), so pass the raw tail.
      await runAuth(argv.slice(1));
      return 0;
    }
    case "search": {
      // `search modes` — read-only ranking-config view (no query, no storage).
      if (positional.length === 1 && positional[0] === "modes") {
        runSearchModes();
        return 0;
      }
      // `search stats|tune|diagnose` — telemetry dashboard / recommendation
      // loop / arm-by-arm probe, NOT a free-text search for those words.
      // stats/tune only claim the EXACT single token (a query like
      // "stats about x" stays a search); diagnose owns its tail (the query).
      if (positional.length === 1 && positional[0] === "stats") {
        const daysStr = values.get("--days");
        const opts: Parameters<typeof runSearchStats>[0] = {};
        if (daysStr !== undefined) {
          const n = Number(daysStr);
          if (!Number.isInteger(n) || n < 1 || n > 365) {
            throw new Error(`memex search stats: invalid --days ${daysStr}`);
          }
          opts.days = n;
        }
        if (flags.has("--json")) opts.json = true;
        return await runSearchStats(opts);
      }
      if (positional.length === 1 && positional[0] === "tune") {
        const opts: Parameters<typeof runSearchTune>[0] = {};
        if (flags.has("--apply")) opts.apply = true;
        if (flags.has("--json")) opts.json = true;
        return await runSearchTune(opts);
      }
      if (positional[0] === "diagnose") {
        const target = values.get("--target");
        if (!target) {
          console.error(
            'memex search diagnose: --target <slug> is required (usage: search diagnose "<query>" --target <slug>)',
          );
          return 2;
        }
        const diagOpts: Parameters<typeof runSearchDiagnose>[0] = {
          query: positional.slice(1).join(" "),
          target,
        };
        const src = values.get("--source");
        if (src) diagOpts.sourceId = src;
        if (flags.has("--json")) diagOpts.json = true;
        return await runSearchDiagnose(diagOpts);
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
      await runSearch({
        query,
        ...(k !== undefined ? { k } : {}),
        ...(flags.has("--explain") ? { explain: true } : {}),
      });
      return 0;
    }
    case "config": {
      const sub = positional[0];
      if (sub !== "show" && sub !== "get" && sub !== "set" && sub !== "unset") {
        console.error("memex config: subcommand required (show|get|set|unset)");
        return 1;
      }
      const opts: Parameters<typeof runConfig>[0] = { sub: sub as ConfigSub };
      if (sub === "get" || sub === "unset") {
        if (positional[1]) opts.key = positional[1];
      }
      if (sub === "set") {
        opts.key = positional[1];
        opts.value = positional[2];
        if (flags.has("--force")) opts.force = true;
      }
      if (sub === "unset") {
        const pattern = values.get("--pattern");
        if (pattern !== undefined) opts.pattern = pattern;
      }
      return await runConfig(opts);
    }
    case "capture": {
      const opts: Parameters<typeof runCapture>[0] = {};
      const inline = positional.join(" ").trim();
      if (inline) opts.text = inline;
      if (flags.has("--stdin")) opts.stdin = true;
      const file = values.get("--file");
      if (file) opts.file = file;
      const slug = values.get("--slug");
      if (slug) opts.slug = slug;
      const type = values.get("--type");
      if (type) opts.type = type;
      const src = values.get("--source");
      if (src) opts.sourceId = src;
      const title = values.get("--title");
      if (title) opts.title = title;
      if (flags.has("--json")) opts.json = true;
      return await runCapture(opts);
    }
    case "quarantine": {
      const sub = positional[0];
      if (sub !== "list" && sub !== "clear" && sub !== "scan") {
        console.error("memex quarantine: subcommand required (list|clear|scan)");
        return 1;
      }
      const opts: Parameters<typeof runQuarantine>[0] = {
        sub: sub as QuarantineSub,
      };
      if (sub === "clear") {
        const target = positional[1];
        if (!target) {
          console.error("memex quarantine clear: <slug|source_path> is required");
          return 1;
        }
        opts.target = target;
        if (flags.has("--force")) opts.force = true;
      }
      if (sub === "list" && flags.has("--include-flagged")) opts.includeFlagged = true;
      if (sub === "scan") {
        if (flags.has("--apply")) opts.apply = true;
        const limitStr = values.get("--limit");
        if (limitStr !== undefined) {
          const n = Number(limitStr);
          if (!Number.isInteger(n) || n < 1) {
            throw new Error(`memex quarantine scan: invalid --limit ${limitStr}`);
          }
          opts.limit = n;
        }
      }
      if (flags.has("--json")) opts.json = true;
      return await runQuarantine(opts);
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
