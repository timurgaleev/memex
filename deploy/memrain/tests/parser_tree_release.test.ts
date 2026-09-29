/**
 * Every tree-sitter Tree we allocate must be freed.
 *
 * A Tree lives in the Emscripten heap, which JS garbage collection cannot
 * reclaim — only `Tree.delete()` gives the memory back. The code sweep parses
 * one tree per file plus one per symbol, so a sweep over a few thousand source
 * files used to strand tens of thousands of trees in a daemon that then runs
 * for weeks: unbounded growth with the corpus, invisible until the OOM killer.
 *
 * The guard: spy on the cached parser so every tree it hands out is tracked,
 * run the real chunk/extract path, and assert each tree was deleted exactly
 * once.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Parser, Tree } from "web-tree-sitter";
import {
  _resetParsersForTests,
  getParser,
  withParsedTree,
} from "../src/core/chunkers/parsers.ts";
import { chunkCode } from "../src/core/chunkers/code.ts";
import { extractCodeEntities } from "../src/core/code-entities.ts";

/** One tally per tree the spied parser produced. */
interface TreeTally {
  deletes: number;
}

/**
 * Wrap `parser.parse` so each returned tree counts its own `delete()` calls.
 * The parser instance is the module-level cached one, so the caller MUST
 * restore it — hence the returned closure rather than an afterEach hook.
 */
function spyOnParses(parser: Parser): {
  tallies: TreeTally[];
  restore: () => void;
} {
  const tallies: TreeTally[] = [];
  const target = parser as unknown as {
    parse: (...args: unknown[]) => Tree | null;
  };
  const original = target.parse.bind(parser);
  target.parse = (...args: unknown[]): Tree | null => {
    const tree = original(...args);
    if (!tree) return tree;
    const tally: TreeTally = { deletes: 0 };
    tallies.push(tally);
    const originalDelete = tree.delete.bind(tree);
    (tree as unknown as { delete: () => void }).delete = () => {
      tally.deletes += 1;
      originalDelete();
    };
    return tree;
  };
  return { tallies, restore: () => { target.parse = original; } };
}

const SOURCE = [
  "import { helper } from './helper.ts';",
  "",
  "export function alpha(n: number): number {",
  "  return helper(n) + 1;",
  "}",
  "",
  "export class Beta {",
  "  run(): void {",
  "    alpha(2);",
  "  }",
  "}",
  "",
].join("\n");

afterEach(() => {
  _resetParsersForTests();
});

describe("withParsedTree", () => {
  it("returns the callback's value and frees the tree", () => {
    let deletes = 0;
    const tree = {
      delete: () => { deletes += 1; },
    } as unknown as Tree;
    const parser = {
      parse: () => tree,
      reset: () => {},
    } as unknown as Parser;

    expect(withParsedTree(parser, "anything", () => "used")).toBe("used");
    expect(deletes).toBe(1);
  });

  it("frees the tree when the work throws — the degrade path swallows that throw upstream", () => {
    let deletes = 0;
    const tree = {
      delete: () => { deletes += 1; },
    } as unknown as Tree;
    const parser = {
      parse: () => tree,
      reset: () => {},
    } as unknown as Parser;

    expect(() =>
      withParsedTree(parser, "anything", () => {
        throw new Error("walk blew up");
      }),
    ).toThrow("walk blew up");
    expect(deletes).toBe(1);
  });
});

describe("code parse paths", () => {
  it("chunkCode frees its file-level tree", async () => {
    const parser = await getParser("typescript");
    const spy = spyOnParses(parser);
    try {
      const chunked = await chunkCode(SOURCE, "src/mod.ts", "typescript");
      // The result must still be complete — freeing must happen only after the
      // walk has copied everything out of the tree.
      expect(chunked.symbols.map((s) => s.name)).toContain("alpha");
      expect(chunked.fileImports.map((i) => i.name)).toContain("helper");
      expect(spy.tallies.length).toBe(1);
      expect(spy.tallies.map((t) => t.deletes)).toEqual([1]);
    } finally {
      spy.restore();
    }
  });

  it("extractCodeEntities frees its per-symbol sub-tree", async () => {
    const chunked = await chunkCode(SOURCE, "src/mod.ts", "typescript");
    const symbol = chunked.symbols.find((s) => s.name === "alpha")!;
    const parser = await getParser("typescript");
    const spy = spyOnParses(parser);
    try {
      const entities = await extractCodeEntities({
        symbol,
        file: "src/mod.ts",
        language: "typescript",
      });
      expect(entities.some((e) => e.type === "code-caller" && e.name === "helper")).toBe(true);
      expect(spy.tallies.length).toBe(1);
      expect(spy.tallies.map((t) => t.deletes)).toEqual([1]);
    } finally {
      spy.restore();
    }
  });

  it("leaves nothing behind across a whole file's worth of parses", async () => {
    // The shape indexCodeDocument runs per swept file: one file-level parse plus
    // one per symbol. Every one of them has to come back.
    const parser = await getParser("typescript");
    const spy = spyOnParses(parser);
    try {
      const chunked = await chunkCode(SOURCE, "src/mod.ts", "typescript");
      for (const symbol of chunked.symbols) {
        await extractCodeEntities({ symbol, file: "src/mod.ts", language: "typescript" });
      }
      expect(spy.tallies.length).toBe(1 + chunked.symbols.length);
      expect(spy.tallies.every((t) => t.deletes === 1)).toBe(true);
    } finally {
      spy.restore();
    }
  });
});
