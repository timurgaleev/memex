/**
 * Code chunker tests — TS + Python symbol extraction.
 *
 * Exercises the real tree-sitter WASM grammar (vendored under
 * deploy/memex/wasm/). If WASM loading is broken these tests fail
 * fast with a clear error message from parsers.ts.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chunkCode } from "../src/core/chunkers/code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

afterAll(() => _resetParsersForTests());

describe("chunkCode (TypeScript)", () => {
  it("extracts a top-level function declaration", async () => {
    const src = `export function alpha(x: number): number {
  return x + 1;
}
`;
    const r = await chunkCode(src, "alpha.ts", "typescript");
    expect(r.symbols.length).toBe(1);
    const s = r.symbols[0]!;
    expect(s.name).toBe("alpha");
    expect(s.kind).toBe("function");
    expect(s.startLine).toBe(1);
    expect(s.endLine).toBe(3);
    expect(s.enclosing).toBeNull();
    expect(s.parentSymbolPath).toEqual([]);
    expect(s.body).toContain("return x + 1");
  });

  it("extracts class + methods as separate symbols", async () => {
    const src = `class Foo {
  bar(): number { return 1; }
  baz(): number { return 2; }
}
`;
    const r = await chunkCode(src, "foo.ts", "typescript");
    const names = r.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["Foo", "bar", "baz"]);
    const bar = r.symbols.find((s) => s.name === "bar")!;
    expect(bar.kind).toBe("method");
    expect(bar.enclosing).toBe("Foo");
    expect(bar.parentSymbolPath).toEqual(["Foo"]);
  });

  it("records the full ancestor chain for deeply nested symbols", async () => {
    // A class nested inside a function exercises a depth-2 scope chain —
    // the case migration 027's scalar parent_symbol_path dropped.
    const src = `function outer() {
  class Inner {
    deepMethod(): number { return 1; }
  }
  return Inner;
}
`;
    const r = await chunkCode(src, "nested.ts", "typescript");
    const deep = r.symbols.find((s) => s.name === "deepMethod")!;
    expect(deep).toBeDefined();
    expect(deep.parentSymbolPath).toEqual(["outer", "Inner"]);
    // `enclosing` stays the innermost parent (code-entities back-compat).
    expect(deep.enclosing).toBe("Inner");
    const inner = r.symbols.find((s) => s.name === "Inner")!;
    expect(inner.parentSymbolPath).toEqual(["outer"]);
  });

  it("extracts arrow-function const bindings", async () => {
    const src = `const greet = (name: string) => "hi " + name;
const noop = () => {};
`;
    const r = await chunkCode(src, "arrow.ts", "typescript");
    const names = r.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["greet", "noop"]);
    expect(r.symbols.every((s) => s.kind === "arrow")).toBe(true);
  });

  it("flags parse errors but still returns recovered symbols", async () => {
    // Missing closing brace.
    const src = `function alpha() { return 1
function beta() { return 2; }
`;
    const r = await chunkCode(src, "broken.ts", "typescript");
    expect(r.hasParseError).toBe(true);
    // We should still get at least the second function (or both —
    // tree-sitter recovery is generous).
    expect(r.symbols.length).toBeGreaterThanOrEqual(1);
  });

  it("returns no symbols for an empty file", async () => {
    const r = await chunkCode("", "empty.ts", "typescript");
    expect(r.symbols.length).toBe(0);
    expect(r.hasParseError).toBe(false);
  });

  it("title is the basename", async () => {
    const r = await chunkCode("export function x() {}", "src/core/x.ts", "typescript");
    expect(r.title).toBe("x.ts");
  });
});

describe("chunkCode (TSX)", () => {
  it("does not misparse generic <T> as JSX", async () => {
    const src = `export function generic<T>(x: T): T { return x; }
`;
    const r = await chunkCode(src, "g.tsx", "tsx");
    // 'tsx' grammar should accept the syntax cleanly.
    expect(r.hasParseError).toBe(false);
    expect(r.symbols.length).toBe(1);
    expect(r.symbols[0]?.name).toBe("generic");
  });
});

describe("chunkCode doc comments", () => {
  it("captures a JSDoc block above a TS function", async () => {
    const src = `/** Greets a user by name. */
export function greet(name: string): string {
  return "hi " + name;
}
`;
    const r = await chunkCode(src, "g.ts", "typescript");
    expect(r.symbols[0]!.docComment).toBe("/** Greets a user by name. */");
  });

  it("captures a contiguous // line-comment block above a TS function", async () => {
    const src = `// line one
// line two
function alpha() { return 1; }
`;
    const r = await chunkCode(src, "a.ts", "typescript");
    expect(r.symbols[0]!.docComment).toBe("// line one\n// line two");
  });

  it("captures a comment above a method", async () => {
    const src = `class Foo {
  // bar does a thing
  bar(): number { return 1; }
}
`;
    const r = await chunkCode(src, "foo.ts", "typescript");
    const bar = r.symbols.find((s) => s.name === "bar")!;
    expect(bar.docComment).toBe("// bar does a thing");
  });

  it("is null when there is no comment", async () => {
    const r = await chunkCode("export function x() { return 1; }", "x.ts", "typescript");
    expect(r.symbols[0]!.docComment).toBeNull();
  });

  it("does not attach a file-level license header separated by a blank line", async () => {
    const src = `// Copyright 2026 Example Corp.

import { z } from "zod";

export function alpha() { return 1; }
`;
    const r = await chunkCode(src, "lic.ts", "typescript");
    // The header is separated from alpha by an import + blank lines → not its doc.
    expect(r.symbols.find((s) => s.name === "alpha")!.docComment).toBeNull();
  });

  it("captures a comment above a decorated method (skips the decorator)", async () => {
    const src = `class Foo {
  /** bar via decorator */
  @logged
  bar(): number { return 1; }
}
`;
    const r = await chunkCode(src, "dec.ts", "typescript");
    const bar = r.symbols.find((s) => s.name === "bar")!;
    expect(bar.docComment).toBe("/** bar via decorator */");
  });

  it("does NOT attach a trailing comment from the previous statement", async () => {
    const src = `const x = 1; // belongs to x
function f() { return x; }
`;
    const r = await chunkCode(src, "trail.ts", "typescript");
    expect(r.symbols.find((s) => s.name === "f")!.docComment).toBeNull();
  });

  it("does not treat a Python f-string as a docstring", async () => {
    const src = `def f(name):
    f"hello {name}"
    return name
`;
    const r = await chunkCode(src, "fstr.py", "python");
    expect(r.symbols[0]!.docComment).toBeNull();
  });

  it("captures a Python docstring as the doc comment", async () => {
    const src = `def alpha(x):
    """Return x incremented by one."""
    return x + 1
`;
    const r = await chunkCode(src, "p.py", "python");
    expect(r.symbols[0]!.docComment).toBe("Return x incremented by one.");
  });

  it("captures a class docstring and is null for a method without one", async () => {
    const src = `class Beta:
    """Beta does beta things."""
    def gamma(self):
        return 1
`;
    const r = await chunkCode(src, "b.py", "python");
    expect(r.symbols.find((s) => s.name === "Beta")!.docComment).toBe(
      "Beta does beta things.",
    );
    expect(r.symbols.find((s) => s.name === "gamma")!.docComment).toBeNull();
  });
});

describe("chunkCode (Python)", () => {
  it("extracts top-level def + class with methods", async () => {
    const src = `def alpha(x):
    return x + 1

class Beta:
    def gamma(self):
        return 1
    def delta(self):
        return 2
`;
    const r = await chunkCode(src, "p.py", "python");
    const names = r.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["Beta", "alpha", "delta", "gamma"]);
    const gamma = r.symbols.find((s) => s.name === "gamma")!;
    expect(gamma.enclosing).toBe("Beta");
    expect(gamma.parentSymbolPath).toEqual(["Beta"]);
  });

  it("handles async def", async () => {
    const src = `async def fetch_data():
    return await something()
`;
    const r = await chunkCode(src, "a.py", "python");
    expect(r.symbols.length).toBe(1);
    expect(r.symbols[0]?.name).toBe("fetch_data");
  });
});
