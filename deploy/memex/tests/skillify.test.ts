/**
 * Tests for the skillify pipeline. The Bedrock client is stubbed so
 * the test runs offline and is deterministic.
 *
 * Coverage:
 *   - slugify: basic + edge cases
 *   - lintAndShape: clean draft, missing frontmatter, drifted fields,
 *     short body, oversized description, malformed tags
 *   - skillify(): wires the stub through draftSkill → lintAndShape
 */
import { describe, expect, it } from "bun:test";
import {
  slugify,
  lintAndShape,
  skillify,
  validateSkill,
} from "../src/core/skillify.ts";

function stubClient(text: string) {
  return {
    send: async () => ({
      output: { message: { content: [{ text }] } },
    }),
  } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
}

describe("slugify", () => {
  it("converts a sentence to kebab-case", () => {
    expect(slugify("Skill that summarises my last 5 workouts")).toBe(
      "skill-that-summarises-my-last-5-workouts",
    );
  });

  it("strips punctuation and trailing dashes", () => {
    expect(slugify("Find !!! all   broken — links!")).toBe(
      "find-all-broken-links",
    );
  });

  it("falls back to 'skill' on empty input", () => {
    expect(slugify("")).toBe("skill");
    expect(slugify("!!!")).toBe("skill");
  });

  it("caps at 60 chars", () => {
    const out = slugify("a".repeat(200));
    expect(out.length).toBeLessThanOrEqual(60);
  });
});

describe("lintAndShape", () => {
  const cleanDraft = `---
title: clean-skill
description: Use this when X happens — runs the canonical pipeline.
tags: [memory, retrieval]
---

# Clean Skill — Canonical Path

Body paragraph that's long enough to pass the body-too-short check.

## When to use

- A
- B
- C
`;

  it("passes a clean draft through with no issues", () => {
    const r = lintAndShape(cleanDraft, "clean-skill", "use this when X");
    expect(r.issues).toEqual([]);
    expect(r.markdown).toContain("title: clean-skill");
    expect(r.markdown).toContain("tags: [memory, retrieval]");
  });

  it("rebuilds frontmatter when missing", () => {
    const r = lintAndShape("# Body only\n\nNo frontmatter here.", "my-slug", "do thing");
    expect(r.issues).toContain("frontmatter-missing");
    expect(r.markdown.startsWith("---\ntitle: my-slug\n")).toBe(true);
    expect(r.markdown).toContain("tags: [skill]");
  });

  it("corrects a drifted title to the requested slug", () => {
    const drifted = cleanDraft.replace("clean-skill", "wrong-title");
    const r = lintAndShape(drifted, "clean-skill", "use this");
    expect(r.issues).toContain("title-mismatch-corrected");
    expect(r.markdown).toContain("title: clean-skill");
  });

  it("truncates oversized descriptions", () => {
    const long =
      `---\ntitle: x\ndescription: ${"y".repeat(300)}\ntags: [a]\n---\n\n# x\n\n` +
      "long enough body to bypass the short-body branch";
    const r = lintAndShape(long, "x", "fallback");
    expect(r.issues).toContain("description-truncated");
    // Should land at the cap
    const desc = /description: (.*)/.exec(r.markdown)?.[1] ?? "";
    expect(desc.length).toBeLessThanOrEqual(160);
  });

  it("normalises tags and falls back to [skill] if all are invalid", () => {
    const garbage =
      `---\ntitle: x\ndescription: d\ntags: [Foo Bar, "with space", !bad]\n---\n\n# x\n\n` +
      "long enough body to bypass the short-body branch";
    const r = lintAndShape(garbage, "x", "p");
    expect(r.issues).toContain("tags-fallback");
    expect(r.markdown).toContain("tags: [skill]");
  });

  it("scaffolds a body when the model returns nothing useful", () => {
    const empty = `---\ntitle: x\ndescription: d\ntags: [a]\n---\n\n`;
    const r = lintAndShape(empty, "x", "summarise workouts");
    expect(r.issues).toContain("body-too-short");
    expect(r.markdown).toContain("TODO: summarise workouts");
    expect(r.markdown).toContain("## When to use");
  });
});

describe("skillify (end-to-end with stub)", () => {
  it("returns final markdown using the slugified prompt", async () => {
    const draft = `---
title: skill-that-counts-workouts
description: Use to summarise the last 5 logged workouts.
tags: [fitness, recall]
---

# Skill That Counts Workouts — Recap

Pulls the most recent five logged workouts via memex.

## When to use

- User asks about recent training
- Weekly retro

## How

\`\`\`bash
/opt/memex/bin/memex search "workout" --k 5
\`\`\`

## Edge cases

- No workouts logged: tell the user
- Search fails: log friction
`;
    const r = await skillify("skill that counts workouts", {
      client: stubClient(draft),
    });
    expect(r.slug).toBe("skill-that-counts-workouts");
    expect(r.issues).toEqual([]);
    expect(r.markdown).toContain("title: skill-that-counts-workouts");
    expect(r.markdown).toContain("/opt/memex/bin/memex");
  });

  it("repairs a drifted draft and reports issues", async () => {
    const drifted = `# No frontmatter at all\n\nBody body body body body body.`;
    const r = await skillify("foo bar baz", {
      client: stubClient(drifted),
    });
    expect(r.slug).toBe("foo-bar-baz");
    expect(r.issues).toContain("frontmatter-missing");
    expect(r.markdown.startsWith("---\ntitle: foo-bar-baz")).toBe(true);
  });

  it("rejects an empty prompt", async () => {
    await expect(
      skillify("   ", { client: stubClient("anything") }),
    ).rejects.toThrow();
  });

  it("rejects an empty model response", async () => {
    await expect(
      skillify("good prompt", { client: stubClient("") }),
    ).rejects.toThrow();
  });
});

describe("validateSkill", () => {
  const goodSkill = `---
title: my-skill
description: Use to do the thing in the right circumstances.
tags: [memory, retrieval]
---

# My Skill — Canonical Path

Body paragraph that's long enough to pass the body-too-short check.

## When to use

- A
- B
`;

  it("returns ok=true with no issues for a clean skill", () => {
    const r = validateSkill(goodSkill, "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("emits frontmatter-missing as an error", () => {
    const r = validateSkill("# only body, no frontmatter", "x");
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.rule).toBe("frontmatter-missing");
    expect(r.issues[0]?.severity).toBe("error");
  });

  it("emits title-mismatch when slug doesn't match", () => {
    const r = validateSkill(goodSkill, "different-slug");
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === "title-mismatch")).toBe(true);
  });

  it("emits description-too-long as a warning, ok stays true", () => {
    const md = goodSkill.replace(
      /description: .*/,
      `description: ${"x".repeat(200)}`,
    );
    const r = validateSkill(md, "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues.find((i) => i.rule === "description-too-long")?.severity).toBe(
      "warning",
    );
  });

  it("emits tags-non-canonical as a warning when tags need normalisation", () => {
    const md = goodSkill.replace(
      /tags: .*/,
      "tags: [Memory, Retrieval]",
    );
    const r = validateSkill(md, "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.rule === "tags-non-canonical")).toBe(true);
  });

  it("emits body-too-short as a warning", () => {
    const md = `---\ntitle: x\ndescription: d\ntags: [a]\n---\n\nshort`;
    const r = validateSkill(md, "x");
    expect(r.issues.some((i) => i.rule === "body-too-short")).toBe(true);
  });
});
