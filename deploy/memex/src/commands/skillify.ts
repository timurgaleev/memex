/**
 * `memex skillify <prompt>` — generate a skill `*.md` from a one-line
 * prompt. Default behaviour writes to `deploy/skills/<slug>.md` relative
 * to the memex repo root; use `--out PATH` to override or `--dry-run`
 * to emit on stdout only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { skillify, validateSkill } from "../core/skillify.ts";

export interface SkillifyCmdOptions {
  prompt: string;
  /** Override slug; default is slugify(prompt). */
  slug?: string;
  /** Override output path (must end in .md). */
  out?: string;
  /** Print to stdout instead of writing. */
  dryRun?: boolean;
  /** Default skills directory if --out is not given. */
  skillsDir?: string;
}

export interface SkillifyCheckOptions {
  slug: string;
  skillsDir?: string;
  /** When true, warnings flip the exit code as well as errors. */
  strict?: boolean;
}

const DEFAULT_SKILLS_DIR =
  process.env.SKILLIFY_SKILLS_DIR ?? "deploy/skills";

export async function runSkillify(opts: SkillifyCmdOptions): Promise<void> {
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error("memex skillify: <prompt> is required");
  }
  const skillifyOpts: Parameters<typeof skillify>[1] = {};
  if (opts.slug) skillifyOpts.slug = opts.slug;
  const result = await skillify(opts.prompt, skillifyOpts);

  if (opts.dryRun) {
    console.log(result.markdown);
    if (result.issues.length > 0) {
      console.error(
        `[skillify] linter repaired: ${result.issues.join(", ")}`,
      );
    }
    return;
  }

  const target = resolve(
    opts.out ?? join(opts.skillsDir ?? DEFAULT_SKILLS_DIR, `${result.slug}.md`),
  );
  if (existsSync(target)) {
    throw new Error(
      `memex skillify: refusing to overwrite ${target} (delete it first or pass --out for a different path)`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, result.markdown, { mode: 0o644 });
  console.log(
    JSON.stringify(
      { ok: true, path: target, slug: result.slug, issues: result.issues },
      null,
      2,
    ),
  );
}

/**
 * Validate an existing skill markdown against the contract. No LLM,
 * no rewrite — pure check. Exit code is 0 unless errors are present
 * (or `strict` is true and any warnings exist).
 */
export async function runSkillifyCheck(
  opts: SkillifyCheckOptions,
): Promise<void> {
  if (!opts.slug) {
    throw new Error("memex skillify check: <slug> is required");
  }
  const target = resolve(
    join(opts.skillsDir ?? DEFAULT_SKILLS_DIR, `${opts.slug}.md`),
  );
  if (!existsSync(target)) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          slug: opts.slug,
          path: target,
          issues: [
            {
              rule: "file-missing",
              severity: "error",
              message: `skill file not found at ${target}`,
            },
          ],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const md = readFileSync(target, "utf8");
  const report = validateSkill(md, opts.slug);
  const hasWarning = report.issues.some((i) => i.severity === "warning");
  const ok = report.ok && (!opts.strict || !hasWarning);
  console.log(
    JSON.stringify(
      {
        ok,
        slug: opts.slug,
        path: target,
        ...(opts.strict ? { strict: true } : {}),
        issues: report.issues,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}
