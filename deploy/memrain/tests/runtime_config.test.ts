/**
 * Runtime config (migration 088) — DB-plane knob store + env overlay.
 * Pins: upsert/get/unset/list, key-alphabet validation, redaction, and the
 * overlay contract (MEMRAIN_* only, real env always wins, kill switch).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  getRuntimeConfig,
  setRuntimeConfig,
  unsetRuntimeConfig,
  listRuntimeConfig,
  applyRuntimeEnvOverlay,
  isRuntimeConfigKey,
  isSensitiveConfigKey,
  redactConfigValue,
} from "../src/core/runtime-config.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-runtime-config-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ["RC_TEST_A", "RC_TEST_B", "RC_TEST_ENVWINS"]) {
    delete process.env[`MEMEX_${k}`];
    delete process.env[`MEMRAIN_${k}`];
  }
});

describe("runtime_config store", () => {
  it("set / get / upsert / unset round-trip", async () => {
    const e = storage.engine();
    await setRuntimeConfig(e, "MEMRAIN_RC_TEST_A", "1");
    expect(await getRuntimeConfig(e, "MEMRAIN_RC_TEST_A")).toBe("1");
    await setRuntimeConfig(e, "MEMRAIN_RC_TEST_A", "2"); // upsert
    expect(await getRuntimeConfig(e, "MEMRAIN_RC_TEST_A")).toBe("2");
    expect(await unsetRuntimeConfig(e, "MEMRAIN_RC_TEST_A")).toBe(1);
    expect(await unsetRuntimeConfig(e, "MEMRAIN_RC_TEST_A")).toBe(0);
    expect(await getRuntimeConfig(e, "MEMRAIN_RC_TEST_A")).toBeNull();
  });

  it("lists by prefix with LIKE metacharacters kept literal", async () => {
    const e = storage.engine();
    await setRuntimeConfig(e, "MEMRAIN_RC_TEST_A", "a");
    await setRuntimeConfig(e, "MEMRAIN_RC_TEST_B", "b");
    await setRuntimeConfig(e, "MEMRAIN_RCXTEST_C", "c"); // '_' must not match 'X'
    const rows = await listRuntimeConfig(e, "MEMRAIN_RC_TEST_");
    expect(rows.map((r) => r.key)).toEqual(["MEMRAIN_RC_TEST_A", "MEMRAIN_RC_TEST_B"]);
    await unsetRuntimeConfig(e, "MEMRAIN_RC_TEST_A");
    await unsetRuntimeConfig(e, "MEMRAIN_RC_TEST_B");
    await unsetRuntimeConfig(e, "MEMRAIN_RCXTEST_C");
  });

  it("key alphabet is locked to MEMRAIN_[A-Z0-9_]+", () => {
    expect(isRuntimeConfigKey("MEMRAIN_SEARCH_MODE")).toBe(true);
    expect(isRuntimeConfigKey("MEMRAIN_A1_B2")).toBe(true);
    expect(isRuntimeConfigKey("PATH")).toBe(false);
    expect(isRuntimeConfigKey("LD_PRELOAD")).toBe(false);
    expect(isRuntimeConfigKey("MEMRAIN_lower")).toBe(false);
    expect(isRuntimeConfigKey("MEMRAIN_")).toBe(false);
  });

  it("redacts sensitive keys and postgres URLs, not budget knobs", () => {
    expect(isSensitiveConfigKey("MEMRAIN_PUBLIC_BEARER")).toBe(true);
    expect(isSensitiveConfigKey("MEMRAIN_ADMIN_TOKEN")).toBe(true);
    expect(isSensitiveConfigKey("MEMRAIN_MAX_TOKENS")).toBe(false);
    expect(redactConfigValue("MEMRAIN_ADMIN_TOKEN", "sekret")).toBe("***");
    expect(redactConfigValue("MEMRAIN_POSTGRES_URL", "postgresql://u:pw@h/db")).toBe(
      "postgresql://u:***@h/db",
    );
    expect(redactConfigValue("MEMRAIN_SEARCH_MODE", "balanced")).toBe("balanced");
  });
});

describe("applyRuntimeEnvOverlay", () => {
  it("fills unset MEMRAIN_* vars; the real environment always wins", async () => {
    const e = storage.engine();
    delete process.env["MEMRAIN_RC_TEST_A"];
    process.env["MEMRAIN_RC_TEST_ENVWINS"] = "env-value";
    await setRuntimeConfig(e, "MEMRAIN_RC_TEST_A", "from-db");
    await setRuntimeConfig(e, "MEMRAIN_RC_TEST_ENVWINS", "from-db");
    const applied = await applyRuntimeEnvOverlay(e);
    expect(applied).toContain("MEMRAIN_RC_TEST_A");
    expect(applied).not.toContain("MEMRAIN_RC_TEST_ENVWINS");
    expect(process.env["MEMRAIN_RC_TEST_A"]).toBe("from-db");
    expect(process.env["MEMRAIN_RC_TEST_ENVWINS"]).toBe("env-value");
    await unsetRuntimeConfig(e, "MEMRAIN_RC_TEST_A");
    await unsetRuntimeConfig(e, "MEMRAIN_RC_TEST_ENVWINS");
    delete process.env["MEMEX_RC_TEST_A"];
    delete process.env["MEMRAIN_RC_TEST_A"];
  });

  it("MEMRAIN_NO_DB_CONFIG=1 skips the overlay entirely", async () => {
    const e = storage.engine();
    delete process.env["MEMRAIN_RC_TEST_B"];
    await setRuntimeConfig(e, "MEMRAIN_RC_TEST_B", "db");
    process.env["MEMRAIN_NO_DB_CONFIG"] = "1";
    try {
      const applied = await applyRuntimeEnvOverlay(e);
      expect(applied).toEqual([]);
      expect(process.env["MEMRAIN_RC_TEST_B"]).toBeUndefined();
    } finally {
      delete process.env["MEMRAIN_NO_DB_CONFIG"];
      await unsetRuntimeConfig(e, "MEMRAIN_RC_TEST_B");
    }
  });
});
