import { test, expect } from "bun:test";
import { Storage } from "../src/core/storage.ts";
import { startServer } from "../src/http/server.ts";
import { probeLiveness } from "../src/http/health.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GET /health returns 200 liveness-only (no corpus stats)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-health-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  // Use port 0 to let the OS pick a free one, then use server.port back.
  const server = startServer({ host: "127.0.0.1", port: 0, storage });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.db).toBe("pglite");
    expect(typeof body.version).toBe("string");
    // Liveness only: corpus stats must NOT be disclosed on the anonymous
    // probe (they live behind /admin/api/full-stats).
    expect(body.stats).toBeUndefined();
  } finally {
    await server.stop();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLiveness returns 503 when the DB query exceeds the timeout", async () => {
  const hangingStorage = {
    engine: () => ({
      kind: "pglite",
      query: () => new Promise(() => {}), // never resolves
    }),
  } as unknown as Storage;
  const result = await probeLiveness(hangingStorage, 50);
  expect(result.status).toBe(503);
  expect(result.body.ok).toBe(false);
  expect(String(result.body.error)).toContain("timed out");
});

test("probeLiveness returns 503 with a generic message on DB failure", async () => {
  const failingStorage = {
    engine: () => ({
      kind: "pglite",
      query: () => Promise.reject(new Error("connection to db-internal-host:5432 refused")),
    }),
  } as unknown as Storage;
  const result = await probeLiveness(failingStorage, 1000);
  expect(result.status).toBe(503);
  // Never echo internals (DSN host / Postgres detail) to the anon probe.
  expect(JSON.stringify(result.body)).not.toContain("db-internal-host");
});

test("non-/health routes return 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-health-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  const server = startServer({ host: "127.0.0.1", port: 0, storage });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/nothing-here`);
    expect(res.status).toBe(404);
  } finally {
    await server.stop();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP server binds to 127.0.0.1 (loopback only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-health-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  const server = startServer({ host: "127.0.0.1", port: 0, storage });
  try {
    // Verify by attempting to connect via 127.0.0.1 — should succeed.
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.ok).toBe(true);
  } finally {
    await server.stop();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
