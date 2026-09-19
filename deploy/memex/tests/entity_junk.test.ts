/**
 * Shared junk-entity-name gate (core/entity-junk.ts) and the fact-ledger write
 * path that consults it. The gazetteer, typed-link, meeting-timeline and
 * chronicle call sites are pinned in their own suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { isJunkEntityName } from "../src/core/entity-junk.ts";
import { writeExtractedFacts, type ExtractedFact } from "../src/core/facts-extract.ts";
import { listFacts } from "../src/core/facts.ts";

describe("isJunkEntityName", () => {
  it("rejects placeholders, roles and generic nouns", () => {
    for (const name of [
      "team", "Team", "MEETING", "unknown", "user", "someone", "n/a", "N/A",
      "none", "TBD", "the user", "The Team", "**Unknown**", "`guest`", "no-one",
      "people/unknown", "companies/team", "people/me",
    ]) {
      expect(isJunkEntityName(name)).toBe(true);
    }
  });

  it("rejects pure numbers, punctuation, single characters and empties", () => {
    for (const name of ["42", "2026", "3.14", "???", "---", "x", "Z", "", "   ", null, undefined]) {
      expect(isJunkEntityName(name)).toBe(true);
    }
  });

  it("keeps real names, including ones that contain a junk word", () => {
    for (const name of [
      "Alice", "Acme", "Team Rocket", "Acme Meeting Rooms", "people/alice-smith",
      "companies/unknown-mortal-orchestra", "3M", "AC/DC", "Li", "Mark",
    ]) {
      expect(isJunkEntityName(name)).toBe(false);
    }
  });

  it("stays linear on a long adversarial input", () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) isJunkEntityName(`${"- ".repeat(59)}x`);
    expect(isJunkEntityName("a".repeat(10_000))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("writeExtractedFacts", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-entity-junk-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const fact = (entity: string | null, text: string): ExtractedFact => ({
    fact: text,
    kind: "event",
    entity,
    confidence: 0.9,
    notability: "medium",
  });

  it("skips facts whose entity is a placeholder and writes the rest", async () => {
    const r = await writeExtractedFacts(storage, [
      fact("team", "shipped the release"),
      fact("The User", "prefers dark mode"),
      fact("42", "is the answer"),
      fact("people/bob", "moved to Lisbon"),
    ]);
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(3);
    expect(await listFacts(storage, "people/bob")).toHaveLength(1);
    for (const slug of ["team", "the-user", "42"]) {
      expect(await listFacts(storage, slug)).toHaveLength(0);
    }
  });
});
