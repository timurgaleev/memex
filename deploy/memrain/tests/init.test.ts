import { test, expect } from "bun:test";
import { runInit } from "../src/commands/init.ts";
import { loadConfig, defaultConfigPath } from "../src/core/config.ts";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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
    // Narrow the DatabaseConfig union — the assertion above is the proof.
    if (cfg.database.type !== "pglite") throw new Error("expected a pglite database config");
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

test("defaultConfigPath returns ~/.memrain/config.json on a fresh home", () => {
  // An empty home and env: the real ~ may hold a legacy ~/.memex install.
  const home = mkdtempSync(join(tmpdir(), "tb-home-"));
  try {
    expect(defaultConfigPath({}, home)).toBe(join(home, ".memrain", "config.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fresh init writes memrain.yml (0600) with self-issued auth on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-init-"));
  try {
    await runInit({ pglite: true, configDir: dir });
    const yml = join(dir, "memrain.yml");
    expect(existsSync(yml)).toBe(true);
    expect(statSync(yml).mode & 0o777).toBe(0o600);
    expect(loadConfig(join(dir, "config.json")).auth?.selfIssued?.enabled).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init does not write memrain.yml when config.json already exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-init-"));
  try {
    await runInit({ pglite: true, configDir: dir });
    rmSync(join(dir, "memrain.yml"));
    await runInit({ pglite: true, configDir: dir });
    expect(existsSync(join(dir, "memrain.yml"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh init keeps an existing memrain.yml untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-init-"));
  try {
    const yml = join(dir, "memrain.yml");
    writeFileSync(yml, "mcp:\n  enabled: true\n");
    await runInit({ pglite: true, configDir: dir });
    expect(readFileSync(yml, "utf8")).toBe("mcp:\n  enabled: true\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh init does not shadow a legacy memex.yml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-init-"));
  try {
    writeFileSync(join(dir, "memex.yml"), "auth:\n  selfIssued:\n    enabled: false\n");
    await runInit({ pglite: true, configDir: dir });
    expect(existsSync(join(dir, "memrain.yml"))).toBe(false);
    expect(loadConfig(join(dir, "config.json")).auth?.selfIssued?.enabled).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
