/**
 * `memex skillopt eval`: refused unless MEMEX_SKILLOPT_ENABLED=1 (before any
 * storage opens), arguments validated, --max-usd clamped to the env ceiling,
 * an unknown --skill answered with the skills that have a benchmark, a
 * worst case over the cap refused before storage, and the gate verdict
 * printed with exit 3 on REJECT.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storage } from "../src/core/storage.ts";
import type { ConverseFn } from "../src/core/llm/converse.ts";
import { runSkilloptCli, SKILLOPT_EXIT_REJECT } from "../src/commands/skillopt.ts";

let dir: string;

function skill(slug: string, description: string): string {
  return `---\nname: ${slug}\ndescription: ${description}\n---\n# ${slug}\n`;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memex-skillopt-cli-"));
  mkdirSync(join(dir, "people"));
  writeFileSync(join(dir, "people", "SKILL.md"), skill("people", "Look up what the brain knows about a person"));
  const lines = Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({ intent: `who is person ${i}`, expected_skill: "people" }),
  );
  writeFileSync(join(dir, "people", "routing-eval.jsonl"), `// people\n${lines.join("\n")}\n`);
  mkdirSync(join(dir, "garden"));
  writeFileSync(join(dir, "garden", "SKILL.md"), skill("garden", "Plan a vegetable garden"));
  writeFileSync(join(dir, "degraded.md"), skill("people", "Unrelated notes about soil"));
  writeFileSync(join(dir, "renamed.md"), skill("garden", "Look up a person"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  out: string[];
  err: string[];
  opened: number;
  calls: number;
}

function harness(overrides: Record<string, unknown> = {}) {
  const h: Harness = { out: [], err: [], opened: 0, calls: 0 };
  const converse: ConverseFn = async (input) => {
    h.calls++;
    const line = input.system.split("\n").find((l) => l.startsWith("- people:")) ?? "";
    return {
      message: { role: "assistant", content: [{ text: line.includes("person") ? "people" : "garden" }] },
      stopReason: "end_turn",
      usage: { inputTokens: 300, outputTokens: 2 },
      modelId: input.modelId!,
    };
  };
  const storage = {
    init: async () => {
      h.opened++;
    },
    close: async () => {},
  } as unknown as Storage;
  const opts = {
    sub: "eval",
    enabled: "1",
    maxUsdEnv: undefined,
    skillsDir: dir,
    makeStorage: () => storage,
    converse,
    out: (l: string) => h.out.push(l),
    err: (l: string) => h.err.push(l),
    ...overrides,
  };
  return { h, opts };
}

describe("memex skillopt eval", () => {
  it("refuses unless MEMEX_SKILLOPT_ENABLED=1, before storage opens or a call is made", async () => {
    for (const enabled of [undefined, "", "0", "true"]) {
      const { h, opts } = harness({ enabled });
      expect(await runSkilloptCli(opts)).toBe(1);
      expect(h.err.join("\n")).toContain("MEMEX_SKILLOPT_ENABLED=1");
      expect(h.opened).toBe(0);
      expect(h.calls).toBe(0);
    }
  });

  it("rejects an unknown subcommand", async () => {
    const { h, opts } = harness({ sub: "run" });
    expect(await runSkilloptCli(opts)).toBe(1);
    expect(h.err[0]).toContain("expected: eval");
  });

  it("rejects invalid --repeats, --split, --epsilon and --max-usd", async () => {
    for (const bad of [
      { repeats: "0" },
      { repeats: "6" },
      { repeats: "2.5" },
      { split: "test" },
      { epsilon: "-0.1" },
      { epsilon: "1" },
      { epsilon: "abc" },
      { maxUsd: "0" },
      { maxUsd: "-1" },
      { maxUsd: "NaN" },
      { candidate: join(dir, "degraded.md"), split: "train" },
    ]) {
      const { h, opts } = harness(bad);
      expect({ bad, code: await runSkilloptCli(opts) }).toEqual({ bad, code: 1 });
      expect(h.opened).toBe(0);
    }
  });

  it("names the skills that have a benchmark when --skill has none", async () => {
    const { h, opts } = harness({ skill: "garden" });
    expect(await runSkilloptCli(opts)).toBe(1);
    expect(h.err.join("\n")).toContain("skills with one: people");
  });

  it("prints per-split accuracy, spend and stop reason for a plain eval", async () => {
    const { h, opts } = harness({ repeats: "3" });
    expect(await runSkilloptCli(opts)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("baseline  people  train 1.000 [1.000 1.000 1.000] (n=4)  heldout 1.000 [1.000 1.000 1.000] (n=2)");
    expect(text).toContain("median-of-3");
    expect(text).toMatch(/spend \$\d+\.\d{4} of cap \$0\.2500/);
    expect(text).toContain("calls 18  stop_reason end");
    expect(h.opened).toBe(1);
  });

  it("clamps --max-usd to MEMEX_SKILLOPT_MAX_USD", async () => {
    const { h, opts } = harness({ maxUsd: "5", maxUsdEnv: "0.1" });
    expect(await runSkilloptCli(opts)).toBe(0);
    expect(h.out.join("\n")).toContain("of cap $0.1000");
  });

  it("refuses a worst case over the cap before storage opens", async () => {
    const { h, opts } = harness({ maxUsd: "0.000001" });
    expect(await runSkilloptCli(opts)).toBe(1);
    expect(h.err.join("\n")).toContain("exceeds the cap");
    expect(h.opened).toBe(0);
    expect(h.calls).toBe(0);
  });

  it("exits 3 with REJECT when the candidate does worse on the held-out split", async () => {
    const { h, opts } = harness({ candidate: join(dir, "degraded.md") });
    expect(await runSkilloptCli(opts)).toBe(SKILLOPT_EXIT_REJECT);
    const text = h.out.join("\n");
    expect(text).toContain("skill people");
    expect(text).toContain("gate: REJECT  candidate 0.000 vs baseline 1.000");
    // Held-out only: 2 cases x 3 repeats x 2 variants.
    expect(h.calls).toBe(12);
  });

  it("exits 0 with ACCEPT when the candidate beats the pack's current text", async () => {
    const worse = mkdtempSync(join(tmpdir(), "memex-skillopt-cli-worse-"));
    try {
      mkdirSync(join(worse, "people"));
      writeFileSync(join(worse, "people", "SKILL.md"), skill("people", "Unrelated notes about soil"));
      writeFileSync(
        join(worse, "people", "routing-eval.jsonl"),
        JSON.stringify({ intent: "who is Ada", expected_skill: "people" }),
      );
      const good = join(worse, "good.md");
      writeFileSync(good, skill("people", "Look up a person"));
      const { h, opts } = harness({ skillsDir: worse, candidate: good });
      expect(await runSkilloptCli(opts)).toBe(0);
      expect(h.out.join("\n")).toContain("gate: ACCEPT  candidate 1.000 vs baseline 0.000");
    } finally {
      rmSync(worse, { recursive: true, force: true });
    }
  });

  it("refuses a candidate whose name is another skill", async () => {
    const { h, opts } = harness({ skill: "people", candidate: join(dir, "renamed.md") });
    expect(await runSkilloptCli(opts)).toBe(1);
    expect(h.err.join("\n")).toContain("cannot be edited");
    expect(h.opened).toBe(0);
  });
});
