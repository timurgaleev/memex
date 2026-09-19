/**
 * `memex skillopt eval [--skill <slug>] [--split heldout|train|all]
 *   [--repeats N] [--candidate <SKILL.md>] [--epsilon X] [--max-usd X]`
 *
 * Measures how well the Haiku tier routes the pack's benchmark intents to the
 * right skill, per split, as the median of N repeats. With --candidate it also
 * scores that file's description and triggers against the current ones on the
 * held-out cases and prints ACCEPT or REJECT (exit 3) against epsilon.
 *
 * Operator-only and read-only: it writes no rows, no skill files and no pages.
 * Its only side effect is the paid calls, each booked in mcp_spend_log under
 * the `skillopt` label. Off unless MEMEX_SKILLOPT_ENABLED=1; the run is capped
 * at MEMEX_SKILLOPT_MAX_USD (default $0.25), which --max-usd can lower but not
 * raise, and a run whose worst case exceeds the cap is refused before any
 * storage is opened or call is made.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import type { ConverseFn } from "../core/llm/converse.ts";
import { resolveModel } from "../core/llm/resolve-model.ts";
import { DEFAULT_SKILLS_DIR } from "../core/skillpack/brain-resident.ts";
import {
  isSkillSlug,
  listBenchmarkSkills,
  loadPackBenchmark,
  loadSkillBenchmark,
  type RoutingCase,
  type Split,
} from "../core/skillopt/benchmark.ts";
import {
  buildCatalog,
  candidateName,
  readCandidateFile,
  withCandidate,
} from "../core/skillopt/catalog.ts";
import {
  DEFAULT_SKILLOPT_EPSILON,
  DEFAULT_SKILLOPT_REPEATS,
  MAX_SKILLOPT_REPEATS,
  heldoutGate,
  preflightUsd,
  runRoutingEval,
  skilloptEnabled,
  skilloptMaxUsd,
  summarize,
  type EvalResult,
  type Variant,
} from "../core/skillopt/evaluate.ts";
import { withStorage } from "./with-storage.ts";

/** Exit code for a candidate the gate did not accept. */
export const SKILLOPT_EXIT_REJECT = 3;

export interface SkilloptCliOptions {
  sub: string | undefined;
  skill?: string;
  split?: string;
  repeats?: string;
  candidate?: string;
  epsilon?: string;
  maxUsd?: string;
  /** Test seams. */
  enabled?: string | undefined;
  maxUsdEnv?: string | undefined;
  skillsDir?: string;
  makeStorage?: () => Storage;
  converse?: ConverseFn;
  modelId?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

type SplitArg = Split | "all";

interface Parsed {
  split: SplitArg;
  repeats: number;
  epsilon: number;
  maxUsd: number;
}

function parseArgs(opts: SkilloptCliOptions, envCap: number): Parsed | string {
  const split = opts.split ?? (opts.candidate !== undefined ? "heldout" : "all");
  if (split !== "heldout" && split !== "train" && split !== "all") {
    return `invalid --split ${split} (expected heldout, train or all)`;
  }
  if (opts.candidate !== undefined && split !== "heldout") {
    return "--candidate is gated on the held-out split; drop --split or pass --split heldout";
  }
  const repeats = opts.repeats === undefined ? DEFAULT_SKILLOPT_REPEATS : Number(opts.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_SKILLOPT_REPEATS) {
    return `invalid --repeats ${opts.repeats} (expected an integer 1..${MAX_SKILLOPT_REPEATS})`;
  }
  const epsilon = opts.epsilon === undefined ? DEFAULT_SKILLOPT_EPSILON : Number(opts.epsilon);
  if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon >= 1) {
    return `invalid --epsilon ${opts.epsilon} (expected a number in [0, 1))`;
  }
  let maxUsd = envCap;
  if (opts.maxUsd !== undefined) {
    const n = Number(opts.maxUsd);
    if (!Number.isFinite(n) || n <= 0) return `invalid --max-usd ${opts.maxUsd}`;
    maxUsd = Math.min(n, envCap);
  }
  return { split, repeats, epsilon, maxUsd };
}

const pct = (n: number): string => n.toFixed(3);
const usd = (n: number): string => `$${n.toFixed(4)}`;

function report(
  out: (l: string) => void,
  result: EvalResult,
  cases: readonly RoutingCase[],
  splits: readonly Split[],
  variants: readonly Variant["name"][],
): void {
  const skills = [...new Set(cases.map((c) => c.skill))].sort();
  for (const variant of variants) {
    for (const skill of skills) {
      const cols = splits.map((split) => {
        const s = summarize(result.rollouts, variant, split, skill);
        const n = cases.filter((c) => c.skill === skill && c.split === split).length;
        return s.perRepeat.length === 0
          ? `${split} - (n=${n})`
          : `${split} ${pct(s.median)} [${s.perRepeat.map(pct).join(" ")}] (n=${n})`;
      });
      out(`${variant}  ${skill}  ${cols.join("  ")}`);
    }
    const overall = splits.map((split) => {
      const s = summarize(result.rollouts, variant, split);
      return `${split} ${s.perRepeat.length === 0 ? "-" : pct(s.median)}`;
    });
    out(`${variant}  median-of-${new Set(result.rollouts.map((r) => r.repeat)).size}  ${overall.join("  ")}`);
  }
  const unparsed = result.rollouts.filter((r) => r.verdict === "unparsed").length;
  const alt = result.rollouts.filter((r) => r.verdict === "ambiguous_alt").length;
  out(`answers: ${result.rollouts.length}  ambiguous_alt ${alt}  unparsed ${unparsed}`);
  out(
    `spend ${usd(result.spentUsd)} of cap ${usd(result.maxUsd)} (worst case ${usd(result.preflightUsd ?? 0)})` +
      `  calls ${result.calls}  stop_reason ${result.stopReason}`,
  );
}

export async function runSkilloptCli(opts: SkilloptCliOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const err = opts.err ?? ((l: string) => console.error(l));
  const enabled = "enabled" in opts ? opts.enabled : process.env.MEMEX_SKILLOPT_ENABLED;
  const envCap = skilloptMaxUsd("maxUsdEnv" in opts ? opts.maxUsdEnv : process.env.MEMEX_SKILLOPT_MAX_USD);
  const fail = (msg: string): number => {
    err(`memex skillopt eval: ${msg}`);
    return 1;
  };

  if (opts.sub !== "eval") {
    err(`memex skillopt: unknown subcommand '${opts.sub ?? ""}' (expected: eval)`);
    return 1;
  }
  if (!skilloptEnabled(enabled)) {
    return fail("skill optimization is off; set MEMEX_SKILLOPT_ENABLED=1 first");
  }
  const parsed = parseArgs(opts, envCap);
  if (typeof parsed === "string") return fail(parsed);

  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const available = listBenchmarkSkills(skillsDir);

  let candidateText: string | undefined;
  let target = opts.skill;
  if (opts.candidate !== undefined) {
    try {
      candidateText = readCandidateFile(opts.candidate);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    target ??= candidateName(candidateText) ?? undefined;
    if (target === undefined) return fail("--candidate has no frontmatter name; pass --skill");
  }
  if (target !== undefined && (!isSkillSlug(target) || !available.includes(target))) {
    return fail(`no benchmark for skill '${target}'; skills with one: ${available.join(", ")}`);
  }

  const load = target !== undefined ? loadSkillBenchmark(skillsDir, target) : loadPackBenchmark(skillsDir);
  if (load.errors.length > 0) {
    for (const e of load.errors) err(`  ${e}`);
    return fail(`${load.errors.length} benchmark error(s); fix them first`);
  }
  const cases = load.cases.filter((c) => parsed.split === "all" || c.split === parsed.split);
  if (cases.length === 0) return fail("no benchmark cases in scope");

  const catalog = buildCatalog(skillsDir);
  if (catalog.length === 0) return fail(`no skills found in ${skillsDir}`);
  const variants: Variant[] = [{ name: "baseline", catalog }];
  if (candidateText !== undefined) {
    try {
      variants.push({ name: "candidate", catalog: withCandidate(catalog, target!, candidateText) });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  const modelId = resolveModel("utility", opts.modelId);
  const worst = preflightUsd(modelId, cases, variants, parsed.repeats);
  if (worst === null) return fail(`model '${modelId}' has no price; refusing to spend against it`);
  if (worst > parsed.maxUsd) {
    return fail(
      `worst case ${usd(worst)} for ${cases.length} case(s) x ${parsed.repeats} repeat(s) x ` +
        `${variants.length} variant(s) exceeds the cap ${usd(parsed.maxUsd)}; ` +
        "narrow it with --skill, --split or --repeats, or raise MEMEX_SKILLOPT_MAX_USD",
    );
  }

  const storage = opts.makeStorage ? opts.makeStorage() : new Storage(loadConfig());
  // Storage is opened only so the spend ledger books each call.
  const result = await withStorage(storage, () =>
    runRoutingEval({
      cases,
      variants,
      repeats: parsed.repeats,
      maxUsd: parsed.maxUsd,
      modelId,
      ...(opts.converse ? { converse: opts.converse } : {}),
    }),
  );

  const splits: Split[] = parsed.split === "all" ? ["train", "heldout"] : [parsed.split];
  out(
    `skillopt eval  model ${result.modelId}  cases ${cases.length}  repeats ${parsed.repeats}` +
      `${target !== undefined ? `  skill ${target}` : ""}`,
  );
  report(out, result, cases, splits, variants.map((v) => v.name));
  if (result.stopReason === "preflight_refused") return 1;
  if (candidateText === undefined) return 0;

  const verdict = heldoutGate(result, parsed.epsilon);
  if (!verdict) {
    out(`gate: REJECT (no verdict: the run ended with stop_reason ${result.stopReason})`);
    return SKILLOPT_EXIT_REJECT;
  }
  const sign = verdict.delta >= 0 ? "+" : "";
  out(
    `gate: ${verdict.accept ? "ACCEPT" : "REJECT"}  candidate ${pct(verdict.candidateMedian)} vs ` +
      `baseline ${pct(verdict.baselineMedian)}  delta ${sign}${pct(verdict.delta)}  epsilon ${pct(parsed.epsilon)}`,
  );
  return verdict.accept ? 0 : SKILLOPT_EXIT_REJECT;
}
