/**
 * Drift phase — hermetic (injected SonnetFn, no Bedrock). Covers the flag gate,
 * the no-candidate skip, and the detect → single-LLM-judge → drift-report write
 * with the sanitizeForPrompt `.text` unwrap regression guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage } from "../src/core/pages.ts";
import { driftPhase } from "../src/core/synthesis/drift.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 400, outputTokens: 100 },
  };
};

/**
 * Seed one take whose source document was re-ingested AFTER the take was made.
 * Returns the take id (BIGSERIAL) so a fake judge can echo it.
 */
async function seedDriftedTake(claim: string, evidence: string): Promise<number> {
  const eng = storage.engine();
  await eng.query(
    `INSERT INTO documents (id, source_path, source_id, updated_at)
     VALUES ('doc1', 'notes/thesis.md', 'default', now())`,
  );
  await eng.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('ck1', 'doc1', 0, $1)`,
    [evidence],
  );
  const { rows } = await eng.query<{ id: number }>(
    `INSERT INTO synth_takes
       (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
     VALUES ('k1', 'doc1', 'h-old', 'v1', $1, 'judgment', 0.5, 'queued', 'm', now() - interval '10 days')
     RETURNING id`,
    [claim],
  );
  return Number(rows[0]!.id);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-drift-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_DRIFT;
});

describe("driftPhase", () => {
  it("is default-OFF without the flag and no injected sonnetFn", async () => {
    delete process.env.MEMEX_DRIFT;
    const r = await driftPhase(storage, {});
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("MEMEX_DRIFT");
  });

  it("skips when no take has shifted evidence", async () => {
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet("[]") });
    expect(r.ran).toBe(false);
    expect(r.candidatesConsidered).toBe(0);
  });

  it("flags a drifted take and writes a drift report", async () => {
    const id = await seedDriftedTake(
      "The project will ship in Q1.",
      "The project has been pushed to Q4 after the funding round slipped.",
    );
    const payload = JSON.stringify([
      { take_id: id, holds: false, reason: "The source now says Q4, contradicting the Q1 claim." },
    ]);
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.candidatesConsidered).toBe(1);
    expect(r.driftedFlagged).toBe(1);
    expect(r.reportSlug).toBeDefined();

    // Prompt carries the claim + current evidence — regression guard.
    expect(lastPrompt).toContain("ship in Q1");
    expect(lastPrompt).toContain("pushed to Q4");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, r.reportSlug!);
    expect(page).not.toBeNull();
    expect(page!.type).toBe("drift-report");
    expect(page!.markdown_body).toContain("ship in Q1");
  });

  it("writes no report when the judge says every take still holds", async () => {
    const id = await seedDriftedTake("Claim that still holds.", "Evidence consistent with the claim.");
    const payload = JSON.stringify([{ take_id: id, holds: true, reason: "still supported" }]);
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.driftedFlagged).toBe(0);
    expect(r.reportSlug).toBeUndefined();
  });
});
