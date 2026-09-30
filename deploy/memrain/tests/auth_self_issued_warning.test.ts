/**
 * `auth create` / `auth register-client` warn on stderr when the server would
 * refuse what they mint: `serve` verifies PATs and OAuth clients only with
 * auth.selfIssued.enabled. The warning changes nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";
import { runAuth, selfIssuedOffWarning } from "../src/commands/auth.ts";
import { loadConfig } from "../src/core/config.ts";

describe("selfIssuedOffWarning", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memrain-warn-"));
    configPath = join(dir, "config.json");
    await runInit({ pglite: true, configDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is null when self-issued auth is on (fresh init)", () => {
    expect(selfIssuedOffWarning(loadConfig(configPath), configPath)).toBeNull();
  });

  it("names memrain.yml when no overlay turns it on", () => {
    rmSync(join(dir, "memrain.yml"));
    const w = selfIssuedOffWarning(loadConfig(configPath), configPath);
    expect(w).toContain("tokens will not be accepted until auth.selfIssued.enabled: true is set in");
    expect(w).toContain(join(dir, "memrain.yml"));
  });

  it("names the legacy memex.yml when that is the overlay being read", () => {
    rmSync(join(dir, "memrain.yml"));
    writeFileSync(join(dir, "memex.yml"), "mcp:\n  enabled: true\n");
    const w = selfIssuedOffWarning(loadConfig(configPath), configPath);
    expect(w).toContain(join(dir, "memex.yml"));
  });

  describe("runAuth create", () => {
    let prevPath: string | undefined;
    let errors: string[];
    let origError: typeof console.error;
    let origLog: typeof console.log;

    beforeEach(() => {
      prevPath = process.env.MEMRAIN_CONFIG_PATH;
      process.env.MEMRAIN_CONFIG_PATH = configPath;
      errors = [];
      origError = console.error;
      origLog = console.log;
      console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
      console.log = () => {};
    });

    afterEach(() => {
      console.error = origError;
      console.log = origLog;
      if (prevPath === undefined) delete process.env.MEMRAIN_CONFIG_PATH;
      else process.env.MEMRAIN_CONFIG_PATH = prevPath;
    });

    it("warns on stderr and still mints the token when self-issued auth is off", async () => {
      rmSync(join(dir, "memrain.yml"));
      await runAuth(["create", "laptop"]);
      expect(errors.some((e) => e.includes("tokens will not be accepted"))).toBe(true);
    });

    it("stays quiet when self-issued auth is on", async () => {
      await runAuth(["create", "laptop"]);
      expect(errors.some((e) => e.includes("tokens will not be accepted"))).toBe(false);
    });
  });
});
