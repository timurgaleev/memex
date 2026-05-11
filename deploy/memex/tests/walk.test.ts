/**
 * walk.ts unit tests.
 *
 * Walk is a pure-fs generator with no DB dependency, so we test it
 * directly by creating throwaway tree fixtures and asserting the
 * output set. Also serves as the regression contract: existing
 * sweep.ts behavior is "find every .md, mtime is well-defined" —
 * walkFiles({extensions:[".md"], ignore:DEFAULTS}) must satisfy that
 * for any input the prior `walkMarkdown` would have.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles } from "../src/core/walk.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-walk-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("walkFiles", () => {
  it("yields files matching the configured extensions only", () => {
    mkdirSync(join(tmp, "ext"), { recursive: true });
    writeFileSync(join(tmp, "ext/one.md"), "# md");
    writeFileSync(join(tmp, "ext/two.txt"), "txt");
    writeFileSync(join(tmp, "ext/three.ts"), "// ts");
    const md = [...walkFiles(join(tmp, "ext"), { extensions: [".md"], ignore: new Set() })];
    expect(md.length).toBe(1);
    expect(md[0]?.path.endsWith("/one.md")).toBe(true);
    const ts = [...walkFiles(join(tmp, "ext"), { extensions: [".ts"], ignore: new Set() })];
    expect(ts.length).toBe(1);
    expect(ts[0]?.path.endsWith("/three.ts")).toBe(true);
    const both = [
      ...walkFiles(join(tmp, "ext"), {
        extensions: [".md", ".ts"],
        ignore: new Set(),
      }),
    ];
    expect(both.length).toBe(2);
  });

  it("recurses into subdirectories", () => {
    mkdirSync(join(tmp, "rec/a/b"), { recursive: true });
    writeFileSync(join(tmp, "rec/top.ts"), "");
    writeFileSync(join(tmp, "rec/a/mid.ts"), "");
    writeFileSync(join(tmp, "rec/a/b/deep.ts"), "");
    const out = [
      ...walkFiles(join(tmp, "rec"), { extensions: [".ts"], ignore: new Set() }),
    ];
    expect(out.length).toBe(3);
  });

  it("skips ignored directory basenames at any depth", () => {
    mkdirSync(join(tmp, "ig/keep/node_modules"), { recursive: true });
    mkdirSync(join(tmp, "ig/.git"), { recursive: true });
    writeFileSync(join(tmp, "ig/keep/ok.ts"), "");
    writeFileSync(join(tmp, "ig/keep/node_modules/skip.ts"), "");
    writeFileSync(join(tmp, "ig/.git/config.ts"), "");
    const out = [
      ...walkFiles(join(tmp, "ig"), {
        extensions: [".ts"],
        ignore: new Set(["node_modules", ".git"]),
      }),
    ];
    expect(out.length).toBe(1);
    expect(out[0]?.path.endsWith("/keep/ok.ts")).toBe(true);
  });

  it("returns an mtimeMs >= the time of write", () => {
    const before = Date.now();
    const p = join(tmp, "mt.ts");
    writeFileSync(p, "");
    const out = [
      ...walkFiles(tmp, { extensions: [".ts"], ignore: new Set() }),
    ];
    const me = out.find((f) => f.path === p);
    expect(me).toBeDefined();
    // mtimeMs is floored; allow a small skew for the floor.
    expect(me!.mtimeMs).toBeGreaterThanOrEqual(before - 1000);
  });

  it("is case-insensitive on extensions", () => {
    mkdirSync(join(tmp, "ci"), { recursive: true });
    writeFileSync(join(tmp, "ci/Upper.MD"), "");
    const out = [
      ...walkFiles(join(tmp, "ci"), {
        extensions: [".md"],
        ignore: new Set(),
      }),
    ];
    expect(out.length).toBe(1);
  });

  it("returns an empty iterator for a non-existent root (silent)", () => {
    const out = [
      ...walkFiles(join(tmp, "does-not-exist"), {
        extensions: [".md"],
        ignore: new Set(),
      }),
    ];
    expect(out.length).toBe(0);
  });
});
