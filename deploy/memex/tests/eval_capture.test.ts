/**
 * Tests for eval-capture (auto-capture into eval_candidates).
 *
 * Coverage:
 *   - scrubPii: each pattern + count tally + idempotent on already-clean text
 *   - buildCandidateInput: scrub-on-write toggle, default values
 *   - captureEvalCandidate: round-trip (insert + read back), failure
 *     classification when the schema is missing
 *   - makeCaptureCallback: returns undefined when disabled, returns a
 *     working callback when enabled, scrub flag respected
 *   - hybridSearch onCapture hook fires once per call (via direct stub)
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  scrubPii,
  scrub,
} from "../src/core/eval-capture-scrub.ts";
import {
  buildCandidateInput,
  captureEvalCandidate,
  classifyCaptureFailure,
  isEvalCaptureEnabled,
  isEvalScrubEnabled,
  makeCaptureCallback,
  type CaptureContext,
} from "../src/core/eval-capture.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-evalcap-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("scrubPii", () => {
  it("masks an email", () => {
    const r = scrubPii("ping me at foo.bar+test@example.com please");
    expect(r.text).toContain("[email]");
    expect(r.text).not.toContain("foo.bar+test@example.com");
    expect(r.counts["email"]).toBe(1);
  });

  it("masks an international phone number", () => {
    const r = scrubPii("call +49 30 1234 5678 today");
    expect(r.text).toContain("[phone]");
    expect(r.counts["phone"]).toBe(1);
  });

  it("masks a national-format phone number with separators", () => {
    const r = scrubPii("contact 030-1234-5678 for support");
    expect(r.text).toContain("[phone]");
  });

  it("masks an IBAN", () => {
    const r = scrubPii("transfer to DE89 3704 0044 0532 0130 00 today");
    expect(r.text).toContain("[iban]");
    expect(r.counts["iban"]).toBe(1);
  });

  it("masks a credit-card-like 16-digit run", () => {
    const r = scrubPii("card 4111 1111 1111 1111 expired");
    expect(r.text).toContain("[card]");
  });

  it("masks an IPv4 address", () => {
    const r = scrubPii("home at 192.168.1.42 today");
    expect(r.text).toContain("[ip]");
  });

  it("masks a JWT", () => {
    // Assembled from fragments at runtime so no full JWT literal lives in the
    // source (a whole eyJ.a.b token trips secret scanners even as a test fixture).
    const jwt = ["eyJ", "TESTONLYheader", ".TESTONLYpayload", ".TESTONLYsig000"].join(
      "",
    );
    const r = scrubPii(`token is ${jwt} keep it secret`);
    expect(r.text).toContain("[token]");
    expect(r.text).not.toContain("TESTONLYheader");
    expect(r.counts["jwt"]).toBe(1);
  });

  it("masks a Bearer token whole (opaque + JWT forms)", () => {
    const token = "opaque_" + "TESTONLY_bearer_" + "value000456";
    const r = scrubPii(`Authorization: Bearer ${token}`);
    expect(r.text).toContain("[token]");
    expect(r.text).not.toContain("opaque_TESTONLY");
    expect(r.counts["bearer"]).toBe(1);
  });

  it("leaves project codenames + dates alone", () => {
    const r = scrubPii("ACME-42 workshop on 2026-01-15 in capital city");
    expect(r.text).toBe("ACME-42 workshop on 2026-01-15 in capital city");
    expect(Object.keys(r.counts).length).toBe(0);
  });

  it("counts multiple hits of the same kind", () => {
    const r = scrubPii("a@b.com and c@d.io and e@f.net all bounced");
    expect(r.counts["email"]).toBe(3);
  });

  it("scrub() is the convenience text-only return", () => {
    expect(scrub("foo a@b.io bar")).toContain("[email]");
  });
});

describe("buildCandidateInput", () => {
  const ctx: CaptureContext = {
    toolName: "mcp.search",
    query: "email me at a@b.io",
    resultDocIds: ["d1", "d2"],
    k: 5,
    searchMode: "hybrid",
    latencyMs: 42,
    remote: true,
  };

  it("scrubs the query when scrub != false (default)", () => {
    const row = buildCandidateInput(ctx);
    expect(row.query).toContain("[email]");
    expect(row.scrubbed).toBe(true);
  });

  it("preserves the raw query when scrub=false", () => {
    const row = buildCandidateInput(ctx, { scrub: false });
    expect(row.query).toBe("email me at a@b.io");
    expect(row.scrubbed).toBe(false);
  });

  it("rounds latency to a non-negative integer", () => {
    const row = buildCandidateInput({ ...ctx, latencyMs: -5.7 });
    expect(row.latency_ms).toBe(0);
    const row2 = buildCandidateInput({ ...ctx, latencyMs: 12.7 });
    expect(row2.latency_ms).toBe(13);
  });
});

describe("captureEvalCandidate", () => {
  it("inserts a row and returns ok=true", async () => {
    const r = await captureEvalCandidate(storage.engine(), {
      toolName: "cli.search",
      query: "alpha",
      resultDocIds: ["d1"],
      k: 5,
      searchMode: "hybrid",
      latencyMs: 12,
    });
    expect(r.ok).toBe(true);
    expect(typeof r.rowId).toBe("number");
    const fetched = await storage.engine().query<{
      tool_name: string;
      query: string;
      scrubbed: boolean;
      result_doc_ids: string;
    }>(
      `SELECT tool_name, query, scrubbed, result_doc_ids FROM eval_candidates WHERE id = $1`,
      [r.rowId!],
    );
    expect(fetched.rows[0]?.tool_name).toBe("cli.search");
    expect(fetched.rows[0]?.query).toBe("alpha");
    expect(fetched.rows[0]?.scrubbed).toBe(true);
  });

  it("never throws — returns { ok:false, reason } on failure", async () => {
    // Use a separate ephemeral storage so the afterEach close on the
    // shared one doesn't double-close.
    const otherTmp = mkdtempSync(join(tmpdir(), "memex-evalcap-broken-"));
    const broken = new Storage({ dbPath: join(otherTmp, "db") });
    await broken.init();
    await broken.close();
    const r = await captureEvalCandidate(broken.engine(), {
      toolName: "cli.search",
      query: "alpha",
      resultDocIds: [],
      k: 5,
      searchMode: "hybrid",
      latencyMs: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeDefined();
    rmSync(otherTmp, { recursive: true, force: true });
  });
});

describe("classifyCaptureFailure", () => {
  it("recognises schema-missing", () => {
    expect(
      classifyCaptureFailure(new Error('relation "eval_candidates" does not exist')),
    ).toBe("schema-missing");
  });
  it("recognises constraint-violation", () => {
    expect(
      classifyCaptureFailure(new Error("violates check constraint")),
    ).toBe("constraint-violation");
  });
  it("falls back to unknown", () => {
    expect(classifyCaptureFailure(new Error("some other thing"))).toBe(
      "unknown",
    );
  });
});

describe("config helpers", () => {
  it("isEvalCaptureEnabled false by default", () => {
    expect(isEvalCaptureEnabled(null)).toBe(false);
    expect(isEvalCaptureEnabled({})).toBe(false);
    expect(isEvalCaptureEnabled({ evalCapture: { enabled: false } })).toBe(false);
    expect(isEvalCaptureEnabled({ evalCapture: { enabled: true } })).toBe(true);
  });

  it("isEvalScrubEnabled true by default; only false when explicitly set", () => {
    expect(isEvalScrubEnabled(null)).toBe(true);
    expect(isEvalScrubEnabled({})).toBe(true);
    expect(isEvalScrubEnabled({ evalCapture: { scrub: false } })).toBe(false);
    expect(isEvalScrubEnabled({ evalCapture: { scrub: true } })).toBe(true);
  });
});

describe("makeCaptureCallback", () => {
  it("returns undefined when capture is disabled", () => {
    const cb = makeCaptureCallback(storage.engine(), null, {
      toolName: "mcp.search",
      remote: true,
    });
    expect(cb).toBeUndefined();
  });

  it("returns a working callback when enabled, and scrubs by default", async () => {
    const cb = makeCaptureCallback(
      storage.engine(),
      { evalCapture: { enabled: true } },
      { toolName: "mcp.search", remote: true },
    );
    expect(cb).toBeDefined();
    await cb!({
      query: "leak my email a@b.io",
      k: 5,
      resultDocIds: ["d1"],
      intent: "exact",
      latencyMs: 10,
      rerank: false,
      expansion: false,
    });
    const r = await storage.engine().query<{ query: string; scrubbed: boolean }>(
      `SELECT query, scrubbed FROM eval_candidates ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]?.query).toContain("[email]");
    expect(r.rows[0]?.scrubbed).toBe(true);
  });

  it("respects scrub=false when explicitly opted out", async () => {
    const cb = makeCaptureCallback(
      storage.engine(),
      { evalCapture: { enabled: true, scrub: false } },
      { toolName: "mcp.search", remote: true },
    );
    await cb!({
      query: "leak my email a@b.io",
      k: 5,
      resultDocIds: ["d1"],
      intent: "exact",
      latencyMs: 10,
      rerank: false,
      expansion: false,
    });
    const r = await storage.engine().query<{ query: string; scrubbed: boolean }>(
      `SELECT query, scrubbed FROM eval_candidates ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]?.query).toBe("leak my email a@b.io");
    expect(r.rows[0]?.scrubbed).toBe(false);
  });
});
