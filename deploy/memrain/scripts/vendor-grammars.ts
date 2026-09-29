/**
 * Regenerate `wasm/manifest.json` from the vendored grammar blobs.
 *
 * The grammars are prebuilt `.wasm` shipped inside their npm packages; vendoring
 * them keeps the container build offline. Nothing enforced that a vendored blob
 * actually came from the pinned package, which is how two grammars built for a
 * different tree-sitter runtime survived in-tree until every .sh file failed to
 * index. The manifest binds bytes to a named source so drift is detectable.
 *
 * To re-vendor a grammar:
 *   bun add -d tree-sitter-<lang>@<version>
 *   cp node_modules/tree-sitter-<lang>/tree-sitter-<lang>.wasm wasm/
 *   bun run scripts/vendor-grammars.ts
 *
 * Then run `bun test tests/grammar_selfcheck.test.ts` — it links and parses
 * every grammar, which is the only check that catches an incompatible build.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(HERE, "..", "wasm");
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

/** grammar file -> the npm package the bytes must come from, or null when the
 *  blob predates this manifest and has no pinned source yet. */
const SOURCES: Record<string, string | null> = {
  "tree-sitter-bash.wasm": "tree-sitter-bash",
  "tree-sitter-go.wasm": "tree-sitter-go",
  "tree-sitter-python.wasm": "tree-sitter-python",
  "tree-sitter-typescript.wasm": "tree-sitter-typescript",
  "tree-sitter-tsx.wasm": "tree-sitter-typescript",
  "tree-sitter-sql.wasm": null,
};

const entries: Record<string, { sha256: string; bytes: number; source: string }> = {};
for (const [file, pkg] of Object.entries(SOURCES)) {
  const path = join(WASM_DIR, file);
  if (!existsSync(path)) throw new Error(`missing vendored grammar: ${path}`);
  const buf = readFileSync(path);
  const version = pkg ? (PKG.devDependencies?.[pkg] ?? PKG.dependencies?.[pkg]) : undefined;
  if (pkg && !version) throw new Error(`${file} claims source ${pkg}, which is not a pinned dependency`);
  entries[file] = {
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.byteLength,
    source: pkg ? `${pkg}@${version}` : "unpinned (no npm source recorded)",
  };
}

const manifest = {
  runtime: `web-tree-sitter@${PKG.dependencies["web-tree-sitter"]}`,
  note: "Regenerate with `bun run scripts/vendor-grammars.ts` after re-vendoring any grammar.",
  grammars: entries,
};
writeFileSync(join(WASM_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote manifest for ${Object.keys(entries).length} grammars`);
