/**
 * Advisor ranking + run resilience — pure logic, no engine. Asserts the
 * severity ladder, stable collector-order tie-break, info-tail cap, and that a
 * throwing collector never aborts the report.
 */
import { describe, expect, it } from "bun:test";
import { rankFindings, runAdvisor, COLLECTORS } from "../src/core/advisor/run.ts";
import type { AdvisorContext, AdvisorFinding, AdvisorSeverity } from "../src/core/advisor/types.ts";

const f = (
  id: string,
  severity: AdvisorSeverity,
  collector: string,
): AdvisorFinding => ({ id, severity, title: id, collector });

describe("rankFindings", () => {
  it("orders high > medium > low > info", () => {
    const out = rankFindings([
      f("a", "info", "migration"),
      f("b", "high", "migration"),
      f("c", "low", "migration"),
      f("d", "medium", "migration"),
    ]);
    expect(out.map((x) => x.severity)).toEqual(["high", "medium", "low", "info"]);
  });

  it("breaks ties by collector declaration order (stable)", () => {
    // Two same-severity findings from different collectors: the one whose
    // collector appears earlier in COLLECTORS wins.
    const first = COLLECTORS[0]!.id;
    const last = COLLECTORS[COLLECTORS.length - 1]!.id;
    const out = rankFindings([f("late", "medium", last), f("early", "medium", first)]);
    expect(out.map((x) => x.id)).toEqual(["early", "late"]);
  });

  it("caps the info tail", () => {
    const many: AdvisorFinding[] = [];
    for (let i = 0; i < 25; i++) many.push(f(`i${i}`, "info", "migration"));
    expect(rankFindings(many, { infoCap: 3 }).length).toBe(3);
  });

  it("never drops a non-info finding", () => {
    const out = rankFindings(
      [f("hi", "high", "migration"), ...Array.from({ length: 20 }, (_, i) => f(`i${i}`, "info", "migration"))],
      { infoCap: 2 },
    );
    expect(out.filter((x) => x.severity === "high").length).toBe(1);
    expect(out.filter((x) => x.severity === "info").length).toBe(2);
  });
});

describe("runAdvisor", () => {
  it("survives a throwing collector and still ranks the rest", async () => {
    // Build a context whose engine.query throws — every engine-backed collector
    // fails, but the report is still well-formed (empty, not a crash).
    const ctx: AdvisorContext = {
      engine: {
        kind: "pglite",
        ready: async () => {},
        query: async () => {
          throw new Error("boom");
        },
        exec: async () => {},
        close: async () => {},
        transaction: async () => {
          throw new Error("boom");
        },
      },
      version: "9.9.9",
      now: new Date("2026-06-22T00:00:00.000Z"),
    };
    const report = await runAdvisor(ctx);
    expect(report.version).toBe("9.9.9");
    expect(report.generated_at).toBe("2026-06-22T00:00:00.000Z");
    expect(Array.isArray(report.findings)).toBe(true);
    // version_drift fires deterministically (9.9.9 != package.json), proving the
    // pipeline completed despite the engine throwing for the others.
    expect(report.findings.some((x) => x.id === "version_drift")).toBe(true);
    expect(report.worst).not.toBeNull();
  });
});
