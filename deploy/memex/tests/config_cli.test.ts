/**
 * `memex config show|get|set|unset` — the CLI wrapper over runtime_config:
 * key-alphabet gate, redacted show, --pattern bulk unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfig } from "../src/commands/config.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-config-cli-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  // The Storage.init overlay may have projected the stored keys onto this
  // process's env — scrub so later test files never see them.
  delete process.env["MEMEX_SEARCH_MODE"];
  delete process.env["MEMEX_ADMIN_TOKEN"];
});

describe("memex config CLI", () => {
  it("set + get round-trips a MEMEX_* key", async () => {
    const c1 = capture();
    let code: number;
    try {
      code = await runConfig({
        sub: "set",
        key: "MEMEX_SEARCH_MODE",
        value: "balanced",
        configPath: cfgPath,
      });
    } finally {
      c1.restore();
    }
    expect(code).toBe(0);
    const c2 = capture();
    try {
      code = await runConfig({ sub: "get", key: "MEMEX_SEARCH_MODE", configPath: cfgPath });
    } finally {
      c2.restore();
    }
    expect(code).toBe(0);
    expect(c2.out.join("")).toBe("balanced");
  });

  it("rejects a non-MEMEX key without --force", async () => {
    const c = capture();
    let code: number;
    try {
      code = await runConfig({
        sub: "set",
        key: "PATH",
        value: "/evil",
        configPath: cfgPath,
      });
    } finally {
      c.restore();
    }
    expect(code).toBe(1);
    expect(c.err.join("\n")).toContain("knob alphabet");
  });

  it("show redacts sensitive values", async () => {
    const c1 = capture();
    try {
      await runConfig({
        sub: "set",
        key: "MEMEX_ADMIN_TOKEN",
        value: "supersecret",
        configPath: cfgPath,
      });
    } finally {
      c1.restore();
    }
    // The set confirmation itself must not echo the secret.
    expect(c1.out.join("\n")).not.toContain("supersecret");
    const c2 = capture();
    try {
      await runConfig({ sub: "show", configPath: cfgPath });
    } finally {
      c2.restore();
    }
    const shown = JSON.parse(c2.out.join("\n"));
    const row = shown.entries.find((e: { key: string }) => e.key === "MEMEX_ADMIN_TOKEN");
    expect(row.value).toBe("***");
  });

  it("unset --pattern bulk-deletes by prefix; get on a gone key exits 1", async () => {
    const c1 = capture();
    let code: number;
    try {
      code = await runConfig({ sub: "unset", pattern: "MEMEX_", configPath: cfgPath });
    } finally {
      c1.restore();
    }
    expect(code).toBe(0);
    const deleted = JSON.parse(c1.out.join("\n"));
    expect(deleted.deleted).toBeGreaterThanOrEqual(2);
    const c2 = capture();
    try {
      code = await runConfig({ sub: "get", key: "MEMEX_SEARCH_MODE", configPath: cfgPath });
    } finally {
      c2.restore();
    }
    expect(code).toBe(1);
  });
});
