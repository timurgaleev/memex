/**
 * extract_facts persist path (G36): entity_hints steering the prompt,
 * session/visibility threading into the ledger, and the opt-in persist flag
 * on extractFactsOnDemand (default stays preview-only).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { listFacts } from "../src/core/facts.ts";
import {
  extractFactsOnDemand,
  sanitizeEntityHints,
} from "../src/core/facts-extract.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-xfp-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Fake Sonnet that records its input and returns one fixed fact. */
function fakeSonnet(seen: { user?: string }): SonnetFn {
  return async (input) => {
    seen.user = input.user;
    return {
      text: JSON.stringify({
        facts: [
          {
            fact: "moved to Lisbon",
            kind: "event",
            entity: "people/bob",
            confidence: 0.9,
            notability: "medium",
          },
        ],
      }),
      modelId: "eu.anthropic.claude-sonnet-4-5-v1:0",
      usage: { inputTokens: 100, outputTokens: 30 },
    };
  };
}

describe("sanitizeEntityHints", () => {
  it("keeps slug-safe strings, drops junk, dedupes, caps", () => {
    expect(
      sanitizeEntityHints(["people/bob", "People/Bob", "b@d!", "", 7, "ok-2"]),
    ).toEqual(["people/bob", "ok-2"]);
    expect(sanitizeEntityHints("not-an-array")).toEqual([]);
  });
});

describe("extractFactsOnDemand", () => {
  it("preview mode (default) extracts without persisting", async () => {
    const seen: { user?: string } = {};
    const r = await extractFactsOnDemand("Bob said he moved to Lisbon", {
      sonnetFn: fakeSonnet(seen),
    });
    expect(r.facts).toHaveLength(1);
    expect(r.written).toBeUndefined();
    expect(await listFacts(storage, "people/bob")).toHaveLength(0);
  });

  it("threads entity hints into the prompt", async () => {
    const seen: { user?: string } = {};
    await extractFactsOnDemand("Bob said he moved to Lisbon", {
      sonnetFn: fakeSonnet(seen),
      entityHints: ["people/bob"],
    });
    expect(seen.user).toContain("people/bob");
    expect(seen.user).toContain("<turn>");
  });

  it("persist: true writes to the ledger with session + visibility", async () => {
    // A real page for the extractor's canonicalizer to land on.
    await putPage(storage, { slug: "people/bob", type: "person" });
    const seen: { user?: string } = {};
    const r = await extractFactsOnDemand("Bob said he moved to Lisbon", {
      sonnetFn: fakeSonnet(seen),
      persist: true,
      storage,
      sessionId: "topic-9",
      visibility: "world",
    });
    expect(r.written).toBe(1);
    expect(r.fact_ids).toHaveLength(1);
    const rows = await listFacts(storage, "people/bob");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_session).toBe("topic-9");
    expect(rows[0]!.visibility).toBe("world");
    expect(rows[0]!.written_by).toBe("extract-facts");
  });

  it("persist without storage throws", async () => {
    await expect(
      extractFactsOnDemand("x", { sonnetFn: fakeSonnet({}), persist: true }),
    ).rejects.toThrow(/persist requires storage/);
  });
});
