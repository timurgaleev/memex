/**
 * Every vendored grammar must LINK and PARSE under the pinned web-tree-sitter,
 * and the blobs must still be the bytes the manifest pinned.
 *
 * Regression guard for a live incident: the bash and go blobs were vendored
 * from a build made against a different tree-sitter runtime. They linked
 * cleanly and parsed trivial input, then died inside the external scanner on
 * ordinary shell syntax with `resolved is not a function`, so every .sh file
 * errored during the code sweep while the boot log printed only a count.
 * Nothing failed loudly; the shell corpus was simply absent from the code graph.
 *
 * A grammar that cannot link indexes zero files of its type. That is a silent
 * capability loss, which is exactly what a test is for.
 */
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAMMAR_PROBES,
  GrammarLoadError,
  WASM_FILES,
  _resetParsersForTests,
  getParser,
  grammarSelfCheck,
  loadLanguage,
  parseWithBudget,
  verifyGrammarManifest,
} from "../src/core/chunkers/parsers.ts";

test("every vendored grammar links AND parses its probe", async () => {
  const results = await grammarSelfCheck();
  expect(results.length).toBe(Object.keys(WASM_FILES).length);
  const broken = results.filter((r) => !r.ok);
  expect(broken.map((b) => `${b.language} (${b.stage}): ${b.error}`)).toEqual([]);
  // A grammar that linked reports its ABI — proof the check reached the runtime
  // rather than short-circuiting on a file read.
  expect(results.every((r) => typeof r.abi === "number")).toBe(true);
});

test("vendored blobs match wasm/manifest.json", () => {
  const r = verifyGrammarManifest();
  expect(r.problems).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.checked).toBe(Object.keys(WASM_FILES).length);
});

test("every declared grammar has a parse probe", () => {
  expect(Object.keys(GRAMMAR_PROBES).sort()).toEqual(Object.keys(WASM_FILES).sort());
});

// A grammar can link and still be broken, so parse the probe per language and
// assert the root type AND an error-free parse. The probes themselves live in
// `parsers.ts` (GRAMMAR_PROBES) so `doctor` runs the same inputs this suite
// does — the bash one is deliberately scanner-heavy, see the note there.
for (const [lang, probe] of Object.entries(GRAMMAR_PROBES)) {
  test(`${lang} grammar parses its probe without errors`, async () => {
    const parser = await getParser(lang as Parameters<typeof getParser>[0]);
    const tree = parseWithBudget(parser, probe.source);
    try {
      expect(tree.rootNode.type).toBe(probe.root);
      expect(tree.rootNode.childCount).toBeGreaterThan(0);
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
  });
}

// The wrapping is the whole point of the fix: without it a link failure is an
// empty Error that names neither the file nor the cause.
test("an unlinkable blob raises GrammarLoadError, and the failure is cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memex-bad-grammar-"));
  writeFileSync(join(dir, WASM_FILES.bash), Buffer.from("\0asm   not-a-grammar"));
  const prev = process.env.MEMRAIN_WASM_DIR;
  process.env.MEMRAIN_WASM_DIR = dir;
  _resetParsersForTests();
  try {
    let first: unknown;
    await loadLanguage("bash").catch((e) => { first = e; });
    expect(first).toBeInstanceOf(GrammarLoadError);
    const err = first as GrammarLoadError;
    expect(err.language).toBe("bash");
    expect(err.path).toContain(WASM_FILES.bash);
    expect(err.message).toContain("different tree-sitter runtime");

    // Second call must reuse the cached rejection rather than re-linking.
    let second: unknown;
    await loadLanguage("bash").catch((e) => { second = e; });
    expect(second).toBe(first);

    // …and the self-check must attribute it to the LOAD stage, by language.
    const bash = (await grammarSelfCheck()).find((r) => r.language === "bash")!;
    expect(bash.ok).toBe(false);
    expect(bash.stage).toBe("load");
    expect(bash.error).toContain("failed to load");
  } finally {
    if (prev === undefined) delete process.env.MEMRAIN_WASM_DIR;
    else process.env.MEMRAIN_WASM_DIR = prev;
    _resetParsersForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A load-only check passes a grammar that links perfectly and is still the
// wrong grammar for the files it will be handed — the mis-vendor that a
// bytes-or-links check cannot see. Only parsing the probe catches it.
test("a blob that links but cannot parse the language fails at the PARSE stage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memex-swapped-grammar-"));
  // A real, healthy grammar — vendored under the wrong name.
  copyFileSync(
    join(import.meta.dir, "..", "wasm", WASM_FILES.python),
    join(dir, WASM_FILES.bash),
  );
  const prev = process.env.MEMRAIN_WASM_DIR;
  process.env.MEMRAIN_WASM_DIR = dir;
  _resetParsersForTests();
  try {
    // It links: the load stage is happy, which is exactly the problem.
    await expect(loadLanguage("bash")).resolves.toBeDefined();

    const bash = (await grammarSelfCheck()).find((r) => r.language === "bash")!;
    expect(bash.ok).toBe(false);
    expect(bash.stage).toBe("parse");
    // The report has to say what went wrong, not just that something did: this
    // blob parses fine, it just isn't shell.
    expect(bash.error).toContain("wrong grammar for this language");
    expect(typeof bash.abi).toBe("number"); // it linked, so the ABI is known
  } finally {
    if (prev === undefined) delete process.env.MEMRAIN_WASM_DIR;
    else process.env.MEMRAIN_WASM_DIR = prev;
    _resetParsersForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  _resetParsersForTests();
});
