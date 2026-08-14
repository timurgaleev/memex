/**
 * skillpack/brain-resident.ts — server-side discovery of the brain-resident
 * skillpack for the `list_brain_skillpack` MCP tool.
 *
 * memex is single-holder / single-source: it ships ONE local skillpack (the
 * `deploy/skills/` directory `memex skillpack` bundles), not per-federated-source
 * packs. So discovery collapses to "read the local skills
 * dir and surface its offerings as a read" — there is no in-DB source tenancy
 * to scope by, and no git-remote scaffold spec to hand a thin client.
 *
 * This REUSES what `commands/skillpack.ts` already knows (the default skills
 * dir, the `.md`-per-skill layout) and the fixed `title`/`description`
 * frontmatter contract `core/skillify.ts` shapes. Read-only: no writes, no LLM,
 * no filesystem path leaked to the client (we surface slug + description only).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Same default the `memex skillpack` command bundles from (deploy/skills/).
 * In the container the repo-relative path does not exist (the image copies
 * only deploy/memex), so the compose file mounts the pack read-only and
 * points MEMEX_SKILLS_DIR at it.
 */
const DEFAULT_SKILLS_DIR =
  process.env.MEMEX_SKILLS_DIR && process.env.MEMEX_SKILLS_DIR.trim().length > 0
    ? process.env.MEMEX_SKILLS_DIR
    : resolve(__dirname, "..", "..", "..", "..", "skills");

export interface BrainSkill {
  slug: string;
  description: string;
}

export interface BrainSkillpackResult {
  /** The pack name (stable; memex ships a single pack). */
  pack: string;
  /** Number of skills discovered. */
  count: number;
  skills: BrainSkill[];
}

export interface ListBrainSkillpacksOptions {
  /** Override the source skills dir (tests point this at a fixture). */
  skillsDir?: string;
}

/**
 * Read the `description` from a skill `.md` file's frontmatter. Tolerant of the
 * same mild drift `skillify.ts` handles (quoted values). Returns a placeholder
 * when the file has no frontmatter or no description, so a malformed skill never
 * aborts the listing.
 */
function readSkillDescription(skillFile: string): string {
  let text: string;
  try {
    text = readFileSync(skillFile, "utf8");
  } catch {
    return "(no description)";
  }
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!m) return "(no description)";
  const block = m[1] ?? "";
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^description:\s*(.*)$/.exec(lines[i] ?? "");
    if (!kv) continue;
    const value = (kv[1] ?? "").trim().replace(/^["']|["']$/g, "");
    // YAML block scalar (`description: |` / `>`): the text lives on the
    // following more-indented lines — join them into one line.
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

/**
 * Enumerate the brain-resident skillpack offerings. Fail-open: a missing skills
 * dir (memex ships none by default) returns an empty pack rather than throwing,
 * so the MCP tool always returns a well-formed result.
 */
export function listBrainSkillpacks(
  opts: ListBrainSkillpacksOptions = {},
): BrainSkillpackResult {
  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const empty: BrainSkillpackResult = { pack: "memex-skillpack", count: 0, skills: [] };
  if (!existsSync(skillsDir)) return empty;

  // Two layouts, both supported:
  //   flat:      <skillsDir>/<slug>.md          (the original memex shape)
  //   directory: <skillsDir>/<slug>/SKILL.md    (the shipped pack's shape)
  // Underscore-prefixed files (shared cross-cutting rules, not routable
  // skills) and non-skill artifacts (manifest.json, conventions/) are
  // excluded from the ENUMERATION but stay reachable via get_skill.
  const entries: { slug: string; file: string }[] = [];
  try {
    for (const name of readdirSync(skillsDir)) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      if (name === "conventions") continue;
      const full = join(skillsDir, name);
      if (name.endsWith(".md")) {
        entries.push({ slug: name.replace(/\.md$/, ""), file: full });
        continue;
      }
      const skillFile = join(full, "SKILL.md");
      if (existsSync(skillFile)) entries.push({ slug: name, file: skillFile });
    }
  } catch {
    return empty;
  }

  // Deterministic ordering: byte-order by slug so the listing is stable
  // across filesystems (mirrors the keyword tie-break discipline elsewhere).
  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const skills: BrainSkill[] = entries.map((e) => ({
    slug: e.slug,
    description: readSkillDescription(e.file),
  }));

  return { pack: "memex-skillpack", count: skills.length, skills };
}

export interface BrainSkillDetail {
  slug: string;
  description: string;
  /** Full markdown body of the skill file (frontmatter included). */
  body: string;
}

/**
 * Fetch one brain-resident skill's full body by slug — backs the `get_skill`
 * MCP tool. Returns null when the slug doesn't resolve to a skill file.
 *
 * The slug is joined into a filesystem path, so it is validated against a strict
 * skill-slug shape first: a `/`, `.`, or `\` could escape the skills dir, so
 * anything but `[A-Za-z0-9][A-Za-z0-9_-]*` is rejected before touching disk.
 */
export function getBrainSkill(
  slug: string,
  opts: ListBrainSkillpacksOptions = {},
): BrainSkillDetail | null {
  // Accepted shapes, each strictly validated before touching disk (a `.`,
  // `\`, or arbitrary `/` could escape the skills dir):
  //   <slug>            — a skill (flat <slug>.md or <slug>/SKILL.md)
  //   _<name>           — a shared rules doc (underscore layer)
  //   conventions/<name> — a cross-cutting convention doc
  if (typeof slug !== "string") return null;
  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const candidates: string[] = [];
  if (/^[a-z0-9][\w-]*$/i.test(slug)) {
    candidates.push(join(skillsDir, `${slug}.md`));
    candidates.push(join(skillsDir, slug, "SKILL.md"));
  } else if (/^_[a-z0-9][\w-]*$/i.test(slug)) {
    candidates.push(join(skillsDir, `${slug}.md`));
  } else if (/^conventions\/[a-z0-9][\w.-]*$/i.test(slug) && !slug.includes("..")) {
    const name = slug.slice("conventions/".length);
    candidates.push(join(skillsDir, "conventions", name.includes(".") ? name : `${name}.md`));
  } else {
    return null;
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    return { slug, description: readSkillDescription(file), body };
  }
  return null;
}
