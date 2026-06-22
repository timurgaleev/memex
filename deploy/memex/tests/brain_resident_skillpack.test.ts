/**
 * Brain-resident skillpack listing — reads a local skills dir of .md files,
 * surfaces slug + frontmatter description, deterministic byte-order, fail-open
 * on a missing dir. No engine, no LLM.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBrainSkillpacks } from "../src/core/skillpack/brain-resident.ts";

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
