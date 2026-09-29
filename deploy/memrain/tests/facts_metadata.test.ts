/**
 * Fact metadata (migration 037) — the `## Facts` fence carries
 * kind / notability / valid_from / valid_until, parsed header-driven
 * (backward-compatible with the legacy 4-column fence) and projected into
 * entity_facts by the reconcile pass.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  parseFactsFence,
  renderFactsFence,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
} from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { DEFAULT_FACT_KIND } from "../src/core/facts-decay.ts";

// ---------------------------------------------------------------------------
// parser — header-driven column mapping
// ---------------------------------------------------------------------------

describe("parseFactsFence — metadata columns", () => {
  it("parses kind / notability / valid_from / valid_until from a wide fence", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | kind | confidence | notability | valid_from | valid_until | source |",
      "|---|-------|------|------------|------------|------------|-------------|--------|",
      "| 1 | Founded Acme | event | 1 | high | 2017-01-01 | | linkedin |",
      "| 2 | Left Acme | event | 0.9 | low | | 2024-06-01 | email/x |",
      FACTS_FENCE_END,
    ].join("\n");
    const facts = parseFactsFence(md);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      rowNum: 1,
      claim: "Founded Acme",
      kind: "event",
      confidence: 1,
      notability: "high",
      validFrom: "2017-01-01",
      source: "linkedin",
      active: true,
    });
    expect(facts[0]!.validUntil).toBeUndefined();
    expect(facts[1]).toMatchObject({
      claim: "Left Acme",
      notability: "low",
      validUntil: "2024-06-01",
    });
    expect(facts[1]!.validFrom).toBeUndefined();
  });

  it("is backward-compatible with the legacy 4-column fence", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 | Old fact | 0.8 | src/a |",
      FACTS_FENCE_END,
    ].join("\n");
    const facts = parseFactsFence(md);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      claim: "Old fact",
      confidence: 0.8,
      source: "src/a",
      active: true,
    });
    // A legacy fence has no kind column, so its rows take the decay floor. The
    // old assertion wanted `undefined` here, which reached the DB as a NULL
    // kind — the shape decay skips, so those rows never aged.
    expect(facts[0]!.kind).toBe(DEFAULT_FACT_KIND);
    expect(facts[0]!.notability).toBeUndefined();
    expect(facts[0]!.validFrom).toBeUndefined();
    expect(facts[0]!.validUntil).toBeUndefined();
  });

  it("floors an unrecognized kind and drops bad notability / dates to undefined", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | kind | confidence | notability | valid_from | valid_until | source |",
      "|---|-------|------|------------|------------|------------|-------------|--------|",
      "| 1 | Bad meta | wat | 1 | huge | 2024-13-40 | not-a-date | s |",
      FACTS_FENCE_END,
    ].join("\n");
    const f = parseFactsFence(md)[0]!;
    // A hand-edited kind we cannot read is floored, not dropped: dropping it
    // (the old assertion) left the row with the NULL kind decay ignores.
    expect(f.kind).toBe(DEFAULT_FACT_KIND);
    expect(f.notability).toBeUndefined();
    expect(f.validFrom).toBeUndefined();
    expect(f.validUntil).toBeUndefined();
    expect(f.claim).toBe("Bad meta"); // the fact itself still parses
  });

  it("tolerates reordered columns (header-driven, not positional)", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| notability | claim | valid_from | confidence |",
      "|------------|-------|------------|------------|",
      "| medium | Reordered | 2020-02-02 | 0.5 |",
      FACTS_FENCE_END,
    ].join("\n");
    const f = parseFactsFence(md)[0]!;
    expect(f).toMatchObject({
      claim: "Reordered",
      notability: "medium",
      validFrom: "2020-02-02",
      confidence: 0.5,
    });
  });

  it("does not absorb a numbered data row whose claim is literally 'claim'", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 | claim | 0.9 | src/a |",
      FACTS_FENCE_END,
    ].join("\n");
    const facts = parseFactsFence(md);
    // The real header is row 0; the data row (claim text "claim") must survive.
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ rowNum: 1, claim: "claim", confidence: 0.9 });
  });

  it("parses a header-LESS legacy fence (rows lead with a number)", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| 1 | First | 0.9 | src/a |",
      "| 2 | Second | 0.8 | src/b |",
      FACTS_FENCE_END,
    ].join("\n");
    const facts = parseFactsFence(md);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ rowNum: 1, claim: "First", confidence: 0.9, source: "src/a" });
    expect(facts[1]).toMatchObject({ rowNum: 2, claim: "Second", confidence: 0.8, source: "src/b" });
  });

  it("skips a REPEATED header row in the body (does not emit it as a fact)", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| # | claim | confidence | source |",
      "| 1 | Real | 0.9 | src/a |",
      FACTS_FENCE_END,
    ].join("\n");
    const facts = parseFactsFence(md);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ rowNum: 1, claim: "Real", confidence: 0.9 });
  });

  it("rejects year-0000 dates (Postgres DATE out of range) to undefined", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | valid_from |",
      "|---|-------|------------|------------|",
      "| 1 | Ancient | 1 | 0000-01-01 |",
      FACTS_FENCE_END,
    ].join("\n");
    const f = parseFactsFence(md)[0]!;
    expect(f.validFrom).toBeUndefined();
    expect(f.claim).toBe("Ancient");
  });

  it("round-trips render → parse with metadata intact", () => {
    const input: ParsedFact[] = [
      {
        rowNum: 1,
        claim: "Pipe | in claim",
        confidence: 0.7,
        source: "src/x",
        kind: "belief",
        notability: "high",
        validFrom: "2021-03-03",
        validUntil: "2022-04-04",
        active: true,
      },
    ];
    const round = parseFactsFence(renderFactsFence(input));
    expect(round[0]).toMatchObject({
      claim: "Pipe | in claim",
      confidence: 0.7,
      source: "src/x",
      kind: "belief",
      notability: "high",
      validFrom: "2021-03-03",
      validUntil: "2022-04-04",
    });
  });
});

// ---------------------------------------------------------------------------
// reconcile — projection into entity_facts
// ---------------------------------------------------------------------------

interface MetaRow {
  fact: string;
  kind: string | null;
  notability: string | null;
  valid_from: string | null;
  valid_until: string | null;
}

describe("reconcileFactsForPage — metadata projection", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    delete process.env.MEMEX_FACTS_FENCE;
    tmp = mkdtempSync(join(tmpdir(), "memex-factmeta-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("projects fence metadata into entity_facts columns", async () => {
    const body = [
      "## Facts",
      "",
      FACTS_FENCE_BEGIN,
      "| # | claim | kind | confidence | notability | valid_from | valid_until | source |",
      "|---|-------|------|------------|------------|------------|-------------|--------|",
      "| 1 | Founded Acme | event | 1 | high | 2017-01-01 | | linkedin |",
      FACTS_FENCE_END,
    ].join("\n");
    const w = await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: body,
    });
    const res = await reconcileFactsForPage(storage, "people/alice", w.content_hash);
    expect(res.added).toBe(1);

    const r = await storage.engine().query<MetaRow>(
      `SELECT fact, kind, notability, valid_from::text AS valid_from,
              valid_until::text AS valid_until
         FROM entity_facts WHERE entity_slug = $1`,
      ["people/alice"],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      fact: "Founded Acme",
      kind: "event",
      notability: "high",
      valid_from: "2017-01-01",
      valid_until: null,
    });
  });

  it("writes NULL metadata but a decayable kind for a legacy narrow fence", async () => {
    const body = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 | Legacy | 0.9 | src/a |",
      FACTS_FENCE_END,
    ].join("\n");
    const w = await putPage(storage, {
      slug: "people/bob",
      type: "person",
      markdown_body: body,
    });
    await reconcileFactsForPage(storage, "people/bob", w.content_hash);
    const r = await storage.engine().query<MetaRow>(
      `SELECT fact, kind, notability, valid_from::text AS valid_from,
              valid_until::text AS valid_until
         FROM entity_facts WHERE entity_slug = $1`,
      ["people/bob"],
    );
    // `kind` used to be asserted NULL here. That was the bug: a fence-written
    // fact with a blank kind is invisible to decay, so it outlived every row
    // that named one. The other three columns are genuinely absent and stay NULL.
    expect(r.rows[0]).toMatchObject({
      fact: "Legacy",
      kind: DEFAULT_FACT_KIND,
      notability: null,
      valid_from: null,
      valid_until: null,
    });
  });
});
