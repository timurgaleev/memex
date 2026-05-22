/**
 * `memex skillpack [--out PATH]` — bundle a `deploy/skills/`
 * directory as a tar.gz so it can be shared / installed by a
 * downstream agent that consumes skill packs.
 *
 * Looks at deploy/skills/ in the repo (resolved relative to the
 * memex package). Writes a tarball with an embedded manifest.json
 * naming each skill + a sha256 of its contents (so the receiver can
 * verify). Today the stack ships no skills under deploy/skills/;
 * this command stays available for future re-introduction.
 *
 * Implementation uses Bun's child_process spawn of `tar` so we don't
 * pull a tar npm dep; tar is in alpine + AL2023 base image, container
 * has it, dev hosts virtually always have it.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = resolve(__dirname, "..", "..", "..", "skills");

export interface SkillpackOptions {
  /** Override the source skills directory. Default `deploy/skills`. */
  skillsDir?: string;
  /** Output tarball path. Default `./skillpack-<timestamp>.tar.gz`. */
  out?: string;
}

interface ManifestEntry {
  name: string;
  sha256: string;
  size: number;
}

export async function runSkillpack(opts: SkillpackOptions = {}): Promise<void> {
  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  if (!existsSync(skillsDir)) {
    throw new Error(`skillpack: skills directory not found at ${skillsDir}`);
  }
  const outPath =
    opts.out ?? `./skillpack-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;

  const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    throw new Error(`skillpack: no .md files in ${skillsDir}`);
  }

  // Build the manifest.
  const entries: ManifestEntry[] = [];
  for (const f of files) {
    const buf = readFileSync(join(skillsDir, f));
    entries.push({
      name: f,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.byteLength,
    });
  }
  const manifest = {
    name: "memex-skillpack",
    version: "0.1.0",
    generated_at: new Date().toISOString(),
    skills: entries,
  };
  const manifestPath = join(skillsDir, ".manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Run tar with the manifest + every .md file. -C cwd so paths in the
  // archive are flat (no parent dirs leak into the bundle).
  const tar = spawnSync(
    "tar",
    [
      "-czf",
      outPath,
      "-C",
      skillsDir,
      ".manifest.json",
      ...files,
    ],
    { stdio: "inherit" },
  );
  if (tar.status !== 0) {
    throw new Error(`skillpack: tar exited ${tar.status}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: outPath,
        skills: entries.length,
        bytes: entries.reduce((s, e) => s + e.size, 0),
      },
      null,
      2,
    ),
  );
}
