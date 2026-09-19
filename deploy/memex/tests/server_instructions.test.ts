import { describe, expect, it } from "bun:test";
import {
  MAX_INSTRUCTION_FIELD_CHARS,
  MEMEX_OPERATING_CONTRACT,
  resolveServerInfo,
  resolveServerInstructions,
} from "../src/mcp/server-instructions.ts";

describe("resolveServerInstructions", () => {
  it("returns exactly the contract when no knob is set", () => {
    expect(resolveServerInstructions({})).toBe(MEMEX_OPERATING_CONTRACT);
  });

  it("the contract names the tools it tells agents to use", () => {
    for (const tool of ["search", "page_put", "page_get", "page_append", "whoami"]) {
      expect(MEMEX_OPERATING_CONTRACT).toContain(`\`${tool}\``);
    }
  });

  it("appends the deployment identity as its own paragraph", () => {
    const out = resolveServerInstructions({
      MEMEX_DEPLOYMENT_IDENTITY: "  Team brain for the docs group.  ",
    });
    expect(out).toBe(
      `${MEMEX_OPERATING_CONTRACT}\n\nDeployment: Team brain for the docs group.`,
    );
  });

  it("appends operator guidance after the identity", () => {
    const out = resolveServerInstructions({
      MEMEX_DEPLOYMENT_IDENTITY: "Team brain.",
      MEMEX_MCP_INSTRUCTIONS: "File meeting notes under meetings/.",
    });
    expect(out).toBe(
      `${MEMEX_OPERATING_CONTRACT}\n\nDeployment: Team brain.\n\nFile meeting notes under meetings/.`,
    );
  });

  it("appends operator guidance on its own when no identity is set", () => {
    const out = resolveServerInstructions({ MEMEX_MCP_INSTRUCTIONS: "Be brief." });
    expect(out).toBe(`${MEMEX_OPERATING_CONTRACT}\n\nBe brief.`);
  });

  it("ignores whitespace-only values", () => {
    const out = resolveServerInstructions({
      MEMEX_DEPLOYMENT_IDENTITY: "   \n\t ",
      MEMEX_MCP_INSTRUCTIONS: "",
    });
    expect(out).toBe(MEMEX_OPERATING_CONTRACT);
  });

  it("caps each knob so a runaway value cannot inflate every session", () => {
    const huge = "x".repeat(50_000);
    const out = resolveServerInstructions({
      MEMEX_DEPLOYMENT_IDENTITY: huge,
      MEMEX_MCP_INSTRUCTIONS: huge,
    });
    const [, identity, guidance] = out.split("\n\n").slice(-3);
    expect(identity).toBe(`Deployment: ${"x".repeat(MAX_INSTRUCTION_FIELD_CHARS)}`);
    expect(guidance).toHaveLength(MAX_INSTRUCTION_FIELD_CHARS);
    expect(MAX_INSTRUCTION_FIELD_CHARS).toBe(2000);
  });
});

describe("resolveServerInfo", () => {
  it("reports the stamped build version", () => {
    expect(resolveServerInfo({ MEMEX_VERSION: "v9.9.9" })).toEqual({
      name: "memex",
      version: "v9.9.9",
    });
  });

  it("falls back to dev when unstamped", () => {
    expect(resolveServerInfo({}).version).toBe("dev");
  });
});
