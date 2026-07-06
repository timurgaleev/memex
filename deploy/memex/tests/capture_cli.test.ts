/**
 * `memex capture` — quick-note capture: page write + search mirror in one
 * shot. Runs against a fresh PGLite via a temp config (the call_cli idiom);
 * the mirror uses the deterministic embed seam (no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture, defaultCaptureSlug, captureSlugSegment } from "../src/commands/capture.ts";
import { Storage } from "../src/core/storage.ts";
import { getPage } from "../src/core/pages.ts";
import { deterministicEmbed } from "./det-embed.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-capture-test-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("defaultCaptureSlug", () => {
  it("kebabs the first non-empty line under capture/<date>-", () => {
    const d = new Date("2026-07-06T10:00:00Z");
    expect(defaultCaptureSlug("\n  Hello, World! Again\nrest", d)).toBe(
      "capture/2026-07-06-hello-world-again",
    );
    expect(captureSlugSegment("!!!")).toBe("note");
  });
});

describe("runCapture", () => {
  it("refuses zero or multiple content sources", async () => {
    expect(await runCapture({ configPath: cfgPath })).toBe(1);
    expect(
      await runCapture({ text: "x", stdin: true, configPath: cfgPath }),
    ).toBe(1);
  });

  it("writes the page and mirrors it into search", async () => {
    const code = await runCapture({
      text: "Retrieval beats memory\n\nA quick captured thought.",
      slug: "capture/test-note",
      type: "note",
      configPath: cfgPath,
      json: true,
      embedFn: (t) => Promise.resolve(deterministicEmbed(t)),
    });
    expect(code).toBe(0);

    const storage = new Storage(
      JSON.parse(
        (await import("node:fs")).readFileSync(cfgPath, "utf-8"),
      ),
    );
    await storage.init();
    try {
      const page = await getPage(storage, "capture/test-note");
      expect(page).not.toBeNull();
      expect(page!.markdown_body).toContain("A quick captured thought.");
      // Search mirror landed as a page:// document.
      const doc = await storage
        .engine()
        .query<{ id: string }>(
          "SELECT id FROM documents WHERE source_path = 'page://capture/test-note'",
        );
      expect(doc.rows.length).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it("reads the body from --stdin via the seam", async () => {
    const code = await runCapture({
      stdin: true,
      readStdin: () => Promise.resolve("Stdin thought body"),
      slug: "capture/stdin-note",
      configPath: cfgPath,
      embedFn: (t) => Promise.resolve(deterministicEmbed(t)),
    });
    expect(code).toBe(0);
  });
});
