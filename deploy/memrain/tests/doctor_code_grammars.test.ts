/**
 * doctor's `code-grammars` probe (core/doctor-ops.ts).
 *
 * The check used to compare the vendored blobs against `wasm/manifest.json` —
 * a manifest generated from those same blobs. During the live incident the
 * bytes matched and every .sh file still threw inside the external scanner, so
 * the check reported a healthy brain while the shell corpus was missing from
 * the code graph. It has to load the grammar and parse something.
 *
 * No engine is used: the probe is engine-free and takes the handle only to
 * match the shape of its siblings, so these tests skip PGLite entirely.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../src/core/engine/interface.ts";
import { checkGrammars } from "../src/core/doctor-ops.ts";
import {
  WASM_FILES,
  _resetParsersForTests,
  verifyGrammarManifest,
} from "../src/core/chunkers/parsers.ts";

/** The probe never touches the engine; nothing to stand up. */
const NO_ENGINE = undefined as unknown as Engine;

const dirs: string[] = [];

afterEach(() => {
  delete process.env.MEMEX_WASM_DIR;
  _resetParsersForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A wasm dir holding one unusable bash blob plus a manifest that AGREES with
 * it, byte for byte — the state the old check called healthy.
 */
function selfConsistentBrokenDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memex-doctor-grammar-"));
  dirs.push(dir);
  const blob = Buffer.from("\0asm   not-a-grammar");
  writeFileSync(join(dir, WASM_FILES.bash), blob);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      grammars: {
        [WASM_FILES.bash]: {
          sha256: createHash("sha256").update(blob).digest("hex"),
          bytes: blob.byteLength,
        },
      },
    }),
  );
  return dir;
}

describe("checkGrammars", () => {
  it("passes on the vendored grammars, naming what it exercised", async () => {
    const r = await checkGrammars(NO_ENGINE);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("load and parse a probe");
    for (const lang of Object.keys(WASM_FILES)) expect(r.detail).toContain(lang);
  });

  it("fails on a grammar that cannot be used even when its bytes match the manifest", async () => {
    process.env.MEMEX_WASM_DIR = selfConsistentBrokenDir();
    _resetParsersForTests();

    // The old signal: bytes agree with the manifest, so the check was green.
    expect(verifyGrammarManifest().ok).toBe(true);

    const r = await checkGrammars(NO_ENGINE);
    expect(r.ok).toBe(false);
    // Which language, and how.
    expect(r.detail).toContain("bash");
    expect(r.detail).toContain("failed at load");
    expect(r.detail).toContain("no symbols and no call graph");
  });
});
