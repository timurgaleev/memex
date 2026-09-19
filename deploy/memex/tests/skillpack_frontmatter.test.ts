/**
 * The shared skill frontmatter parser: the pack contract fields, the YAML
 * shapes the pack uses, and byte-identical descriptions for the listing.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillFrontmatter } from "../src/core/skillpack/frontmatter.ts";

const PACK_DIR = resolve(import.meta.dir, "..", "..", "skills");

const PACK_SKILL = [
  "---",
  "name: query",
  "version: 1.0.0",
  "description: |",
  "  Answer questions using the brain.",
  "  Use when the user asks.",
  "triggers:",
  "  - \"what do we know about\"",
  "  - 'tell me about'",
  "tools:",
  "  - search",
  "  - page_get",
  "mutating: false",
  "requires: [sources, \"embeddings\"]",
  "writes_to:",
  "  - reports/",
  "---",
  "",
  "# Query",
  "",
  "Body.",
].join("\n");

/**
 * The description reader the listing used before the shared parser, kept
 * verbatim as the reference the parser must reproduce on the real pack.
 */
function legacyDescription(text: string): string {
  const m = /^---[^\S\n]*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!m) return "(no description)";
  const lines = (m[1] ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const kv = /^description:\s*(.*)$/.exec(lines[i] ?? "");
    if (!kv) continue;
    const value = (kv[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim().length === 0) {
          if (parts.length > 0) break;
          continue;
        }
        if (!/^\s/.test(l)) break;
        parts.push(l.trim());
      }
      const joined = parts.join(" ").trim();
      return joined.length > 0 ? joined : "(no description)";
    }
    return value.length > 0 ? value : "(no description)";
  }
  return "(no description)";
}

function packSkillFiles(): string[] {
  return readdirSync(PACK_DIR)
    .filter((n) => !n.startsWith("_") && !n.startsWith(".") && n !== "conventions")
    .map((n) => join(PACK_DIR, n, "SKILL.md"))
    .filter((f) => existsSync(f));
}

describe("parseSkillFrontmatter", () => {
  it("parses the pack contract fields", () => {
    const fm = parseSkillFrontmatter(PACK_SKILL)!;
    expect(fm.name).toBe("query");
    expect(fm.description).toBe("Answer questions using the brain. Use when the user asks.");
    expect(fm.triggers).toEqual(["what do we know about", "tell me about"]);
    expect(fm.tools).toEqual(["search", "page_get"]);
    expect(fm.mutating).toBe(false);
    expect(fm.requires).toEqual(["sources", "embeddings"]);
    expect(fm.writes_to).toEqual(["reports/"]);
    expect(fm.unknownKeys).toEqual(["version"]);
    expect(fm.keyLines["tools"]).toBe(10);
    expect(fm.body.startsWith("# Query")).toBe(true);
    expect(fm.bodyLine).toBe(19);
  });

  it("handles folded scalars, inline lists and quoted scalars", () => {
    const fm = parseSkillFrontmatter(
      "---\nname: \"x\"\ndescription: >-\n  one\n  two\ntools: [search, 'page_get']\nmutating: true\n---\nbody",
    )!;
    expect(fm.name).toBe("x");
    expect(fm.description).toBe("one two");
    expect(fm.tools).toEqual(["search", "page_get"]);
    expect(fm.mutating).toBe(true);
  });

  it("parses CRLF files the same as LF files", () => {
    const crlf = parseSkillFrontmatter(PACK_SKILL.replace(/\n/g, "\r\n"))!;
    const lf = parseSkillFrontmatter(PACK_SKILL)!;
    expect(crlf.name).toBe(lf.name);
    expect(crlf.description).toBe(lf.description);
    expect(crlf.triggers).toEqual(lf.triggers);
    expect(crlf.tools).toEqual(lf.tools);
  });

  it("returns null without a fence and keeps legacy keys reachable", () => {
    expect(parseSkillFrontmatter("# no frontmatter\n")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: x\nno closing fence\n")).toBeNull();
    const fm = parseSkillFrontmatter("---\ntitle: old\ntags: [a, b]\n---\n")!;
    expect(fm.name).toBeNull();
    expect(fm.scalars["title"]).toBe("old");
    expect(fm.lists["tags"]).toEqual(["a", "b"]);
    expect(fm.unknownKeys).toEqual(["title", "tags"]);
  });

  it("reproduces the listing's description on every real pack skill", () => {
    const files = packSkillFiles();
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const parsed = parseSkillFrontmatter(text)?.description ?? "(no description)";
      expect(parsed).toBe(legacyDescription(text));
    }
  });
});

describe("parseSkillFrontmatter cost", () => {
  function timed(fn: () => void): number {
    const started = performance.now();
    fn();
    return performance.now() - started;
  }

  // Doubling the input must roughly double the time. Best of three per size
  // keeps a GC pause from reading as a super-linear step.
  function ratio(build: (n: number) => string, n: number): number {
    const best = (s: string): number =>
      Math.min(...[0, 1, 2].map(() => timed(() => parseSkillFrontmatter(s))));
    const small = build(n);
    const large = build(n * 2);
    return best(large) / Math.max(best(small), 0.05);
  }

  it("stays linear on an opening fence that never closes", () => {
    expect(ratio((n) => `---\n${"\n".repeat(n)}x`, 1_000_000)).toBeLessThan(3);
  }, 60_000);

  it("stays linear on a huge tools list", () => {
    const r = ratio((n) => `---\nname: x\ntools:\n${"  - page_get\n".repeat(n / 13)}---\nbody`, 1_000_000);
    expect(r).toBeLessThan(3);
    const fm = parseSkillFrontmatter(`---\ntools:\n${"  - page_get\n".repeat(80_000)}---\n`)!;
    expect(fm.tools.length).toBe(80_000);
  }, 60_000);
});
