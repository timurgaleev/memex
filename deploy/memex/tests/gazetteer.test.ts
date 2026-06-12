/**
 * Gazetteer auto-linking (#2) — build the entity gazetteer, the maximal-munch
 * body scan, and the opt-in `mentions`-edge sync that never clobbers an
 * explicit edge.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, graphNeighbors } from "../src/core/links.ts";
import {
  buildGazetteer,
  gazetteerEnabled,
  scanMentions,
  syncMentionsForPage,
} from "../src/core/gazetteer.ts";

let tmp: string;
let storage: Storage;

function clearEnv(): void {
  delete process.env.MEMEX_GAZETTEER;
}

beforeEach(async () => {
  clearEnv();
  tmp = mkdtempSync(join(tmpdir(), "memex-gaz-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  clearEnv();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function mentionTargets(src: string): Promise<string[]> {
  const links = await graphNeighbors(storage, src, {
    type: "mentions",
    direction: "outbound",
  });
  return links.map((l) => l.target_slug).sort();
}

describe("gazetteerEnabled", () => {
  it("is OFF by default, ON only on an explicit 1", () => {
    expect(gazetteerEnabled(undefined)).toBe(false);
    expect(gazetteerEnabled("")).toBe(false);
    expect(gazetteerEnabled("0")).toBe(false);
    expect(gazetteerEnabled("1")).toBe(true);
  });
});

describe("buildGazetteer", () => {
  it("includes person/company titles + aliases, excludes self + other types", async () => {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
      compiled_truth: { aliases: ["Allie"] },
    });
    await putPage(storage, { slug: "companies/acme-corp", type: "company", title: "Acme Corp" });
    await putPage(storage, { slug: "notes/standup", type: "note", title: "Standup Notes" });
    await putPage(storage, { slug: "people/bob-jones", type: "person", title: "Bob Jones" });

    const g = await buildGazetteer(storage, "people/bob-jones");
    const phrases = g.map((e) => e.phrase).sort();
    // person + company titles + alias; NOT the note; NOT the self page (bob)
    expect(phrases).toEqual(["acme corp", "alice smith", "allie"]);
    expect(g.find((e) => e.phrase === "allie")?.slug).toBe("people/alice-smith");
  });

  it("drops short / numeric / stop-word phrases and ambiguous collisions", async () => {
    await putPage(storage, { slug: "people/al", type: "person", title: "Al" }); // too short
    await putPage(storage, { slug: "companies/2024", type: "company", title: "2024" }); // numeric
    await putPage(storage, { slug: "people/team", type: "person", title: "Team" }); // stop word
    // two pages claim "Acme" → ambiguous, dropped
    await putPage(storage, { slug: "companies/acme-one", type: "company", title: "Acme" });
    await putPage(storage, { slug: "companies/acme-two", type: "company", title: "Acme" });

    const g = await buildGazetteer(storage, "journal/x");
    expect(g.map((e) => e.phrase)).toEqual([]); // all filtered or ambiguous
  });

  it("drops an over-long title (regex-bloat guard)", async () => {
    await putPage(storage, {
      slug: "people/long",
      type: "person",
      title: "a".repeat(201), // > MAX_PHRASE_LEN
    });
    await putPage(storage, { slug: "people/ok", type: "person", title: "Bob Jones" });
    const g = await buildGazetteer(storage, "journal/x");
    expect(g.map((e) => e.phrase)).toEqual(["bob jones"]);
  });
});

describe("scanMentions", () => {
  const entries = [
    { phrase: "alice smith", slug: "people/alice-smith" },
    { phrase: "alice", slug: "people/alice-other" },
    { phrase: "acme corp", slug: "companies/acme-corp" },
  ].sort((a, b) => b.phrase.length - a.phrase.length);

  it("maximal-munch: the longest phrase wins", () => {
    // "Alice Smith" must match the full name, not the bare "alice"
    expect(scanMentions("met Alice Smith today", entries)).toEqual([
      "people/alice-smith",
    ]);
  });

  it("is case-insensitive and word-boundary anchored", () => {
    expect(scanMentions("ACME CORP shipped", entries)).toEqual([
      "companies/acme-corp",
    ]);
    // substring inside a larger word must NOT match; standalone capitalized does
    expect(scanMentions("Alicela is not Alice", entries)).toEqual([
      "people/alice-other",
    ]);
  });

  it("proper-noun heuristic: a lowercase common-word usage is skipped", () => {
    // "alice" in lowercase prose is the common-word sense, not the entity
    expect(scanMentions("we will alice the deal", entries)).toEqual([]);
  });

  it("maximal-munch prefers the longest phrase across 3 lengths", () => {
    const e3 = [
      { phrase: "acme corp holdings", slug: "companies/holdings" },
      { phrase: "acme corp", slug: "companies/acme-corp" },
      { phrase: "acme", slug: "companies/acme" },
    ].sort((a, b) => b.phrase.length - a.phrase.length);
    expect(scanMentions("at Acme Corp Holdings yesterday", e3)).toEqual([
      "companies/holdings",
    ]);
    expect(scanMentions("at Acme Corp yesterday", e3)).toEqual([
      "companies/acme-corp",
    ]);
    expect(scanMentions("at Acme yesterday", e3)).toEqual(["companies/acme"]);
  });

  it("matches an accented name (unicode boundaries)", () => {
    const e = [{ phrase: "josé garcía", slug: "people/jose" }];
    expect(scanMentions("met José García today", e)).toEqual(["people/jose"]);
  });

  it("is whitespace-flexible (extra spaces / newlines in the body)", () => {
    const e = [{ phrase: "alice smith", slug: "people/alice-smith" }];
    expect(scanMentions("saw Alice  Smith", e)).toEqual(["people/alice-smith"]);
    expect(scanMentions("saw Alice\n  Smith here", e)).toEqual([
      "people/alice-smith",
    ]);
  });

  it("masks existing [[wikilink]] spans", () => {
    // the wikilink owns this reference; the gazetteer must skip it
    expect(scanMentions("see [[Alice Smith]] and Acme Corp", entries)).toEqual([
      "companies/acme-corp",
    ]);
  });

  it("dedupes to first mention per target", () => {
    expect(scanMentions("Acme Corp, then Acme Corp again", entries)).toEqual([
      "companies/acme-corp",
    ]);
  });
});

describe("syncMentionsForPage", () => {
  async function seed(): Promise<void> {
    await putPage(storage, {
      slug: "people/alice-smith",
      type: "person",
      title: "Alice Smith",
    });
    await putPage(storage, {
      slug: "companies/acme-corp",
      type: "company",
      title: "Acme Corp",
    });
    await putPage(storage, { slug: "journal/today", type: "journal" });
  }

  it("is a no-op when the flag is OFF", async () => {
    await seed();
    const r = await syncMentionsForPage(
      storage,
      "journal/today",
      "lunch with Alice Smith at Acme Corp",
    );
    expect(r).toEqual({ added: 0, removed: 0 });
    expect(await mentionTargets("journal/today")).toEqual([]);
  });

  it("creates mentions edges when enabled", async () => {
    process.env.MEMEX_GAZETTEER = "1";
    await seed();
    const r = await syncMentionsForPage(
      storage,
      "journal/today",
      "lunch with Alice Smith at Acme Corp",
    );
    expect(r.added).toBe(2);
    expect(await mentionTargets("journal/today")).toEqual([
      "companies/acme-corp",
      "people/alice-smith",
    ]);
  });

  it("never clobbers an explicit mention edge", async () => {
    process.env.MEMEX_GAZETTEER = "1";
    await seed();
    // an operator-asserted mention (link_kind NULL)
    await addLink(storage, {
      source_slug: "journal/today",
      target_slug: "people/alice-smith",
      type: "mentions",
    });
    await syncMentionsForPage(storage, "journal/today", "saw Alice Smith");
    // re-sync with a DIFFERENT body that no longer names Alice
    await syncMentionsForPage(storage, "journal/today", "visited Acme Corp");
    // Alice (explicit) survives the replace; Acme (gazetteer) added
    expect(await mentionTargets("journal/today")).toEqual([
      "companies/acme-corp",
      "people/alice-smith",
    ]);
  });

  it("replaces its own plain mentions on re-sync and excludes self", async () => {
    process.env.MEMEX_GAZETTEER = "1";
    await seed();
    await syncMentionsForPage(storage, "journal/today", "Alice Smith and Acme Corp");
    const r = await syncMentionsForPage(storage, "journal/today", "only Acme Corp now");
    expect(r.removed).toBe(2); // both prior plain mentions cleared
    expect(await mentionTargets("journal/today")).toEqual(["companies/acme-corp"]);
  });
});
