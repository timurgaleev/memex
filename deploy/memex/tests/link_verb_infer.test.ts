/**
 * Verb-context link-type inference — the deterministic regex NER (a faithful
 * port). Pure functions: per-edge verbs, the person→company page-role prior,
 * the context window, and the opt-in flag.
 */
import { describe, expect, it } from "bun:test";
import {
  inferLinkType,
  edgeContextWindow,
  linkVerbInferEnabled,
} from "../src/core/link-verb-infer.ts";

describe("inferLinkType — per-edge verbs", () => {
  it("classifies founded / invested_in / advises / works_at from the window", () => {
    expect(inferLinkType("person", "she co-founded the company in 2019")).toBe("founded");
    expect(inferLinkType("person", "the fund invested in them at seed")).toBe("invested_in");
    expect(inferLinkType("person", "serves as a technical advisor to the team")).toBe("advises");
    expect(inferLinkType("person", "a senior engineer at the firm")).toBe("works_at");
  });

  it("respects precedence founded > invested_in > advises > works_at", () => {
    // Both a founder verb and a work verb present → founded wins.
    expect(inferLinkType("person", "founded the startup and works at it daily")).toBe("founded");
    // invested + advises → invested_in wins.
    expect(inferLinkType("person", "invested in and advises the company")).toBe("invested_in");
  });

  it("falls through to mentions when no verb matches", () => {
    expect(inferLinkType("person", "had lunch near the office downtown")).toBe("mentions");
  });

  it("special-cases meeting → attended and media → mentions", () => {
    expect(inferLinkType("meeting", "anything")).toBe("attended");
    expect(inferLinkType("media", "co-founded and invested in")).toBe("mentions");
  });
});

describe("inferLinkType — person→company page-role prior", () => {
  const target = "companies/acme";
  it("biases an unverbed company ref by the page-level role", () => {
    expect(inferLinkType("person", "see [[acme]]", "she is a venture partner at the fund", target)).toBe("invested_in");
    expect(inferLinkType("person", "see [[acme]]", "serves as an advisor across the sector", target)).toBe("advises");
    expect(inferLinkType("person", "see [[acme]]", "is a staff engineer at the firm", target)).toBe("works_at");
  });

  it("does NOT fire the prior for a non-company target or a non-person page", () => {
    expect(inferLinkType("person", "no verb", "venture partner", "people/bob")).toBe("mentions");
    expect(inferLinkType("company", "no verb", "venture partner", target)).toBe("mentions");
  });

  it("prior precedence: investor > advisor > employee", () => {
    // Page text that matches BOTH partner and employee priors → invested_in.
    expect(inferLinkType("person", "no verb", "venture partner and staff engineer at", target)).toBe("invested_in");
  });
});

describe("edgeContextWindow", () => {
  it("returns a bounded window around the surface form", () => {
    const body = "x".repeat(500) + "[[acme]]" + "y".repeat(500);
    const w = edgeContextWindow(body, "[[acme]]", 240);
    expect(w).toContain("[[acme]]");
    expect(w.length).toBe(240 + "[[acme]]".length + 240);
  });
  it("returns the whole body when the surface isn't found", () => {
    expect(edgeContextWindow("short body", "[[missing]]")).toBe("short body");
  });
});

describe("linkVerbInferEnabled", () => {
  it("is OFF unless MEMEX_LINK_VERB_INFER=1", () => {
    const prev = process.env["MEMEX_LINK_VERB_INFER"];
    try {
      delete process.env["MEMEX_LINK_VERB_INFER"];
      expect(linkVerbInferEnabled()).toBe(false);
      process.env["MEMEX_LINK_VERB_INFER"] = "1";
      expect(linkVerbInferEnabled()).toBe(true);
      process.env["MEMEX_LINK_VERB_INFER"] = "0";
      expect(linkVerbInferEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["MEMEX_LINK_VERB_INFER"];
      else process.env["MEMEX_LINK_VERB_INFER"] = prev;
    }
  });
});
