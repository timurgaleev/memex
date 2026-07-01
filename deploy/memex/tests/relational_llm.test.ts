/**
 * relationalRecallLlm — the paid Sonnet fallback for the relational arm.
 * Offline (PGLite), NO Bedrock: a fake sonnetFn returns a preset intent JSON.
 * Covers the default-OFF gate, the budget pre-flight skip, tolerant parse of bad
 * output, and the happy path where an LLM-extracted parse drives the SAME
 * deterministic fanout the regex arm uses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addLink } from "../src/core/links.ts";
import { putPage } from "../src/core/pages.ts";
import { BudgetTracker } from "../src/core/budget.ts";
import type { SonnetCallResult, SonnetFn } from "../src/core/llm/sonnet.ts";
import {
  parseRelationalLlmResponse,
  relationalRecallLlm,
  type RelationalLlmMeta,
} from "../src/core/search/relational-llm.ts";

let tmp: string;
let storage: Storage;

const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug).sort();

/** A fake Sonnet returning a fixed body while counting its invocations, so a
 *  test can assert BOTH the parse→fanout path AND that no call fired when gated
 *  or budget-skipped. The model id contains "sonnet" so BudgetTracker prices it. */
function fakeSonnet(body: string): { fn: SonnetFn; state: { calls: number } } {
  const state = { calls: 0 };
  const fn: SonnetFn = async (): Promise<SonnetCallResult> => {
    state.calls += 1;
    return {
      text: body,
      modelId: "eu.anthropic.claude-sonnet-test",
      usage: { inputTokens: 50, outputTokens: 20 },
    };
  };
  return { fn, state };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-relllm-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // Minimal typed graph: people/alice-smith --works_at--> companies/acme.
  await putPage(storage, {
    slug: "people/alice-smith",
    type: "person",
    title: "Alice Smith",
    markdown_body: "x",
  });
  await putPage(storage, {
    slug: "companies/acme",
    type: "company",
    title: "Acme",
    markdown_body: "x",
  });
  await addLink(storage, {
    source_slug: "people/alice-smith",
    target_slug: "companies/acme",
    type: "works_at",
    allowAdHocType: true,
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Ensure the live env gate is OFF unless a test opts in.
  delete process.env["MEMEX_RELATIONAL_LLM"];
});

describe("parseRelationalLlmResponse", () => {
  it("validates a well-formed typed intent", () => {
    const p = parseRelationalLlmResponse(
      '{"kind":"who_rel","seeds":["Acme"],"linkTypes":["works_at"],"direction":"inbound"}',
    );
    expect(p?.kind).toBe("who_rel");
    expect(p?.seeds).toEqual(["Acme"]);
    expect(p?.linkTypes).toEqual(["works_at"]);
    expect(p?.direction).toBe("inbound");
  });

  it("strips a ```json fence and recovers the object", () => {
    const p = parseRelationalLlmResponse(
      '```json\n{"kind":"connects","seeds":["alice","bob"],"linkTypes":null,"direction":"both"}\n```',
    );
    expect(p?.kind).toBe("connects");
    expect(p?.seeds).toEqual(["alice", "bob"]);
    expect(p?.linkTypes).toBeNull();
  });

  it("rejects an unknown link type (never traverse a non-existent edge)", () => {
    expect(
      parseRelationalLlmResponse(
        '{"kind":"who_rel","seeds":["Acme"],"linkTypes":["employs"],"direction":"inbound"}',
      ),
    ).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(
      parseRelationalLlmResponse('{"kind":"who_wrote","seeds":["Acme"],"linkTypes":null}'),
    ).toBeNull();
  });

  it("rejects connects with fewer than two seeds", () => {
    expect(
      parseRelationalLlmResponse('{"kind":"connects","seeds":["alice"],"linkTypes":null}'),
    ).toBeNull();
  });

  it("coerces an unrecognized direction to 'both'", () => {
    const p = parseRelationalLlmResponse(
      '{"kind":"intro","seeds":["Acme"],"linkTypes":null,"direction":"sideways"}',
    );
    expect(p?.direction).toBe("both");
  });

  it("returns null for non-JSON / empty output", () => {
    expect(parseRelationalLlmResponse("sorry, I cannot help with that")).toBeNull();
    expect(parseRelationalLlmResponse("")).toBeNull();
  });
});

describe("relationalRecallLlm", () => {
  it("drives the deterministic fanout from the LLM-extracted parse (happy path)", async () => {
    // A phrasing the regex archetypes do NOT match — the fallback classifies it.
    const { fn, state } = fakeSonnet(
      '{"kind":"who_rel","seeds":["Acme"],"linkTypes":["works_at"],"direction":"inbound"}',
    );
    let meta: RelationalLlmMeta | undefined;
    const hits = await relationalRecallLlm(storage, "give me everyone on the Acme payroll", {
      sonnetFn: fn,
      onMeta: (m) => (meta = m),
    });
    expect(slugs(hits)).toEqual(["people/alice-smith"]);
    expect(hits[0]?.relation).toBe("works_at");
    expect(hits[0]?.depth).toBe(1);
    expect(state.calls).toBe(1);
    expect(meta?.ran).toBe(true);
    expect(meta?.parsed).toBe(true);
    expect(meta?.kind).toBe("who_rel");
    expect(meta?.seedsResolved).toBe(1);
    expect(meta?.candidates).toBe(1);
    expect(meta?.spentUsd).toBeGreaterThan(0);
  });

  it("is default-OFF: no flag + no injected fn → empty arm, no spend", async () => {
    let meta: RelationalLlmMeta | undefined;
    const hits = await relationalRecallLlm(storage, "give me everyone on the Acme payroll", {
      onMeta: (m) => (meta = m),
    });
    expect(hits).toEqual([]);
    expect(meta?.ran).toBe(false);
    expect(meta?.spentUsd).toBe(0);
    expect(meta?.reason).toContain("default-OFF");
  });

  it("skips the paid call when the pre-flight budget is exhausted", async () => {
    const { fn, state } = fakeSonnet(
      '{"kind":"who_rel","seeds":["Acme"],"linkTypes":["works_at"],"direction":"inbound"}',
    );
    let meta: RelationalLlmMeta | undefined;
    const hits = await relationalRecallLlm(storage, "give me everyone on the Acme payroll", {
      sonnetFn: fn,
      budget: new BudgetTracker(0, "relational-llm-test"),
      onMeta: (m) => (meta = m),
    });
    expect(hits).toEqual([]);
    expect(state.calls).toBe(0); // never dispatched
    expect(meta?.ran).toBe(false);
    expect(meta?.budgetExhausted).toBe(true);
    expect(meta?.reason).toContain("budget");
  });

  it("returns an empty arm on unparseable model output (tolerant, never throws)", async () => {
    const { fn, state } = fakeSonnet("I don't know how to answer that.");
    let meta: RelationalLlmMeta | undefined;
    const hits = await relationalRecallLlm(storage, "who is entangled with Acme somehow", {
      sonnetFn: fn,
      onMeta: (m) => (meta = m),
    });
    expect(hits).toEqual([]);
    expect(state.calls).toBe(1); // the call fired (and was paid for)
    expect(meta?.parsed).toBe(false);
    expect(meta?.reason).toContain("validate");
  });

  it("returns an empty arm when the extracted seed resolves to no real page", async () => {
    const { fn } = fakeSonnet(
      '{"kind":"who_rel","seeds":["Nonexistent Corp"],"linkTypes":["works_at"],"direction":"inbound"}',
    );
    let meta: RelationalLlmMeta | undefined;
    const hits = await relationalRecallLlm(storage, "who is on the Nonexistent Corp team", {
      sonnetFn: fn,
      onMeta: (m) => (meta = m),
    });
    expect(hits).toEqual([]);
    expect(meta?.parsed).toBe(true);
    expect(meta?.seedsResolved).toBe(0);
  });
});
