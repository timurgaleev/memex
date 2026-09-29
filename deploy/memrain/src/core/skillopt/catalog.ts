/**
 * The routing catalog: what a model sees when it has to pick a skill — each
 * skill's slug, description and triggers, read from the pack's frontmatter
 * through the shared parser, over the same flat (`<slug>.md`) and directory
 * (`<slug>/SKILL.md`) layouts the brain-resident listing reads.
 *
 * A candidate edit replaces one entry's description and triggers and nothing
 * else. Its frontmatter `name` has to be the slug it replaces: identity is not
 * something an edit gets to change.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "../skillpack/frontmatter.ts";
import { isSkillSlug } from "./benchmark.ts";

export const MAX_CANDIDATE_BYTES = 64 * 1024;

export interface CatalogEntry {
  slug: string;
  description: string;
  triggers: string[];
}

function entryFrom(slug: string, text: string): CatalogEntry {
  const fm = parseSkillFrontmatter(text);
  return {
    slug,
    description: fm?.description ?? "(no description)",
    triggers: fm?.triggers ?? [],
  };
}

/** Every routable skill in the pack, byte-ordered by slug. */
export function buildCatalog(skillsDir: string): CatalogEntry[] {
  const found: { slug: string; file: string }[] = [];
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (name.startsWith("_") || name.startsWith(".") || name === "conventions") continue;
    const full = join(skillsDir, name);
    if (name.endsWith(".md")) {
      found.push({ slug: name.slice(0, -3), file: full });
      continue;
    }
    const skillFile = join(full, "SKILL.md");
    if (existsSync(skillFile)) found.push({ slug: name, file: skillFile });
  }
  found.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const out: CatalogEntry[] = [];
  for (const f of found) {
    let text: string;
    try {
      text = readFileSync(f.file, "utf8");
    } catch {
      continue;
    }
    out.push(entryFrom(f.slug, text));
  }
  return out;
}

/** Read a candidate SKILL.md: a regular `.md` file of at most 64 KB. */
export function readCandidateFile(path: string): string {
  if (!path.endsWith(".md")) throw new Error(`candidate ${path}: must be a .md file`);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`candidate ${path}: not found`);
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`candidate ${path}: not a regular file`);
  }
  if (st.size > MAX_CANDIDATE_BYTES) {
    throw new Error(`candidate ${path}: exceeds ${MAX_CANDIDATE_BYTES} bytes`);
  }
  return readFileSync(path, "utf8");
}

/** The slug a candidate file names in its frontmatter, or null. */
export function candidateName(candidateText: string): string | null {
  return parseSkillFrontmatter(candidateText)?.name ?? null;
}

/**
 * A copy of `catalog` with `slug`'s description and triggers taken from the
 * candidate. Throws when the slug is not in the catalog, the candidate has no
 * frontmatter or description, or its `name` is not the slug.
 */
export function withCandidate(
  catalog: readonly CatalogEntry[],
  slug: string,
  candidateText: string,
): CatalogEntry[] {
  if (!isSkillSlug(slug) || !catalog.some((e) => e.slug === slug)) {
    throw new Error(`candidate: '${slug}' is not a skill in the catalog`);
  }
  const fm = parseSkillFrontmatter(candidateText);
  if (!fm) throw new Error("candidate: no frontmatter block");
  if (fm.name !== slug) {
    throw new Error(
      `candidate: frontmatter name '${fm.name ?? ""}' must stay '${slug}' (a skill's name cannot be edited)`,
    );
  }
  if (!fm.description) throw new Error("candidate: frontmatter has no description");
  const replacement: CatalogEntry = { slug, description: fm.description, triggers: fm.triggers };
  return catalog.map((e) => (e.slug === slug ? replacement : e));
}

/** The catalog as the model reads it: one line per skill. */
export function renderCatalog(catalog: readonly CatalogEntry[]): string {
  return catalog
    .map((e) => {
      const triggers = e.triggers.length > 0 ? ` (triggers: ${e.triggers.join("; ")})` : "";
      return `- ${e.slug}: ${e.description}${triggers}`;
    })
    .join("\n");
}
