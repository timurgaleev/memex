/**
 * Three model-reply / skill-file scans that squared on input the code accepts.
 *
 * All three were measured through their real entry point, never the bare
 * regex — in this codebase a pattern that reads 7.8 s in isolation can be 12 ms
 * in situ because a preceding call makes the bad input unreachable, and the
 * reverse trap is just as common.
 *
 * The ceilings below are deliberately loose. Linear runs these inputs in single
 * -digit milliseconds; quadratic needs minutes. Anything in between is a real
 * regression, and a slow CI box cannot manufacture a 10,000x miss.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSkill } from "../src/core/skillify.ts";
import { parseRelationalLlmResponse } from "../src/core/search/relational-llm.ts";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { patternsPhase } from "../src/core/synthesis/patterns.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

const CEILING_MS = 15_000;

/**
 * skillify.ts parseFrontmatter — `/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/`.
 *
 * A `\s*` that accepts `\n` sits directly in front of a lazy `[\s\S]*?`, so the
 * two could trade newlines: every split of an opening `\n` run re-walked the
 * body to end-of-input. Measured through validateSkill on `"---" + "\n"*n`:
 * 3.8 s at 125 K, 15 s at 250 K, 59 s at 500 K, 242 s at 1 MB — ratio 4.0 on a
 * doubling. A skill file is a file; nothing caps what validateSkill is handed.
 * Restricting that run to `[^\S\n]` puts 1 MB at 0.6 ms.
 */
describe("skill frontmatter scan cost", () => {
  it("stays linear on a 1 MB opening fence that never closes", () => {
    const md = "---" + "\n".repeat(1_000_000);

    const started = performance.now();
    const report = validateSkill(md, "slug");
    const elapsed = performance.now() - started;

    // Nothing in that input is frontmatter — the assertion that the scan did
    // the work rather than bailing out early.
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.rule).toBe("frontmatter-missing");
    expect(elapsed).toBeLessThan(CEILING_MS);
  }, 60_000);

  it("still parses fences with trailing spaces, tabs and CRLF", () => {
    for (const md of [
      "---\ntitle: s\ndescription: d\ntags: [a, b]\n---\n# H\n" + "x".repeat(40),
      "---   \ntitle: s\ndescription: d\ntags: [a, b]\n---   \n# H\n" + "x".repeat(40),
      "---\r\ntitle: s\r\ndescription: d\r\ntags: [a, b]\r\n---\r\n# H\r\n" + "x".repeat(40),
      "---\n\n\ntitle: s\ndescription: d\ntags: [a, b]\n\n\n---\n\n# H\n" + "x".repeat(40),
    ]) {
      const report = validateSkill(md, "s");
      expect(report.issues.map((i) => i.rule)).not.toContain("frontmatter-missing");
    }
  });

  it("still rejects what is not a frontmatter block", () => {
    for (const md of ["", "---", "no frontmatter", " ---\nk: v\n---\nb", "--\nk: v\n--\nb"]) {
      expect(validateSkill(md, "s").issues[0]?.rule).toBe("frontmatter-missing");
    }
  });
});

/**
 * relational-llm.ts fence strip — ``/```(?:json)?\s*([\s\S]*?)```/``.
 *
 * Same shape: the `\s*` overlapped the lazy body, so a whitespace run between
 * them could be split every way. The `raw.trim()` one line above does not save
 * it — the run only has to end in one non-space character to survive. Measured
 * through parseRelationalLlmResponse on ``"```" + " "*n + "x"``: 671 ms at
 * 50 K, 2.7 s at 100 K, 10 s at 200 K, 41 s at 400 K — ratio 4.0 on a doubling.
 * Dropping the `\s*` is inert because the caller trims the captured group.
 */
describe("relational-llm fence strip cost", () => {
  it("stays linear on a 400 K whitespace run that survives the trim", () => {
    for (const raw of ["```" + " ".repeat(400_000) + "x", "```json" + "\n".repeat(400_000) + "x"]) {
      const started = performance.now();
      const out = parseRelationalLlmResponse(raw);
      const elapsed = performance.now() - started;

      expect(out).toBeNull();
      expect(elapsed).toBeLessThan(CEILING_MS);
    }
  }, 60_000);

  it("still strips a fence, with and without the json tag", () => {
    const body = '{"kind":"intro","seeds":["acme"],"linkTypes":null}';
    for (const raw of [
      "```json\n" + body + "\n```",
      "```\n" + body + "\n```",
      "```json" + body + "```",
      "  ```json \n\n " + body + " \n\n ```  ",
      body,
    ]) {
      expect(parseRelationalLlmResponse(raw)?.kind).toBe("intro");
    }
  });
});

/**
 * patterns.ts array recovery — `/\[[\s\S]*\]/`.
 *
 * With no `]` anywhere in the reply, every `[` started a scan that ran to
 * end-of-input: 904 ms at 50 K chars, 3.6 s at 100 K, 14 s at 200 K, 59 s at
 * 400 K — ratio 4.0 on a doubling. Measured through patternsPhase with an
 * injected sonnetFn, the same seam the rest of the suite uses. First-`[` /
 * last-`]` picks the identical span in one pass each.
 */
describe("patterns array recovery cost", () => {
  let tmp: string;
  let storage: Storage;

  const fakeSonnet =
    (text: string): SonnetFn =>
    async () => ({
      text,
      modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 200, outputTokens: 80 },
    });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-patterns-lin-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    for (let i = 1; i <= 3; i++) {
      await putPage(storage, {
        slug: `reflections/2026-06-0${i}`,
        type: "note",
        title: `Reflection ${i}`,
        markdown_body: `Felt anxious about the deadline again today. Entry ${i}.`,
        source_id: "default",
      });
    }
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.MEMEX_PATTERNS;
    delete process.env.MEMEX_PATTERNS_BUDGET_USD;
  });

  it("stays linear on a 400 K reply of unterminated brackets", async () => {
    const started = performance.now();
    const r = await patternsPhase(storage, { sonnetFn: fakeSonnet("[".repeat(400_000)) });
    const elapsed = performance.now() - started;

    expect(r.ran).toBe(true);
    expect(r.patternsWritten).toBe(0);
    expect(elapsed).toBeLessThan(CEILING_MS);
  }, 60_000);

  it("still recovers the array out of a chatty reply", async () => {
    const payload = JSON.stringify([
      {
        topic_slug: "deadline-anxiety",
        title: "Recurring deadline anxiety",
        body: "You return to deadline stress across several entries.",
        evidence: ["reflections/2026-06-01", "reflections/2026-06-02", "reflections/2026-06-03"],
      },
    ]);
    const r = await patternsPhase(storage, {
      sonnetFn: fakeSonnet("Sure! Here is the JSON:\n```json\n" + payload + "\n```\nHope that helps."),
    });
    expect(r.ran).toBe(true);
    expect(r.patternsWritten).toBe(1);
  });
});
