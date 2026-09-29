/**
 * Config directory and overlay resolution across the legacy and new names:
 * the lookup order, init on a legacy install, the refusal to split an
 * install across two directories, and which YAML overlay wins.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfigPath,
  defaultYamlPath,
  loadConfig,
  resolveConfigDir,
} from "../src/core/config.ts";
import { legacyDirSplit, runInit } from "../src/commands/init.ts";
import { configYamlCheck } from "../src/commands/doctor.ts";

const CONFIG = {
  database: { type: "pglite", path: "/nonexistent/brain.pglite" },
  embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
  storage: {},
};

let home: string;
let savedOverride: string | undefined;

function writeConfig(dir: string, body: object = CONFIG): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(body));
  return p;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memex-cfgpaths-"));
  savedOverride = process.env.MEMRAIN_CONFIG_PATH;
  delete process.env.MEMRAIN_CONFIG_PATH;
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env.MEMRAIN_CONFIG_PATH;
  else process.env.MEMRAIN_CONFIG_PATH = savedOverride;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveConfigDir", () => {
  it("prefers the config-path override, as a file path", () => {
    const env = { MEMRAIN_CONFIG_PATH: "/srv/brain/custom.json" };
    writeConfig(join(home, ".memrain"));
    expect(resolveConfigDir(env, home)).toBe("/srv/brain");
    expect(defaultConfigPath(env, home)).toBe("/srv/brain/custom.json");
  });

  it("ignores an empty override", () => {
    writeConfig(join(home, ".memrain"));
    expect(resolveConfigDir({ MEMRAIN_CONFIG_PATH: "" }, home)).toBe(join(home, ".memrain"));
  });

  it("takes ~/.memrain over ~/.memex when both hold config.json", () => {
    writeConfig(join(home, ".memex"));
    writeConfig(join(home, ".memrain"));
    expect(resolveConfigDir({}, home)).toBe(join(home, ".memrain"));
  });

  it("falls back to ~/.memex when only it holds config.json", () => {
    writeConfig(join(home, ".memex"));
    mkdirSync(join(home, ".memrain"));
    expect(resolveConfigDir({}, home)).toBe(join(home, ".memex"));
    expect(defaultConfigPath({}, home)).toBe(join(home, ".memex", "config.json"));
  });

  it("uses the fresh-install default when neither holds config.json", () => {
    expect(resolveConfigDir({}, home)).toBe(join(home, ".memrain"));
  });
});

describe("init on a legacy install", () => {
  it("reports the legacy config as already initialized and creates nothing new", async () => {
    const cfg = writeConfig(join(home, ".memex"));
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await runInit({ pglite: true, home });
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toContain(`already initialized at ${cfg}`);
    expect(existsSync(join(home, ".memrain"))).toBe(false);
  });
});

describe("init on a fresh home", () => {
  it("creates the install under ~/.memrain and nothing under ~/.memex", async () => {
    const orig = console.log;
    console.log = () => {};
    try {
      await runInit({ pglite: true, home });
    } finally {
      console.log = orig;
    }
    expect(existsSync(join(home, ".memrain", "config.json"))).toBe(true);
    expect(existsSync(join(home, ".memex"))).toBe(false);
  }, 30_000);
});

describe("legacyDirSplit", () => {
  it("refuses when ~/.memex holds only brain.pglite and prints the mv", () => {
    mkdirSync(join(home, ".memex", "brain.pglite"), { recursive: true });
    const chosen = join(home, ".memrain");
    const msg = legacyDirSplit(chosen, home);
    expect(msg).not.toBeNull();
    expect(msg).toContain(`mv ${join(home, ".memex")} ${chosen}`);
  });

  it("does not refuse when the legacy dir is absent or empty", () => {
    expect(legacyDirSplit(join(home, ".memrain"), home)).toBeNull();
    mkdirSync(join(home, ".memex"));
    expect(legacyDirSplit(join(home, ".memrain"), home)).toBeNull();
  });

  it("does not refuse when the chosen dir already holds config.json", () => {
    mkdirSync(join(home, ".memex", "brain.pglite"), { recursive: true });
    writeConfig(join(home, ".memrain"));
    expect(legacyDirSplit(join(home, ".memrain"), home)).toBeNull();
  });

  it("does not refuse when both names are one directory (same inode)", () => {
    mkdirSync(join(home, ".memex", "brain.pglite"), { recursive: true });
    symlinkSync(join(home, ".memex"), join(home, ".memrain"));
    expect(legacyDirSplit(join(home, ".memrain"), home)).toBeNull();
  });

  it("does not apply to an explicit config dir", async () => {
    mkdirSync(join(home, ".memex", "brain.pglite"), { recursive: true });
    const dir = join(home, "elsewhere");
    const orig = console.log;
    console.log = () => {};
    try {
      await runInit({ pglite: true, configDir: dir, home });
    } finally {
      console.log = orig;
    }
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  }, 30_000);
});

describe("YAML overlay precedence", () => {
  it("reads memrain.yml over memex.yml without merging, and doctor warns", () => {
    const cfg = writeConfig(join(home, ".memex"));
    writeFileSync(join(home, ".memex", "memex.yml"), "mcp:\n  enabled: true\nsweep:\n  max_files: 7\n");
    writeFileSync(join(home, ".memex", "memrain.yml"), "mcp:\n  enabled: false\n");
    expect(defaultYamlPath(cfg)).toBe(join(home, ".memex", "memrain.yml"));
    const loaded = loadConfig(cfg);
    expect(loaded.mcp?.enabled).toBe(false);
    expect(loaded.sweep).toBeUndefined();
    const check = configYamlCheck(cfg);
    expect(check.status).toBe("warn");
    expect(check.ok).toBe(true);
  });

  it("still reads a lone memex.yml", () => {
    const cfg = writeConfig(join(home, ".memex"));
    writeFileSync(join(home, ".memex", "memex.yml"), "mcp:\n  enabled: false\n");
    expect(defaultYamlPath(cfg)).toBe(join(home, ".memex", "memex.yml"));
    expect(loadConfig(cfg).mcp?.enabled).toBe(false);
    expect(configYamlCheck(cfg).status).toBe("ok");
  });
});
