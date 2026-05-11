import { test, expect } from "bun:test";
import { runInit } from "../src/commands/init.ts";
import { loadConfig, defaultConfigPath } from "../src/core/config.ts";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("init --pglite creates config.json + brain.pglite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-init-"));
  try {
    await runInit({ pglite: true, configDir: dir });
    const configPath = join(dir, "config.json");
    expect(existsSync(configPath)).toBe(true);
    const stat = statSync(dir);
    // Mode 0o700 = owner-only access
    expect(stat.mode & 0o777).toBe(0o700);
    const cfg = loadConfig(configPath);
    expect(cfg.database.type).toBe("pglite");
    expect(cfg.database.path).toBe(join(dir, "brain.pglite"));
    expect(cfg.embedding.provider).toBe("bedrock-titan");
    expect(cfg.embedding.model).toBe("amazon.titan-embed-text-v2:0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init throws without --pglite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-init-"));
  try {
    await expect(runInit({ pglite: false, configDir: dir })).rejects.toThrow(/pglite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init is idempotent (second call is a no-op)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-init-"));
  try {
    await runInit({ pglite: true, configDir: dir });
    // Second call should NOT throw and should NOT recreate the config.
    await runInit({ pglite: true, configDir: dir });
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects missing path", () => {
  const fake = "/tmp/this-path-should-not-exist-memex-test";
  expect(() => loadConfig(fake)).toThrow(/not found/);
});

test("defaultConfigPath returns ~/.memex/config.json", () => {
  const p = defaultConfigPath();
  expect(p.endsWith(".memex/config.json")).toBe(true);
});
