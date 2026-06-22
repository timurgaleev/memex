/**
 * skillpack/brain-resident.ts — server-side discovery of the brain-resident
 * skillpack for the `list_brain_skillpack` MCP tool.
 *
 * memex is single-holder / single-source: it ships ONE local skillpack (the
 * `deploy/skills/` directory `memex skillpack` bundles), not the reference's
 * per-federated-source packs. So discovery collapses to "read the local skills
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
/** Same default the `memex skillpack` command bundles from (deploy/skills/). */
const DEFAULT_SKILLS_DIR = resolve(__dirname, "..", "..", "..", "..", "skills");

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
  for (const line of block.split("\n")) {
    const kv = /^description:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = (kv[1] ?? "").trim().replace(/^["']|["']$/g, "");
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

  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return empty;
  }

  // Deterministic ordering: byte-order by filename so the listing is stable
  // across filesystems (mirrors the keyword tie-break discipline elsewhere).
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const skills: BrainSkill[] = files.map((f) => ({
    slug: f.replace(/\.md$/, ""),
    description: readSkillDescription(join(skillsDir, f)),
  }));

  return { pack: "memex-skillpack", count: skills.length, skills };
}
