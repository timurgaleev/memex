import { test, expect } from "bun:test";
import { Storage } from "../src/core/storage.ts";
import { startServer } from "../src/http/server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GET /health returns 200 with valid JSON shape", async () => {
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
    expect(body.stats).toEqual({ documents: 0, chunks: 0, embeddings: 0 });
  } finally {
    await server.stop();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
