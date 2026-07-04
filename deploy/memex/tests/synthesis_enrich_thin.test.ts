/**
 * Enrich-thin phase — hermetic (injected SonnetFn, no Bedrock). Covers the flag
 * gate, insufficient-evidence skip, grounded stub → fuller-page rewrite, and the
 * sanitizeForPrompt `.text` unwrap regression guard ([object Object]).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { enrichThinPhase } from "../src/core/synthesis/enrich-thin.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 200, outputTokens: 120 },
  };
};

async function link(source: string, target: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO links (source_slug, target_slug, type) VALUES ($1, $2, 'wikilink')`,
    [source, target],
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-enrich-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_ENRICH_THIN;
});

describe("enrichThinPhase", () => {
  it("is default-OFF without the flag and no injected sonnetFn", async () => {
    delete process.env.MEMEX_ENRICH_THIN;
    await putPage(storage, { slug: "people/alice", type: "person", title: "Alice", markdown_body: "stub", source_id: "default" });
    const r = await enrichThinPhase(storage, {});
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("MEMEX_ENRICH_THIN");
  });

  it("skips a thin page with no neighbour evidence", async () => {
    await putPage(storage, { slug: "people/bob", type: "person", title: "Bob", markdown_body: "a short stub about Bob", source_id: "default" });
    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet("{}") });
    expect(r.thinPagesConsidered).toBe(1);
    expect(r.pagesSkippedInsufficient).toBe(1);
    expect(r.pagesEnriched).toBe(0);
  });

  it("expands a stub from neighbour evidence and rewrites the page", async () => {
    await putPage(storage, { slug: "people/carol", type: "person", title: "Carol", markdown_body: "stub", source_id: "default" });
    await putPage(storage, {
      slug: "companies/acme",
      type: "company",
      title: "Acme Corp",
      markdown_body:
        "Acme Corp is a robotics company where Carol works as lead engineer. " +
        "The company builds autonomous mobile robots for warehouse logistics and " +
        "was founded in 2018. It has raised two rounds of venture funding and now " +
        "employs roughly two hundred people across engineering, sales, and support. " +
        "Carol leads the autonomy team and reports directly to the CTO.",
      source_id: "default",
    });
    await link("people/carol", "companies/acme");

    const payload = JSON.stringify({
      title: "Carol",
      markdown: "Carol is a lead engineer at [[companies/acme]], a robotics company. Her work centres on autonomy.",
    });
    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.pagesEnriched).toBe(1);

    // Prompt must carry real neighbour content — regression guard for the
    // sanitizeForPrompt `.text` unwrap (a bare object renders "[object Object]").
    expect(lastPrompt).toContain("robotics company");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, "people/carol");
    expect(page).not.toBeNull();
    expect(page!.markdown_body).toContain("[[companies/acme]]");
    expect(page!.markdown_body.length).toBeGreaterThan("stub".length);
  });

  it("rejects an expansion that does not grow the stub", async () => {
    await putPage(storage, { slug: "people/dave", type: "person", title: "Dave", markdown_body: "a reasonably sized stub about Dave here", source_id: "default" });
    await putPage(storage, { slug: "notes/n1", type: "note", title: "N1", markdown_body: "Dave is mentioned in this note about the project kickoff.", source_id: "default" });
    await link("people/dave", "notes/n1");

    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet(JSON.stringify({ markdown: "tiny" })) });
    expect(r.pagesEnriched).toBe(0);
    const page = await getPage(storage, "people/dave");
    expect(page!.markdown_body).toContain("reasonably sized stub");
  });
});
