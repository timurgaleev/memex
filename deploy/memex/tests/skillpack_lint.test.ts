/**
 * The pack honesty lint: every tool a skill declares and every `memex`
 * command it tells an agent to run must exist — and the shipped pack passes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lintAndShape, validateSkill } from "../src/core/skillify.ts";
import { extractCliReferences, extractToolCalls, lintSkillpack } from "../src/core/skillpack/lint.ts";

const MEMEX_DIR = resolve(import.meta.dir, "..");
const PACK_DIR = resolve(MEMEX_DIR, "..", "skills");
const FENCE = "```";

function skill(name: string, tools: string, body: string): string {
  return `---\nname: ${name}\ndescription: d\ntriggers:\n  - "t"\ntools: ${tools}\n---\n\n# ${name}\n\n${body}\n`;
}

let root: string;

function writePack(dir: string, files: Record<string, string>): string {
  const packDir = join(root, dir);
  for (const [rel, text] of Object.entries(files)) {
    const file = join(packDir, rel);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return packDir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "skillpack-lint-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lintSkillpack", () => {
  it("names the skill and the tool that does not exist", () => {
    const dir = writePack("tools", {
      "alpha/SKILL.md": skill("alpha", "[page_get, not_a_tool]", "Body."),
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(false);
    expect(r.skills).toBe(1);
    expect(r.issues).toEqual([
      { slug: "alpha", rule: "unknown-tool", detail: "not_a_tool", line: 6 },
    ]);
  });

  it("flags a dead subcommand and a dead command", () => {
    const dir = writePack("cli", {
      "beta/SKILL.md": skill(
        "beta",
        "[page_get]",
        `Run \`memex skillpack check\` first.\n\n${FENCE}bash\nmemex frobnicate --all\n${FENCE}`,
      ),
    });
    const rules = lintSkillpack(dir).issues.map((i) => `${i.rule} ${i.detail} @${i.line}`);
    expect(rules).toEqual([
      "unknown-cli-subcommand memex skillpack check @11",
      "unknown-cli-command memex frobnicate @14",
    ]);
  });

  it("accepts real commands, flags, placeholders and prose mentions", () => {
    const dir = writePack("clean", {
      "gamma/SKILL.md": skill(
        "gamma",
        "[search, page_get]",
        [
          "Use `memex doctor --json`, `memex search modes`, `memex <cmd>`.",
          "`memex search \"what do we know\"` and `memex jobs submit <kind>`.",
          "In prose, memex frobnicate is not a command to run.",
          `${FENCE}bash`,
          "memex eval gate --max-drop 0.02   # memex bogus in a comment",
          "/opt/memex/bin/memex status",
          `${FENCE}`,
          "Fix: `memex doctor`, then continue.",
        ].join("\n"),
      ),
    });
    expect(lintSkillpack(dir)).toEqual({ ok: true, skills: 1, issues: [] });
  });

  it("checks name, frontmatter and scans shared docs for commands only", () => {
    const dir = writePack("shared", {
      "delta/SKILL.md": skill("not-delta", "[page_get]", "Body."),
      "epsilon/SKILL.md": "# no frontmatter\n",
      "_rules.md": "Run `memex skillpack harvest`.\n",
      "conventions/c.md": "---\ntools: [not_a_tool]\n---\nRun `memex eval skillopt x`.\n",
      "flat.md": skill("flat", "[page_get]", "Body."),
    });
    const r = lintSkillpack(dir);
    expect(r.skills).toBe(3);
    expect(r.issues.map((i) => `${i.slug} ${i.rule}`)).toEqual([
      "_rules.md unknown-cli-subcommand",
      "conventions/c.md unknown-cli-subcommand",
      "delta name-mismatch",
      "epsilon frontmatter-missing",
    ]);
  });

  it("checks a tools list written at column 0", () => {
    const dir = writePack("column-zero", {
      "zeta/SKILL.md": "---\nname: zeta\ndescription: d\ntriggers:\n- \"t\"\ntools:\n- page_get\n- not_a_tool\n---\n\n# zeta\n\nBody.\n",
    });
    expect(lintSkillpack(dir).issues).toEqual([
      { slug: "zeta", rule: "unknown-tool", detail: "not_a_tool", line: 6 },
    ]);
  });

  it("passes a skill drafted by memex skillify", () => {
    const draft = "---\ntitle: drifted\ndescription: Recap recent workouts.\ntags: [fitness]\ntools: [search, not_a_tool]\n---\n\n# Recap\n\nRun `memex search workout` and summarise the hits.\n";
    const shaped = lintAndShape(draft, "workout-recap", "recap my workouts");
    const scaffolded = lintAndShape("nothing useful", "empty-draft", "summarise workouts");
    const dir = writePack("skillify", {
      "workout-recap.md": shaped.markdown,
      "empty-draft.md": scaffolded.markdown,
    });
    expect(lintSkillpack(dir)).toEqual({ ok: true, skills: 2, issues: [] });
    expect(validateSkill(shaped.markdown, "workout-recap").issues).toEqual([]);
  });

  it("flags undeclared argument keys in tool-call examples", () => {
    const dir = writePack("tool-args", {
      "iota/SKILL.md": skill(
        "iota",
        "[search, page_put]",
        [
          `${FENCE}`,
          `search  {"q": "x", "limit": 5}     # "limit" is not a search param`,
          `page_put {"slug": "a/b", "compiled_truth": {"content": 1}, "content": [...]}`,
          `${FENCE}`,
          "Or inline: `search {\"query\": \"x\"}`.",
          `${FENCE}bash`,
          `memex call search '{"q":"x","k":5,"limt":5}'`,
          "memex call not_a_tool '{}'",
          `${FENCE}`,
        ].join("\n"),
      ),
    });
    const rules = lintSkillpack(dir).issues.map((i) => `${i.rule} ${i.detail} @${i.line}`);
    expect(rules).toEqual([
      "unknown-tool-arg search limit @12",
      "unknown-tool-arg page_put content @13",
      "unknown-tool-arg search query @15",
      "unknown-tool-arg search limt @17",
      "unknown-call-tool memex call not_a_tool @18",
    ]);
  });

  it("accepts declared keys, placeholders and non-call braces", () => {
    const dir = writePack("tool-args-clean", {
      "kappa/SKILL.md": skill(
        "kappa",
        "[jobs_submit, jobs_get]",
        [
          `${FENCE}`,
          `jobs_submit {"kind":"<registered kind>","payload":{"anything":1}}`,
          `jobs_get    {"id":ID}`,
          `memex call jobs_get '{...}'`,
          `memex call <tool> '<args>'`,
          `const x = {"not": "a call"};`,
          `${FENCE}`,
        ].join("\n"),
      ),
    });
    expect(lintSkillpack(dir)).toEqual({ ok: true, skills: 1, issues: [] });
  });

  it("reports a SKILL.md it cannot read instead of skipping it", () => {
    const dir = writePack("unreadable", {
      "lambda/SKILL.md/placeholder": "x",
      "mu/SKILL.md": skill("mu", "[page_get]", "Body."),
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(false);
    expect(r.skills).toBe(2);
    expect(r.issues).toEqual([{ slug: "lambda", rule: "unreadable", detail: "EISDIR", line: 1 }]);
  });

  it("passes on the shipped pack", () => {
    const r = lintSkillpack(PACK_DIR);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.skills).toBeGreaterThan(40);
  });
});

describe("extractCliReferences cost", () => {
  function best(text: string): number {
    const runs = [0, 1, 2].map(() => {
      const started = performance.now();
      extractCliReferences(text);
      return performance.now() - started;
    });
    return Math.min(...runs);
  }

  it("stays linear on repeated backtick-memex fragments", () => {
    const build = (k: number): string => "`memex ".repeat(2 ** k);
    const small = best(build(17));
    const large = best(build(18));
    expect(large / Math.max(small, 0.05)).toBeLessThan(3);
  }, 60_000);

  it("stays linear on backtick runs of mixed lengths that never pair", () => {
    const build = (n: number): string =>
      Array.from({ length: n }, (_, i) => `${"`".repeat((i % 50) + 1)}memex doctor `).join("");
    const small = best(build(20_000));
    const large = best(build(40_000));
    expect(large / Math.max(small, 0.05)).toBeLessThan(3);
  }, 60_000);
});

describe("extractToolCalls cost", () => {
  const ops = new Set(["search"]);
  function best(text: string): number {
    const runs = [0, 1, 2].map(() => {
      const started = performance.now();
      extractToolCalls(`${FENCE}\n${text}\n${FENCE}`, ops);
      return performance.now() - started;
    });
    return Math.min(...runs);
  }

  it("stays linear on nested tool-call objects that never close", () => {
    const build = (k: number): string => "search {\"q\": ".repeat(2 ** k);
    const small = best(build(15));
    const large = best(build(16));
    expect(large / Math.max(small, 0.05)).toBeLessThan(3);
  }, 60_000);

  it("stays linear on braces separated by whitespace and memex call fragments", () => {
    const build = (k: number): string => "memex call search '{ \"q\" ".repeat(2 ** k);
    const small = best(build(15));
    const large = best(build(16));
    expect(large / Math.max(small, 0.05)).toBeLessThan(3);
  }, 60_000);
});

describe("memex skillpack lint (CLI)", () => {
  function run(dir: string, json: boolean): { status: number | null; stdout: string } {
    const args = ["run", "src/cli.ts", "skillpack", "lint", "--dir", dir];
    if (json) args.push("--json");
    const r = spawnSync("bun", args, { cwd: MEMEX_DIR, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout };
  }

  it("exits 1 with parseable JSON on a bad pack and 0 on a clean one", () => {
    const bad = writePack("cli-bad", {
      "zeta/SKILL.md": skill("zeta", "[not_a_tool]", "Run `memex skillpack check`."),
    });
    const clean = writePack("cli-clean", {
      "eta/SKILL.md": skill("eta", "[page_get]", "Run `memex doctor`."),
    });

    const failing = run(bad, true);
    expect(failing.status).toBe(1);
    const parsed = JSON.parse(failing.stdout) as { ok: boolean; issues: { rule: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((i) => i.rule).sort()).toEqual([
      "unknown-cli-subcommand",
      "unknown-tool",
    ]);

    const passing = run(clean, false);
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("no issues");
  }, 60_000);
});
