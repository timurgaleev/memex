/**
 * parseFrontmatter — regression for the empty-scalar bug: a bare `key:` must
 * yield "" (a string), not [] (an array), so every typeof==="string" reader of
 * a blank date:/source:/title: keeps working. Lists still parse to arrays.
 */
import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "../src/core/frontmatter.ts";

describe("parseFrontmatter empty-scalar handling", () => {
  it("yields '' for a bare key with no value", () => {
    const { frontmatter } = parseFrontmatter("---\ndate:\ntitle: Hello\n---\nbody\n");
    expect(frontmatter["date"]).toBe("");
    expect(typeof frontmatter["date"]).toBe("string");
    expect(frontmatter["title"]).toBe("Hello");
  });

  it("promotes a bare key to an array when list items follow", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ntags:\n  - a\n  - b\n---\nbody\n",
    );
    expect(frontmatter["tags"]).toEqual(["a", "b"]);
  });

  it("keeps scalar values and strips quotes", () => {
    const { frontmatter, body } = parseFrontmatter(
      `---\nsource: "gmail"\nn: 3\n---\nthe body\n`,
    );
    expect(frontmatter["source"]).toBe("gmail");
    expect(frontmatter["n"]).toBe("3");
    expect(body).toBe("the body\n");
  });

  it("returns {} when there is no frontmatter block", () => {
    const { frontmatter, body } = parseFrontmatter("no frontmatter here");
    expect(frontmatter).toEqual({});
    expect(body).toBe("no frontmatter here");
  });
});
