/**
 * File-content lint (`memex lint <dir|file> [--fix]`) — the deterministic
 * page-quality rules + auto-repair. Pure/fs only — no storage boot.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintContent, fixContent } from "../src/core/lint.ts";
import { lintFiles } from "../src/commands/lint.ts";

const GOOD = `---
title: A clean page
type: note
created: 2026-01-01
---

# A clean page

## Facts

Real content here.
`;

const BAD = `Of course! Here is a detailed page about databases.
---
title: Databases
---

## History

Something happened on YYYY-MM-DD here.

## Empty one

## Sources

[Source: some report
without the closing bracket
`;

describe("lintContent", () => {
  it("flags the reference rule set with stable rule names", () => {
    const issues = lintContent(BAD, "bad.md");
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain("llm-preamble");
    expect(rules).toContain("placeholder-date");
    expect(rules).toContain("empty-section");
    expect(rules).toContain("broken-citation");
    // Content starts with the preamble, not '---' → no-frontmatter fires.
    expect(rules).toContain("no-frontmatter");
  });

  it("flags missing required frontmatter fields", () => {
    const issues = lintContent(`---\ntitle: x\n---\nbody\n`, "x.md");
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain("missing-type");
    expect(rules).toContain("missing-created");
    expect(rules).not.toContain("missing-title");
  });

  it("passes a clean page", () => {
    expect(lintContent(GOOD, "good.md")).toEqual([]);
  });

  it("detects and repairs a ```markdown fence wrap", () => {
    const wrapped = "```markdown\n# Page\n\nreal text\n```\n";
    const issues = lintContent(wrapped, "w.md");
    expect(issues.some((i) => i.rule === "code-fence-wrap")).toBe(true);
    const fixed = fixContent(wrapped);
    expect(fixed.startsWith("# Page")).toBe(true);
    expect(fixed).not.toContain("```");
  });

  it("fixContent strips LLM preambles and collapses blank craters", () => {
    const fixed = fixContent(BAD);
    expect(fixed.startsWith("Of course")).toBe(false);
    expect(fixed).not.toMatch(/\n{3,}/);
  });
});

describe("lintFiles (--fix / --dry-run)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "memex-lint-files-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "good.md"), GOOD);
    writeFileSync(join(dir, "sub", "bad.md"), BAD);
    writeFileSync(join(dir, "_ignored.md"), BAD); // underscore-prefixed skipped
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports without writing on dry-run", () => {
    const before = readFileSync(join(dir, "sub", "bad.md"), "utf-8");
    const r = lintFiles(dir, { fix: true, dryRun: true });
    expect(r.pagesScanned).toBe(2); // _ignored.md skipped
    expect(r.pagesWithIssues).toBe(1);
    expect(r.totalFixed).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "sub", "bad.md"), "utf-8")).toBe(before);
  });

  it("--fix repairs the fixable subset in place", () => {
    const r = lintFiles(dir, { fix: true });
    expect(r.totalFixed).toBeGreaterThan(0);
    const after = readFileSync(join(dir, "sub", "bad.md"), "utf-8");
    expect(after.startsWith("Of course")).toBe(false);
    // Unfixable rules (placeholder-date etc.) still report on a re-lint.
    const again = lintFiles(dir);
    expect(again.issues.some((i) => i.rule === "placeholder-date")).toBe(true);
    expect(again.issues.some((i) => i.rule === "llm-preamble")).toBe(false);
  });

  it("lints a single file target", () => {
    const r = lintFiles(join(dir, "good.md"));
    expect(r.pagesScanned).toBe(1);
    expect(r.totalIssues).toBe(0);
  });

  it("throws on a missing target", () => {
    expect(() => lintFiles(join(dir, "nope"))).toThrow(/not found/);
  });
});
