/**
 * Config loader tests — exercise JSON-only and JSON+YAML overlay paths.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultYamlPath, loadConfig } from "../src/core/config.ts";
import type {
  DatabaseConfig,
  PGliteDatabaseConfig,
} from "../src/core/config.ts";

let tmp: string;
let jsonPath: string;

/** Narrows the database union to the pglite branch every fixture here declares. */
function pgliteDb(db: DatabaseConfig): PGliteDatabaseConfig {
  expect(db.type).toBe("pglite");
  if (db.type !== "pglite")
    throw new Error(`expected a pglite database config, got "${db.type}"`);
  return db;
}

const baseJson = {
  database: { type: "pglite", path: "/data/brain.pglite" },
  embedding: {
    provider: "bedrock-titan",
    model: "amazon.titan-embed-text-v2:0",
    region: "eu-west-1",
  },
  storage: {},
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memex-config-"));
  jsonPath = join(tmp, "config.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadConfig (JSON only)", () => {
  it("parses a minimal config", () => {
    writeFileSync(jsonPath, JSON.stringify(baseJson));
    const cfg = loadConfig(jsonPath);
    expect(pgliteDb(cfg.database).path).toBe("/data/brain.pglite");
    expect(cfg.embedding.region).toBe("eu-west-1");
    expect(cfg.vault_paths).toBeUndefined();
    expect(cfg.sweep).toBeUndefined();
  });

  it("rejects unknown db type", () => {
    writeFileSync(
      jsonPath,
      JSON.stringify({ ...baseJson, database: { type: "mysql" } }),
    );
    expect(() => loadConfig(jsonPath)).toThrow(/must be "pglite" or "postgres"/);
  });

  it("accepts postgres type without URL (URL comes from env)", () => {
    writeFileSync(
      jsonPath,
      JSON.stringify({ ...baseJson, database: { type: "postgres" } }),
    );
    const cfg = loadConfig(jsonPath);
    expect(cfg.database.type).toBe("postgres");
  });

  it("rejects invalid JSON", () => {
    writeFileSync(jsonPath, "{ not json");
    expect(() => loadConfig(jsonPath)).toThrow(/invalid JSON/);
  });
});

describe("loadConfig (with memex.yml overlay)", () => {
  it("merges YAML sections without touching db/embedding", () => {
    writeFileSync(jsonPath, JSON.stringify(baseJson));
    writeFileSync(
      defaultYamlPath(jsonPath),
      [
        "vault_paths:",
        "  synced:",
        "    - /vault",
        "  local:",
        "    - /memory",
        "sweep:",
        "  per_file_delay_ms: 50",
        "  max_files: 1000",
        "dream:",
        "  interval_s: 21600",
        "  stale_days: 30",
        "mcp:",
        "  enabled: true",
        "  rate_limit_per_minute: 60",
        "",
      ].join("\n"),
    );
    const cfg = loadConfig(jsonPath);
    expect(cfg.vault_paths?.synced).toEqual(["/vault"]);
    expect(cfg.vault_paths?.local).toEqual(["/memory"]);
    expect(cfg.sweep?.per_file_delay_ms).toBe(50);
    expect(cfg.sweep?.max_files).toBe(1000);
    expect(cfg.dream?.interval_s).toBe(21600);
    expect(cfg.dream?.stale_days).toBe(30);
    expect(cfg.mcp?.enabled).toBe(true);
    expect(cfg.mcp?.rate_limit_per_minute).toBe(60);
    // db / embedding survive
    expect(pgliteDb(cfg.database).path).toBe("/data/brain.pglite");
    expect(cfg.embedding.region).toBe("eu-west-1");
  });

  it("rejects malformed YAML", () => {
    writeFileSync(jsonPath, JSON.stringify(baseJson));
    writeFileSync(defaultYamlPath(jsonPath), "vault_paths:\n  synced: [unclosed\n");
    expect(() => loadConfig(jsonPath)).toThrow(/invalid YAML/);
  });

  it("only fills storage.vault when JSON didn't already set it", () => {
    writeFileSync(
      jsonPath,
      JSON.stringify({ ...baseJson, storage: { vault: "/vault-from-json" } }),
    );
    writeFileSync(
      defaultYamlPath(jsonPath),
      "storage:\n  vault: /vault-from-yaml\n",
    );
    const cfg = loadConfig(jsonPath);
    expect(cfg.storage.vault).toBe("/vault-from-json");
  });
});
