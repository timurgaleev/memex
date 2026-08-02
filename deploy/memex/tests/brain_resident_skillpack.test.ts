/**
 * Brain-resident skillpack listing — reads a local skills dir of .md files,
 * surfaces slug + frontmatter description, deterministic byte-order, fail-open
 * on a missing dir. No engine, no LLM.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBrainSkill, listBrainSkillpacks } from "../src/core/skillpack/brain-resident.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-brainpack-"));

beforeAll(() => {
  writeFileSync(
    join(dir, "book-mirror.md"),
    "---\ntitle: book-mirror\ndescription: Map a book chapter-by-chapter to your life.\ntags: [reading]\n---\n# book-mirror\nbody\n",
  );
  writeFileSync(
    join(dir, "archive-crawler.md"),
    '---\ntitle: archive-crawler\ndescription: "Universal archivist for personal file archives."\n---\nbody\n',
  );
  // No frontmatter → placeholder description, still listed.
  writeFileSync(join(dir, "bare.md"), "# bare\njust a body\n");
  // Non-.md is ignored.
  writeFileSync(join(dir, "notes.txt"), "ignore me\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listBrainSkillpacks", () => {
  it("lists .md skills in byte-order with their descriptions", () => {
    const r = listBrainSkillpacks({ skillsDir: dir });
    expect(r.pack).toBe("memex-skillpack");
    expect(r.count).toBe(3);
    expect(r.skills.map((s) => s.slug)).toEqual([
      "archive-crawler",
      "bare",
      "book-mirror",
    ]);
    const byId = new Map(r.skills.map((s) => [s.slug, s.description] as const));
    expect(byId.get("book-mirror")).toBe("Map a book chapter-by-chapter to your life.");
    expect(byId.get("archive-crawler")).toBe("Universal archivist for personal file archives.");
    expect(byId.get("bare")).toBe("(no description)");
  });

  it("fail-opens to an empty pack when the skills dir is absent", () => {
    const r = listBrainSkillpacks({ skillsDir: join(dir, "does-not-exist") });
    expect(r.count).toBe(0);
    expect(r.skills).toEqual([]);
  });
});

describe("directory layout + shared docs", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "memex-brainpack2-"));
  beforeAll(() => {
    mkdirSync(join(dir2, "brain-ops"));
    writeFileSync(
      join(dir2, "brain-ops", "SKILL.md"),
      "---\nname: brain-ops\ndescription: Core read/write cycle.\n---\n# brain-ops\nbody\n",
    );
    writeFileSync(join(dir2, "flat-skill.md"), "---\ndescription: Flat one.\n---\nbody\n");
    writeFileSync(join(dir2, "_output-rules.md"), "---\ndescription: Shared rules.\n---\nrules\n");
    mkdirSync(join(dir2, "conventions"));
    writeFileSync(join(dir2, "conventions", "brain-first.md"), "convention body\n");
    // A directory without SKILL.md is not a skill.
    mkdirSync(join(dir2, "empty-dir"));
  });
  afterAll(() => rmSync(dir2, { recursive: true, force: true }));

  it("enumerates dir skills + flat skills, skips underscore/conventions", () => {
    const r = listBrainSkillpacks({ skillsDir: dir2 });
    expect(r.skills.map((s) => s.slug)).toEqual(["brain-ops", "flat-skill"]);
  });

  it("get_skill resolves dir skills, underscore docs, and conventions", () => {
    expect(getBrainSkill("brain-ops", { skillsDir: dir2 })!.body).toContain("# brain-ops");
    expect(getBrainSkill("_output-rules", { skillsDir: dir2 })!.body).toContain("rules");
    expect(getBrainSkill("conventions/brain-first", { skillsDir: dir2 })!.body).toContain(
      "convention body",
    );
  });

  it("rejects traversal shapes", () => {
    expect(getBrainSkill("../secrets", { skillsDir: dir2 })).toBeNull();
    expect(getBrainSkill("conventions/../../etc/passwd", { skillsDir: dir2 })).toBeNull();
    expect(getBrainSkill("conventions/..", { skillsDir: dir2 })).toBeNull();
  });
});
