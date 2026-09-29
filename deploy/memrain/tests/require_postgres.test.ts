/**
 * The fail-closed Postgres switch and the deploy-gate fields: with
 * MEMRAIN_REQUIRE_POSTGRES=1 no configured PGLite brain opens, `status`
 * reports the page count and the OAuth provider state, and doctor fails
 * when OAuth clients exist while the provider is off.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEngine } from "../src/core/engine/factory.ts";
import { runInit } from "../src/commands/init.ts";
import { runStatus } from "../src/commands/status.ts";
import { oauthSelfIssuedCheck } from "../src/commands/doctor.ts";
import { Storage } from "../src/core/storage.ts";
import type { Config } from "../src/core/config.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-requirepg-"));
const dbPath = join(tmp, "brain.pglite");

function pgliteConfig(extra: Partial<Config> = {}): Config {
  return {
    database: { type: "pglite", path: dbPath },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
    storage: {},
    ...extra,
  };
}

let savedFlag: string | undefined;
let savedUrl: string | undefined;

beforeEach(() => {
  savedFlag = process.env.MEMRAIN_REQUIRE_POSTGRES;
  savedUrl = process.env.MEMRAIN_POSTGRES_URL;
  delete process.env.MEMRAIN_POSTGRES_URL;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.MEMRAIN_REQUIRE_POSTGRES;
  else process.env.MEMRAIN_REQUIRE_POSTGRES = savedFlag;
  if (savedUrl === undefined) delete process.env.MEMRAIN_POSTGRES_URL;
  else process.env.MEMRAIN_POSTGRES_URL = savedUrl;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("MEMRAIN_REQUIRE_POSTGRES", () => {
  it("makes a pglite config fatal in the engine factory", () => {
    process.env.MEMRAIN_REQUIRE_POSTGRES = "1";
    expect(() => makeEngine(pgliteConfig())).toThrow(/MEMRAIN_REQUIRE_POSTGRES=1/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("keeps a postgres config without a URL fatal", () => {
    process.env.MEMRAIN_REQUIRE_POSTGRES = "1";
    expect(() => makeEngine({ ...pgliteConfig(), database: { type: "postgres" } })).toThrow(/no URL/);
  });

  it("only acts on the exact value 1", () => {
    process.env.MEMRAIN_REQUIRE_POSTGRES = "0";
    const engine = makeEngine({ ...pgliteConfig(), database: { type: "pglite", path: join(tmp, "zero") } });
    return engine.close();
  }, 30_000);

  it("refuses init --pglite and writes nothing", async () => {
    process.env.MEMRAIN_REQUIRE_POSTGRES = "1";
    const dir = join(tmp, "init-refused");
    await expect(runInit({ pglite: true, configDir: dir })).rejects.toThrow(/MEMRAIN_REQUIRE_POSTGRES=1/);
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves a caller-chosen scratch PGLite alone", async () => {
    process.env.MEMRAIN_REQUIRE_POSTGRES = "1";
    const s = new Storage({ dbPath: join(tmp, "scratch") });
    await s.init();
    await s.close();
  }, 30_000);
});

describe("status and the OAuth config guard", () => {
  const cfgDir = join(tmp, "status");
  const cfgPath = join(cfgDir, "config.json");
  const statusDb = join(cfgDir, "brain.pglite");

  beforeAll(async () => {
    mkdirSync(cfgDir, { recursive: true });
    const s = new Storage({ dbPath: statusDb });
    await s.init();
    await s.engine().query("INSERT INTO pages (slug, type, content_hash) VALUES ('notes/a', 'note', 'h1')");
    await s.close();
  }, 30_000);

  async function status(cfg: Config): Promise<Record<string, unknown>> {
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await runStatus({ configPath: cfgPath });
    } finally {
      console.log = orig;
    }
    return JSON.parse(lines.join("\n")) as Record<string, unknown>;
  }

  it("reports stats.pages, oauth_self_issued and oauth_clients_live", async () => {
    const base = { ...pgliteConfig(), database: { type: "pglite" as const, path: statusDb } };
    const off = await status(base);
    expect((off.stats as { pages: number }).pages).toBe(1);
    expect(off.oauth_self_issued).toBe(false);
    expect(off.oauth_clients_live).toBe(0);
    const on = await status({ ...base, auth: { selfIssued: { enabled: true } } });
    expect(on.oauth_self_issued).toBe(true);
  }, 30_000);

  it("fails doctor when live OAuth clients exist but the provider is off", async () => {
    const s = new Storage({ dbPath: statusDb });
    await s.init();
    try {
      expect(oauthSelfIssuedCheck(pgliteConfig(), await s.liveOauthClientCount()).status).toBe("ok");

      await s.engine().query(
        "INSERT INTO oauth_clients (client_id, client_name, deleted_at) VALUES ('gone', 'gone', NOW())",
      );
      expect(await s.liveOauthClientCount()).toBe(0);

      await s.engine().query("INSERT INTO oauth_clients (client_id, client_name) VALUES ('c1', 'c1')");
      const n = await s.liveOauthClientCount();
      expect(n).toBe(1);

      const off = oauthSelfIssuedCheck(pgliteConfig(), n);
      expect(off.status).toBe("fail");
      expect(off.ok).toBe(false);
      expect(off.detail).toContain("config.json looks recreated; data dir moved?");

      const on = oauthSelfIssuedCheck(pgliteConfig({ auth: { selfIssued: { enabled: true } } }), n);
      expect(on.status).toBe("ok");
    } finally {
      await s.close();
    }

    const after = await status({ ...pgliteConfig(), database: { type: "pglite", path: statusDb } });
    expect(after.oauth_self_issued).toBe(false);
    expect(after.oauth_clients_live).toBe(1);
  }, 30_000);
});
