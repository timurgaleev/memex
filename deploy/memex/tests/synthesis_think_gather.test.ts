/**
 * think GATHER-breadth helpers (Item 1) — pure, no Bedrock:
 *   - fuseTakeStreams      RRF over keyword + vector take streams
 *   - validateCitations    drop refs that match no gathered evidence (+ fallback)
 *   - renderTrajectoryBlock / renderCalibrationBlock  prompt sub-blocks
 *   - buildThinkUserMessage injects the trajectory + calibration blocks
 */
import { describe, expect, it } from "bun:test";
import {
  fuseTakeStreams,
  validateCitations,
  renderTrajectoryBlock,
  renderCalibrationBlock,
  buildThinkUserMessage,
  type ThinkCitation,
} from "../src/core/synthesis/think.ts";
import type { TrajectoryPoint } from "../src/core/insights.ts";

const takeRow = (key: string) => ({
  take_key: key,
  claim_text: `claim ${key}`,
  kind: "prediction",
  weight: 0.6,
  domain: null,
});

describe("fuseTakeStreams", () => {
  it("dedups by take_key and ranks a take appearing in both streams first", () => {
    const kw = [takeRow("a"), takeRow("b")];
    const vec = [takeRow("b"), takeRow("c")]; // b is in both → highest fused score
    const fused = fuseTakeStreams(kw, vec, 10);
    expect(fused.map((t) => t.take_key)).toEqual(["b", "a", "c"]);
  });

  it("respects the limit", () => {
    const kw = [takeRow("a"), takeRow("b"), takeRow("c")];
    expect(fuseTakeStreams(kw, [], 2)).toHaveLength(2);
  });

  it("empty vector stream returns the keyword order untouched", () => {
    const kw = [takeRow("a"), takeRow("b")];
    expect(fuseTakeStreams(kw, [], 10).map((t) => t.take_key)).toEqual(["a", "b"]);
  });
});

describe("validateCitations", () => {
  const evidence = { pageRefs: ["notes/plan.md", "people/alice.md"], takeRefs: ["abc123def456"] };

  it("keeps exact page + take matches", () => {
    const cites: ThinkCitation[] = [
      { ref: "notes/plan.md", kind: "page" },
      { ref: "abc123def456", kind: "take" },
    ];
    const { citations, dropped } = validateCitations(cites, evidence);
    expect(dropped).toEqual([]);
    expect(citations).toHaveLength(2);
  });

  it("drops a fabricated ref that matches nothing", () => {
    const { citations, dropped } = validateCitations(
      [{ ref: "made/up.md", kind: "page" }],
      evidence,
    );
    expect(citations).toEqual([]);
    expect(dropped).toEqual(["made/up.md"]);
  });

  it("recovers a basename via the slug#row fallback", () => {
    const { citations, dropped } = validateCitations(
      [{ ref: "plan.md", kind: "page" }],
      evidence,
    );
    expect(dropped).toEqual([]);
    expect(citations).toEqual([{ ref: "notes/plan.md", kind: "page" }]);
  });

  it("recovers a shortened take-key prefix", () => {
    const { citations } = validateCitations([{ ref: "abc123de", kind: "take" }], evidence);
    expect(citations).toEqual([{ ref: "abc123def456", kind: "take" }]);
  });

  it("dedups repeated refs", () => {
    const { citations } = validateCitations(
      [
        { ref: "notes/plan.md", kind: "page" },
        { ref: "notes/plan.md", kind: "page" },
      ],
      evidence,
    );
    expect(citations).toHaveLength(1);
  });
});

describe("renderTrajectoryBlock", () => {
  const pts = (): TrajectoryPoint[] => [
    { source: "fact", at: "2024-01-02T00:00:00Z", text: "joined Acme", kind: "employment", id: 1 },
    { source: "event", at: "2024-06-01T00:00:00Z", text: "left Acme", kind: null, id: 2 },
  ];

  it("renders one entity block with dated points", () => {
    const block = renderTrajectoryBlock([{ slug: "people/alice", points: pts() }]);
    expect(block).toContain('<entity ref="people/alice">');
    expect(block).toContain("2024-01-02 (employment): joined Acme");
    expect(block).toContain("2024-06-01: left Acme");
  });

  it("omits entities with no points", () => {
    expect(renderTrajectoryBlock([{ slug: "x", points: [] }])).toBe("");
  });
});

describe("renderCalibrationBlock", () => {
  it("renders track record + patterns + tags", () => {
    const block = renderCalibrationBlock({
      accuracy: 0.72,
      total_graded: 25,
      pattern_statements: ["Over-confident on macro calls."],
      bias_tags: ["over-confident-macro"],
    });
    expect(block).toContain("72% accurate over 25 graded takes");
    expect(block).toContain("Over-confident on macro calls.");
    expect(block).toContain("over-confident-macro");
  });

  it("returns empty when there is no profile", () => {
    expect(renderCalibrationBlock(null)).toBe("");
    expect(renderCalibrationBlock({ accuracy: null, total_graded: 0, pattern_statements: [], bias_tags: [] })).toBe("");
  });
});

describe("buildThinkUserMessage", () => {
  it("injects trajectory + calibration blocks only when present", () => {
    const withBlocks = buildThinkUserMessage({
      question: "q",
      pagesBlock: "",
      takesBlock: "",
      trajectoryBlock: "T",
      calibrationBlock: "C",
    });
    expect(withBlocks).toContain("<trajectory>");
    expect(withBlocks).toContain("<calibration>");

    const bare = buildThinkUserMessage({ question: "q", pagesBlock: "", takesBlock: "" });
    expect(bare).not.toContain("<trajectory>");
    expect(bare).not.toContain("<calibration>");
  });
});
