/**
 * init template seeding test — confirms SOUL / USER / ACCESS_POLICY /
 * HEARTBEAT land in the config dir on first init AND that running init
 * a second time over an already-initialised dir is idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";

const EXPECTED = ["SOUL.md", "USER.md", "ACCESS_POLICY.md", "HEARTBEAT.md"];

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memex-tpl-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("init template seeding", () => {
  it("seeds the four templates on first init", async () => {
    await runInit({ pglite: true, configDir: tmp });
    for (const f of EXPECTED) {
      const p = join(tmp, f);
      expect(existsSync(p)).toBe(true);
      const content = readFileSync(p, "utf8");
      expect(content).toMatch(/created:/);
      expect(content).not.toMatch(/\{\{NOW\}\}/); // placeholder substituted
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it("is idempotent — second init doesn't overwrite", async () => {
    await runInit({ pglite: true, configDir: tmp });
    const before = readFileSync(join(tmp, "SOUL.md"), "utf8");
    // Wait a tick so any timestamp inside would differ.
    await new Promise((r) => setTimeout(r, 5));
    await runInit({ pglite: true, configDir: tmp });
    const after = readFileSync(join(tmp, "SOUL.md"), "utf8");
    expect(after).toBe(before);
  });
});
