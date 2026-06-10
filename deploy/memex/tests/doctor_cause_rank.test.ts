/**
 * Doctor cause-ranking — unit tests for rankIssues ordering + the
 * downstream_of honesty contract (only set when the named root is also
 * failing).
 */
import { describe, expect, it } from "bun:test";
import { rankIssues } from "../src/core/doctor-cause-rank.ts";

describe("rankIssues", () => {
  it("returns nothing when every check is ok", () => {
    expect(
      rankIssues([
        { name: "config", ok: true },
        { name: "stats", ok: true },
      ]),
    ).toEqual([]);
  });

  it("orders roots before symptoms, then by name", () => {
    const ranked = rankIssues([
      { name: "vault", ok: false }, // ops symptom
      { name: "pglite", ok: false }, // root
      { name: "stats", ok: false }, // symptom (downstream of pglite)
    ]);
    expect(ranked.map((r) => r.name)).toEqual(["pglite", "stats", "vault"]);
    expect(ranked[0]!.tier).toBe("root");
  });

  it("sets downstream_of ONLY when the named root is also failing", () => {
    // pglite (the root) is failing → stats is annotated as downstream.
    const withRoot = rankIssues([
      { name: "pglite", ok: false },
      { name: "stats", ok: false },
    ]);
    expect(withRoot.find((r) => r.name === "stats")!.downstream_of).toBe("pglite");

    // pglite is OK → stats failing alone carries NO causal claim.
    const withoutRoot = rankIssues([
      { name: "pglite", ok: true },
      { name: "stats", ok: false },
    ]);
    expect(withoutRoot.find((r) => r.name === "stats")!.downstream_of).toBeUndefined();
  });

  it("never invents an edge for an independent ops failure", () => {
    const ranked = rankIssues([{ name: "vault", ok: false }]);
    expect(ranked).toEqual([{ name: "vault", tier: "symptom" }]);
  });
});
