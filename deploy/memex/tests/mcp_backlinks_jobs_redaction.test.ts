/**
 * MCP-ingress redaction regression test for `backlinks` and the `jobs_*`
 * read tools — the second tranche of the public-read-redaction sweep.
 *
 * `mcp_redaction.test.ts` locked the page/entity tools; a security review
 * found the SAME leak class still open on two surfaces that were never
 * threaded through the public allowlist:
 *   - `backlinks` returned `surfaceForm` — the raw note-authored wikilink
 *     display text (`[[people/jane|Jane's lawyer]]` → `Jane's lawyer`).
 *   - `jobs_get` / `jobs_list` / `jobs_logs` returned `payload` / `result`
 *     / `last_error` — arbitrary caller JSON + raw error text that can
 *     embed vault paths and note snippets.
 *
 * Both are reachable by any public-bearer holder. This file proves the
 * fix: public ingress drops the free-text fields, internal ingress keeps
 * them, and the leak-shaped guard survives a field rename.
 *
 * `backlinks` is stubbed via `mock.module` (it joins the RAG-layer
 * entity_mentions tables, which would need the indexer + Bedrock to seed);
 * the `jobs_*` tools are seeded for real via `submitJob` (pure DB, no
 * Bedrock). `dispatchTool` is imported AFTER `mock.module` so it binds the
 * stubbed backlinks core.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { submitJob } from "../src/core/jobs/dag.ts";
import { findBacklinks as _realFindBacklinks } from "../src/core/backlinks.ts";
import type { ToolCallResult } from "../src/mcp/dispatch.ts";

// Capture the real implementation at file-load time — BEFORE beforeAll's
// `mock.module` swaps it. `mock.module` is process-global and bun does NOT
// auto-restore it between test files, so without the afterAll restore below
// the stub leaks into every later file that imports findBacklinks (e.g.
// tests/backlinks.test.ts), which then sees the canned doc-1 hit and fails.
// Order-dependent: bun's full-suite loader hits this file before
// backlinks.test.ts on Linux CI but after it on macOS — hence green locally,
// red in CI until this restore was added.
const realFindBacklinks = _realFindBacklinks;

const SECRET_SURFACE = "Jane's divorce lawyer at Globex";
const SECRET_PAYLOAD = "/vault/private/acquisition-target-globex.md";
const SECRET_KEY = "index:/vault/private/acquisition-target-globex.md";

let tmp: string;
let storage: Storage;
let jobId: string;
let dispatchTool: typeof import("../src/mcp/dispatch.ts")["dispatchTool"];

beforeAll(async () => {
  // Stub the backlinks core. The canned hit carries every allowlisted
  // field plus the free-text `surfaceForm` so the public assertion is a
  // complete allowlist contract AND a leak guard.
  mock.module("../src/core/backlinks.ts", () => ({
    findBacklinks: async () => [
      {
        documentId: "doc-1",
        sourcePath: "/vault/people/jane.md",
        title: "Jane",
        mentionCount: 3,
        surfaceForm: SECRET_SURFACE,
      },
    ],
  }));
  ({ dispatchTool } = await import("../src/mcp/dispatch.ts"));

  tmp = mkdtempSync(join(tmpdir(), "memex-mcp-bl-jobs-redact-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // Seed a real job whose payload + idempotency_key carry note-derived text.
  const r = await submitJob(storage.engine(), {
    kind: "index",
    payload: { path: SECRET_PAYLOAD, note: "confidential" },
    idempotency_key: SECRET_KEY,
  });
  jobId = r.id;
});

afterAll(async () => {
  // Restore the real backlinks module so the stub cannot leak into later
  // test files (see the load-time capture comment above).
  mock.module("../src/core/backlinks.ts", () => ({
    findBacklinks: realFindBacklinks,
  }));
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

// ---------------------------------------------------------------------------
// backlinks — surfaceForm is note-authored free text
// ---------------------------------------------------------------------------

describe("dispatchTool backlinks redaction", () => {
  it("public ingress omits surfaceForm", async () => {
    const res = await dispatchTool(
      storage,
      { name: "backlinks", arguments: { name: "people/jane" } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]).not.toHaveProperty("surfaceForm");
    expect(res.content[0]!.text).not.toContain(SECRET_SURFACE);
  });

  it("public ingress preserves allowlisted metadata", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "backlinks", arguments: { name: "people/jane" } },
        { isPublic: true },
      ),
    );
    expect(out.hits[0]).toEqual({
      documentId: "doc-1",
      sourcePath: "/vault/people/jane.md",
      title: "Jane",
      mentionCount: 3,
    });
  });

  it("internal ingress keeps surfaceForm", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "backlinks",
        arguments: { name: "people/jane" },
      }),
    );
    expect(out.hits[0].surfaceForm).toBe(SECRET_SURFACE);
  });
});

// ---------------------------------------------------------------------------
// jobs_get — payload / result / last_error are arbitrary free text
// ---------------------------------------------------------------------------

describe("dispatchTool jobs_get redaction", () => {
  it("public ingress omits payload / result / last_error / idempotency_key", async () => {
    const res = await dispatchTool(
      storage,
      { name: "jobs_get", arguments: { id: jobId } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.job).not.toHaveProperty("payload");
    expect(out.job).not.toHaveProperty("result");
    expect(out.job).not.toHaveProperty("last_error");
    expect(out.job).not.toHaveProperty("idempotency_key");
    expect(res.content[0]!.text).not.toContain(SECRET_PAYLOAD);
    expect(res.content[0]!.text).not.toContain(SECRET_KEY);
  });

  it("public ingress preserves allowlisted status fields", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "jobs_get", arguments: { id: jobId } },
        { isPublic: true },
      ),
    );
    expect(out.job.id).toBe(jobId);
    expect(out.job.kind).toBe("index");
    expect(out.job).toHaveProperty("status");
  });

  it("internal ingress keeps the full payload", async () => {
    const out = payload(
      await dispatchTool(storage, { name: "jobs_get", arguments: { id: jobId } }),
    );
    expect(out.job.payload.path).toBe(SECRET_PAYLOAD);
    expect(out.job.idempotency_key).toBe(SECRET_KEY);
  });
});

// ---------------------------------------------------------------------------
// jobs_list — JobSummary carries idempotency_key (caller-derived)
// ---------------------------------------------------------------------------

describe("dispatchTool jobs_list redaction", () => {
  it("public ingress omits idempotency_key from every row", async () => {
    const res = await dispatchTool(
      storage,
      { name: "jobs_list", arguments: {} },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.jobs.length).toBeGreaterThan(0);
    for (const j of out.jobs) expect(j).not.toHaveProperty("idempotency_key");
    expect(res.content[0]!.text).not.toContain(SECRET_KEY);
  });

  it("internal ingress keeps idempotency_key", async () => {
    const out = payload(
      await dispatchTool(storage, { name: "jobs_list", arguments: {} }),
    );
    const seeded = out.jobs.find((j: any) => j.id === jobId);
    expect(seeded.idempotency_key).toBe(SECRET_KEY);
  });
});

// ---------------------------------------------------------------------------
// jobs_logs — the curated log object still carried last_error
// ---------------------------------------------------------------------------

describe("dispatchTool jobs_logs redaction", () => {
  it("public ingress omits last_error", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "jobs_logs", arguments: { id: jobId } },
        { isPublic: true },
      ),
    );
    expect(out.log).not.toHaveProperty("last_error");
    expect(out.log.id).toBe(jobId);
  });

  it("internal ingress keeps last_error (null for a fresh job)", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "jobs_logs",
        arguments: { id: jobId },
      }),
    );
    expect(out.log).toHaveProperty("last_error");
  });
});
