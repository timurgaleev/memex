/**
 * `## Facts` fence parse/render/strip round-trip. Pure markdown <-> rows; no
 * DB, no LLM. INERT until the extract_facts cycle phase consumes it — these
 * tests pin the format so it stays stable.
 */
import { describe, expect, it } from "bun:test";
import {
  parseFactsFence,
  renderFactsFence,
  stripFactsFence,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
} from "../src/core/facts-fence.ts";
import { DEFAULT_FACT_KIND } from "../src/core/facts-decay.ts";

const FENCE = [
  "# people/alice",
  "",
  "Some prose about Alice.",
  "",
  "## Facts",
  "",
  FACTS_FENCE_BEGIN,
  "| # | claim | confidence | source |",
  "|---|-------|------------|--------|",
  "| 1 | Founded Acme in 2017 | 1 | linkedin |",
  "| 2 | ~~Moved to Berlin~~ | 0.9 | email/x9f2 |",
  FACTS_FENCE_END,
  "",
  "More prose.",
].join("\n");

describe("facts fence — parse", () => {
  it("parses rows with rowNum, claim, confidence, source, active", () => {
    const facts = parseFactsFence(FENCE);
    expect(facts).toHaveLength(2);
    // A narrow fence names no kind, so every row carries the decay floor. The
    // old assertion expected NO kind key at all, which is what let a fence row
    // reach `entity_facts.kind` as NULL — the one value confidence decay cannot
    // see, so the row never aged.
    expect(facts[0]).toEqual({
      rowNum: 1,
      claim: "Founded Acme in 2017",
      confidence: 1,
      kind: DEFAULT_FACT_KIND,
      source: "linkedin",
      active: true,
    });
    // strikethrough → active:false, markers stripped from the claim.
    expect(facts[1]).toEqual({
      rowNum: 2,
      claim: "Moved to Berlin",
      confidence: 0.9,
      kind: DEFAULT_FACT_KIND,
      source: "email/x9f2",
      active: false,
    });
  });

  it("returns [] for a body with no fence", () => {
    expect(parseFactsFence("# page\n\njust prose, no facts")).toEqual([]);
  });

  it("returns [] for a malformed (unterminated) fence", () => {
    expect(parseFactsFence(`${FACTS_FENCE_BEGIN}\n| 1 | x | 1 | s |`)).toEqual([]);
  });

  it("clamps out-of-range / non-numeric confidence", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 | over | 9 | s |",
      "| 2 | under | -3 | s |",
      "| 3 | junk | abc | s |",
      "| 4 | empty |  | s |",
      FACTS_FENCE_END,
    ].join("\n");
    const f = parseFactsFence(md);
    expect(f.map((x) => x.confidence)).toEqual([1, 0, 1, 1]);
  });

  it("skips rows with no claim and the header row", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 |  | 1 | s |",
      "| 2 | real claim | 1 | s |",
      FACTS_FENCE_END,
    ].join("\n");
    const f = parseFactsFence(md);
    expect(f).toHaveLength(1);
    expect(f[0]!.claim).toBe("real claim");
  });
});

describe("facts fence — render round-trips", () => {
  it("render → parse is identity", () => {
    const facts: ParsedFact[] = [
      { rowNum: 1, claim: "x with | pipe", confidence: 1, source: "a", active: true },
      { rowNum: 2, claim: "retracted", confidence: 0.5, source: undefined, active: false },
    ];
    const reparsed = parseFactsFence(renderFactsFence(facts));
    expect(reparsed).toHaveLength(2);
    // The pipe in the claim survives via escape-on-write.
    expect(reparsed[0]!.claim).toBe("x with | pipe");
    expect(reparsed[0]!.active).toBe(true);
    expect(reparsed[1]!.active).toBe(false);
    expect(reparsed[1]!.source).toBeUndefined();
  });

  it("round-trips claims with backslashes and pipes (true escape inverse)", () => {
    const tricky: ParsedFact[] = [
      { rowNum: 1, claim: "ends with a backslash\\", confidence: 1, source: "s", active: true },
      { rowNum: 2, claim: "a | b \\ c \\| d", confidence: 1, source: "s", active: true },
      { rowNum: 3, claim: "path C:\\Users\\x", confidence: 1, source: undefined, active: true },
    ];
    const re = parseFactsFence(renderFactsFence(tricky));
    expect(re.map((f) => f.claim)).toEqual([
      "ends with a backslash\\",
      "a | b \\ c \\| d",
      "path C:\\Users\\x",
    ]);
  });

  it("renders an empty fence that parses to []", () => {
    expect(parseFactsFence(renderFactsFence([]))).toEqual([]);
  });
});

describe("facts fence — strip", () => {
  it("removes the fence block and the preceding ## Facts heading", () => {
    const stripped = stripFactsFence(FENCE);
    expect(stripped).not.toContain(FACTS_FENCE_BEGIN);
    expect(stripped).not.toContain("Founded Acme");
    expect(stripped).not.toMatch(/##\s+Facts/);
    // Surrounding prose is preserved.
    expect(stripped).toContain("Some prose about Alice.");
    expect(stripped).toContain("More prose.");
  });

  it("leaves a body with no fence unchanged", () => {
    const md = "# page\n\nprose only";
    expect(stripFactsFence(md)).toBe(md);
  });
});

describe("facts fence — malformed-row warnings", () => {
  it("warns for a pipe-bearing line that fails row parsing", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 | Good claim | 1 | s |",
      "2 | mangled row without leading pipe | 1 |",
      FACTS_FENCE_END,
    ].join("\n");
    const warnings: string[] = [];
    const facts = parseFactsFence(md, warnings);
    expect(facts).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unparseable table row/);
  });

  it("pipe-less prose inside the fence stays silent", () => {
    const md = [
      FACTS_FENCE_BEGIN,
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 | Good claim | 1 | s |",
      "just a stray prose line",
      FACTS_FENCE_END,
    ].join("\n");
    const warnings: string[] = [];
    expect(parseFactsFence(md, warnings)).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
});
