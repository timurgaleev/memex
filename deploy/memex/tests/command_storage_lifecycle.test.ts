/**
 * Command handlers must close the Storage they opened — including when
 * `init()` is what failed.
 *
 * The leak is invisible from outside until you try to open the directory
 * again: PGLite refuses a second handle on a data dir this process already
 * holds, so a stranded engine turns every later command in the same process
 * into "already open in this process". That is the observable this file uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { withStorage } from "../src/commands/with-storage.ts";
import { runConfig } from "../src/commands/config.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-storage-lifecycle-"));

/** Engine stub — the failure shapes a real driver cannot be asked for. */
function stubEngine(
  log: string[],
  fails: { ready?: boolean; close?: boolean } = {},
): Engine {
  return {
    kind: "pglite",
    async ready() {
      log.push("ready");
      if (fails.ready) throw new Error("ready exploded");
    },
    async query() {
      return { rows: [] };
    },
    async exec() {},
    async close() {
      log.push("close");
      if (fails.close) throw new Error("close exploded");
    },
    async transaction<T>(fn: (tx: Engine) => Promise<T>): Promise<T> {
      return fn(this as unknown as Engine);
    },
  } as Engine;
}

function writeConfig(path: string, dbPath: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      database: { type: "pglite", path: dbPath },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
}

/**
 * A database that opens but cannot migrate: `migrations` exists with the wrong
 * shape, so the bookkeeping read fails AFTER `ready()` has already taken the
 * data-directory lock. That is the window where a missed close() strands it.
 */
async function poisonedDb(dir: string): Promise<string> {
  const dbPath = join(dir, "db");
  const seed = new PGliteEngine({ dbPath });
  await seed.ready();
  await seed.exec("CREATE TABLE migrations (bogus INT)");
  await seed.close();
  return dbPath;
}

const silenced: (() => void)[] = [];
beforeAll(() => {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  silenced.push(() => {
    console.log = origLog;
    console.error = origErr;
  });
});

afterAll(() => {
  for (const restore of silenced) restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe("withStorage", () => {
  it("closes the storage when init() throws", async () => {
    const log: string[] = [];
    const storage = new Storage(stubEngine(log, { ready: true }));
    await expect(withStorage(storage, async () => "body")).rejects.toThrow(
      "ready exploded",
    );
    expect(log).toEqual(["ready", "close"]);
  });

  it("keeps init()'s error when close() also fails", async () => {
    const log: string[] = [];
    const storage = new Storage(stubEngine(log, { ready: true, close: true }));
    await expect(withStorage(storage, async () => "body")).rejects.toThrow(
      "ready exploded",
    );
    expect(log).toEqual(["ready", "close"]);
  });

  it("leaves an injected storage alone", async () => {
    const log: string[] = [];
    const storage = new Storage(stubEngine(log, { ready: true, close: true }));
    const r = await withStorage(storage, async () => "body", { owned: false });
    expect(r).toBe("body");
    expect(log).toEqual([]);
  });
});

describe("command handlers", () => {
  it("release the data directory when init() fails mid-migration", async () => {
    const dir = mkdtempSync(join(tmp, "poisoned-"));
    const cfgPath = join(dir, "config.json");
    writeConfig(cfgPath, await poisonedDb(dir));

    const first = await runConfig({ sub: "show", configPath: cfgPath }).then(
      () => null,
      (e: Error) => e,
    );
    expect(first?.message ?? "").toContain("id");

    // The retry must hit the SAME failure. "already open in this process" here
    // means the first run kept the engine it failed to initialise.
    const second = await runConfig({ sub: "show", configPath: cfgPath }).then(
      () => null,
      (e: Error) => e,
    );
    expect(second?.message ?? "").not.toContain("already open in this process");
    expect(second?.message ?? "").toBe(first?.message ?? "");
  }, 60_000);

  it("release the data directory on the happy path", async () => {
    const dir = mkdtempSync(join(tmp, "clean-"));
    const cfgPath = join(dir, "config.json");
    writeConfig(cfgPath, join(dir, "db"));

    expect(await runConfig({ sub: "show", configPath: cfgPath })).toBe(0);
    expect(await runConfig({ sub: "show", configPath: cfgPath })).toBe(0);
  }, 120_000);
});
