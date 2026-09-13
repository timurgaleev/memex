/**
 * `if (sourceIds && sourceIds.length)` reads a caller granted nothing (`[]`) as
 * the whole brain. Every read path now goes through `core/source-scope.ts` or
 * tests `!== undefined`; this ratchet keeps the collapsing shape from coming back.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

// `x && x.length`, `x && x.length > 0`, `x && x?.length` for any *source(s)(Id(s))* name.
const COLLAPSE = /(\b[\w.?]*[sS]ources?(?:Ids?)?)\s*&&\s*\1\??\.length/g;
// `Array.isArray(x) && x.length > 0 ? … : undefined` — the same collapse behind a type check.
const ISARRAY_COLLAPSE = /Array\.isArray\(([\w.]*[sS]ources?(?:Ids?)?)\)\s*&&\s*\1\??\.length/g;
// A normaliser that maps an empty list to "no filter": `x.length === 0) return undefined`.
const NORMALISE_AWAY = /\b[\w.]*[sS]ources?(?:Ids?)?\??\.length\s*===\s*0\s*\)\s*return\s+undefined/g;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// Comments may still describe the old shape; only code counts.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
}

describe("source scope pattern ratchet", () => {
  it("no source list is tested with `x && x.length` or normalised from [] to unscoped", () => {
    const hits: string[] = [];
    for (const file of tsFiles(SRC)) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const m of [...code.matchAll(COLLAPSE), ...code.matchAll(ISARRAY_COLLAPSE), ...code.matchAll(NORMALISE_AWAY)]) {
        const line = code.slice(0, m.index).split("\n").length;
        hits.push(`${relative(SRC, file)}:${line}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("detects the collapsing shape it is meant to forbid", () => {
    const probe = "if (opts.sourceIds && opts.sourceIds.length > 0) {} const s = readSources && readSources.length ? readSources : undefined;";
    expect([...probe.matchAll(COLLAPSE)].length).toBe(2);
    const normaliser = "if (!Array.isArray(sourceIds) || sourceIds.length === 0) return undefined;";
    expect([...normaliser.matchAll(NORMALISE_AWAY)].length).toBe(1);
    const typed = "const scoped = Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;";
    expect([...typed.matchAll(ISARRAY_COLLAPSE)].length).toBe(1);
  });
});
