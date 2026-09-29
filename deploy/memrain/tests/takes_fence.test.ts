/**
 * Fenced takes table parser/renderer (takes-fence.ts). Pure — no DB, no LLM.
 */
import { describe, expect, it } from "bun:test";
import {
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
  parseTakesFence,
  renderTakesFence,
  upsertTakeRow,
  supersedeRow,
  stripTakesFence,
  normalizeWeightForStorage,
  isValidHolder,
  type ParsedFenceTake,
} from "../src/core/synthesis/takes-fence.ts";

const BASIC_FENCE = `# Page

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
| 2 | Strong technical founder | take | people/alex-chen | 0.85 | 2026-04-29 | OH |
| 3 | ~~Will reach $50B~~ | bet | brain | 0.7 | 2026-04 → 2026-06 | superseded by #4 |
${TAKES_FENCE_END}

Trailing prose.
`;

describe("parseTakesFence", () => {
  it("parses a clean 7-column fence", () => {
    const { takes, warnings } = parseTakesFence(BASIC_FENCE);
    expect(warnings).toEqual([]);
    expect(takes.length).toBe(3);
    expect(takes[0]).toMatchObject({
      rowNum: 1,
      claim: "CEO of Acme",
      kind: "fact",
      holder: "world",
      weight: 1.0,
      sinceDate: "2017-01",
      source: "Crustdata",
      active: true,
    });
  });

  it("strikethrough marks the row inactive and strips the markers", () => {
    const { takes } = parseTakesFence(BASIC_FENCE);
    expect(takes[2]!.active).toBe(false);
    expect(takes[2]!.claim).toBe("Will reach $50B");
  });

  it("splits a since range into sinceDate + untilDate", () => {
    const { takes } = parseTakesFence(BASIC_FENCE);
    expect(takes[2]!.sinceDate).toBe("2026-04");
    expect(takes[2]!.untilDate).toBe("2026-06");
  });

  it("returns empty on a body without a fence", () => {
    const r = parseTakesFence("# No fence here\n\nJust prose.");
    expect(r.takes).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("warns on an unbalanced fence", () => {
    const r = parseTakesFence(`${TAKES_FENCE_BEGIN}\n| # | claim | kind |\n`);
    expect(r.takes).toEqual([]);
    expect(r.warnings.some((w) => w.includes("TAKES_FENCE_UNBALANCED"))).toBe(true);
  });

  it("skips malformed rows with warnings, keeps good rows", () => {
    const body = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Good | bet | world | 0.6 | | |
| x | Bad row_num | bet | world | 0.6 | | |
| 2 | Bad kind | banana | world | 0.6 | | |
| 3 | Bad weight | bet | world | heavy | | |
| 1 | Duplicate row_num | bet | world | 0.6 | | |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes.length).toBe(1);
    expect(takes[0]!.claim).toBe("Good");
    expect(warnings.some((w) => w.includes("invalid row_num"))).toBe(true);
    expect(warnings.some((w) => w.includes("unknown kind"))).toBe(true);
    expect(warnings.some((w) => w.includes("non-numeric weight"))).toBe(true);
    expect(warnings.some((w) => w.includes("TAKES_ROW_NUM_COLLISION"))).toBe(true);
  });

  it("warns on an invalid holder but keeps the row", () => {
    const body = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Claim | take | Alex | 0.6 | | |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes.length).toBe(1);
    expect(warnings.some((w) => w.includes("TAKES_HOLDER_INVALID"))).toBe(true);
  });

  it("parses resolution columns when the header carries them", () => {
    const body = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |
|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|
| 1 | Hit $10M ARR | bet | world | 0.7 | 2025-01 | plan | 2026-06-01 | correct | Q2 report | 12.5 | musd | operator |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(body);
    expect(warnings).toEqual([]);
    expect(takes[0]).toMatchObject({
      resolvedAt: "2026-06-01",
      resolvedQuality: "correct",
      resolvedOutcome: true,
      resolvedEvidence: "Q2 report",
      resolvedValue: 12.5,
      resolvedUnit: "musd",
      resolvedBy: "operator",
    });
  });
});

describe("isValidHolder", () => {
  it("accepts the canonical grammar + legacy bare slugs", () => {
    for (const h of ["world", "brain", "people/alex-chen", "companies/acme.io", "people/foo_bar", "alex"]) {
      expect(isValidHolder(h)).toBe(true);
    }
  });
  it("rejects the eval-flagged error modes", () => {
    for (const h of ["Alex", "people/Alex-Chen", "world/alex-chen", "users/alex", ""]) {
      expect(isValidHolder(h)).toBe(false);
    }
  });
});

describe("normalizeWeightForStorage", () => {
  it("defaults to 0.5 without clamping on null/undefined", () => {
    expect(normalizeWeightForStorage(undefined)).toEqual({ weight: 0.5, clamped: false });
    expect(normalizeWeightForStorage(null)).toEqual({ weight: 0.5, clamped: false });
  });
  it("clamps out-of-range and non-finite values", () => {
    expect(normalizeWeightForStorage(1.7)).toEqual({ weight: 1, clamped: true });
    expect(normalizeWeightForStorage(-2)).toEqual({ weight: 0, clamped: true });
    expect(normalizeWeightForStorage(Number.NaN)).toEqual({ weight: 0.5, clamped: true });
  });
  it("rounds to the 0.05 grid without setting clamped", () => {
    expect(normalizeWeightForStorage(0.74)).toEqual({ weight: 0.75, clamped: false });
    expect(normalizeWeightForStorage(0.82)).toEqual({ weight: 0.8, clamped: false });
    expect(normalizeWeightForStorage(1)).toEqual({ weight: 1, clamped: false });
    expect(normalizeWeightForStorage(0)).toEqual({ weight: 0, clamped: false });
  });
});

describe("render round-trip", () => {
  it("parse(render(takes)) is lossless, including resolution fields", () => {
    const { takes } = parseTakesFence(BASIC_FENCE);
    takes[1] = {
      ...takes[1]!,
      resolvedAt: "2026-07-01",
      resolvedQuality: "partial",
      resolvedEvidence: "mixed outcome",
    };
    const rendered = renderTakesFence(takes);
    const reparsed = parseTakesFence(rendered);
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.takes).toEqual(takes);
  });

  it("keeps the narrow 7-column shape when nothing is resolved", () => {
    const { takes } = parseTakesFence(BASIC_FENCE);
    const rendered = renderTakesFence(takes);
    expect(rendered).not.toContain("| quality |");
  });

  it("escapes pipes inside cells so sibling rows survive", () => {
    const rows: ParsedFenceTake[] = [
      { rowNum: 1, claim: "a | b", kind: "take", holder: "world", weight: 0.5, active: true },
      { rowNum: 2, claim: "clean", kind: "bet", holder: "world", weight: 0.6, active: true },
    ];
    const rendered = renderTakesFence(rows);
    // Escape-on-write keeps the table shape; parse-back of embedded pipes is
    // not supported (same contract as the shared fence primitives).
    expect(rendered).toContain("a \\| b");
    const reparsed = parseTakesFence(rendered);
    expect(reparsed.takes.some((t) => t.rowNum === 2 && t.claim === "clean")).toBe(true);
  });
});

describe("upsertTakeRow", () => {
  it("appends with the next row number", () => {
    const { body, rowNum } = upsertTakeRow(BASIC_FENCE, {
      claim: "New claim",
      kind: "hunch",
      holder: "brain",
      weight: 0.4,
      active: true,
    });
    expect(rowNum).toBe(4);
    const { takes } = parseTakesFence(body);
    expect(takes.length).toBe(4);
    expect(takes[3]!.claim).toBe("New claim");
  });

  it("creates a Takes section when the body has no fence", () => {
    const { body, rowNum } = upsertTakeRow("# Fresh page\n", {
      claim: "First",
      kind: "take",
      holder: "world",
      weight: 0.6,
      active: true,
    });
    expect(rowNum).toBe(1);
    expect(body).toContain("## Takes");
    expect(parseTakesFence(body).takes.length).toBe(1);
  });
});

describe("supersedeRow", () => {
  it("strikes the old row and appends the replacement", () => {
    const { body, oldRowNum, newRowNum } = supersedeRow(BASIC_FENCE, 2, {
      claim: "Even stronger founder",
      kind: "take",
      holder: "people/alex-chen",
      weight: 0.9,
    });
    expect(oldRowNum).toBe(2);
    expect(newRowNum).toBe(4);
    const { takes } = parseTakesFence(body);
    expect(takes.find((t) => t.rowNum === 2)!.active).toBe(false);
    const added = takes.find((t) => t.rowNum === 4)!;
    expect(added.claim).toBe("Even stronger founder");
    expect(added.source).toBe("superseded by #4");
  });

  it("throws when the target row is missing", () => {
    expect(() =>
      supersedeRow(BASIC_FENCE, 99, {
        claim: "x",
        kind: "take",
        holder: "world",
        weight: 0.5,
      }),
    ).toThrow(/not found/);
  });
});

describe("stripTakesFence", () => {
  it("removes exactly the fenced block", () => {
    const stripped = stripTakesFence(BASIC_FENCE);
    expect(stripped).not.toContain("memex:takes:begin");
    expect(stripped).not.toContain("CEO of Acme");
    expect(stripped).toContain("Trailing prose.");
  });
  it("is a no-op without a fence", () => {
    expect(stripTakesFence("plain body")).toBe("plain body");
  });
});
