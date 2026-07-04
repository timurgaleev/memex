/**
 * MCP surface tools added for reference parity — takes_scorecard, takes_calibration,
 * extract_facts, list_skills, get_skill, get_recent_transcripts. Drives the real
 * `dispatchTool` path over PGLite (no Bedrock): each op is registered in TOOL_DEFS,
 * returns real data, and (for the tenant-scoped ones) is a no-op for a
 * cross-tenant caller.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { getBrainSkill } from "../src/core/skillpack/brain-resident.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

const A = "tenantA";
const B = "tenantB";
const A_BODY = "AAA_TRANSCRIPT_BODY_alpha meeting notes here for the record";
const B_BODY = "BBB_TRANSCRIPT_BODY_beta meeting notes here for the record";

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(
  name: string,
  args: Record<string, unknown>,
  authInfo?: AuthInfo,
): Promise<ToolCallResult> {
  return dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {});
}

async function seedGradedTake(docId: string, source: string, weight: number, key: string) {
  const e = storage.engine();
  await e.query(
    `INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $3, $4)`,
    [docId, `/${source}/${docId}.md`, docId, source],
  );
  const r = await e.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
     VALUES ($1, $2, 'h', 'v1', $1, 'bet', $3, 'queued', 'fake') RETURNING id`,
    [key, docId, weight],
  );
  await e.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1', $2, 'correct', 0.9, 'fake')`,
    [r.rows[0]!.id, `sig-${key}`],
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-surface-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/tenant-b" });

  // Transcript-typed pages, one per tenant.
  await putPage(storage, { slug: "meet-a", type: "meeting", title: "Meeting A", markdown_body: A_BODY, source_id: A });
  await putPage(storage, { slug: "note-b", type: "note", title: "Note B", markdown_body: B_BODY, source_id: B });

  // Graded takes, one per tenant (both correct — so a tenant-scoped scorecard
  // that leaked the other tenant would show 2 correct instead of 1).
  await seedGradedTake("doc-a", A, 0.8, "t/a");
  await seedGradedTake("doc-b", B, 0.9, "t/b");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("tool registration", () => {
  it("registers all six new tools in TOOL_DEFS", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of [
      "takes_scorecard",
      "takes_calibration",
      "extract_facts",
      "list_skills",
      "get_skill",
      "get_recent_transcripts",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe("takes_scorecard dispatch", () => {
  it("returns a real scorecard for an unscoped caller", async () => {
    const p = payload(await call("takes_scorecard", {}));
    expect(p.ok).toBe(true);
    expect(p.scorecard.total_takes).toBe(2);
    expect(p.scorecard.correct).toBe(2);
  });

  it("is a no-op for the other tenant's takes", async () => {
    const p = payload(await call("takes_scorecard", {}, auth(A)));
    expect(p.scorecard.total_takes).toBe(1); // only tenant A's take
    expect(p.scorecard.correct).toBe(1);
  });
});

describe("takes_calibration dispatch", () => {
  it("returns bucket rows", async () => {
    const p = payload(await call("takes_calibration", {}));
    expect(p.ok).toBe(true);
    expect(Array.isArray(p.buckets)).toBe(true);
    expect(p.buckets.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extract_facts dispatch", () => {
  it("returns the default-OFF envelope with a text arg (no spend)", async () => {
    const p = payload(await call("extract_facts", { text: "Alice: I like tea" }));
    expect(p.ok).toBe(true);
    expect(p.enabled).toBe(false);
    expect(p.facts).toEqual([]);
  });

  it("is a not-found no-op for a cross-tenant source_ref", async () => {
    // note-b belongs to tenant B; a tenant-A caller must not read its body.
    const r = await call("extract_facts", { source_ref: "note-b" }, auth(A));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain("BBB_TRANSCRIPT_BODY");
  });
});

describe("list_skills / get_skill dispatch", () => {
  it("list_skills returns a well-formed pack", async () => {
    const p = payload(await call("list_skills", {}));
    expect(p.ok).toBe(true);
    expect(p.pack).toBe("memex-skillpack");
    expect(Array.isArray(p.skills)).toBe(true);
  });

  it("get_skill errors on an unknown slug", async () => {
    const r = await call("get_skill", { name: "no-such-skill" });
    expect(r.isError).toBe(true);
  });

  it("getBrainSkill fetches a real skill body from a fixture dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-skill-fx-"));
    writeFileSync(
      join(dir, "demo.md"),
      "---\ntitle: demo\ndescription: A demo skill.\n---\n# demo\nbody text\n",
    );
    const s = getBrainSkill("demo", { skillsDir: dir });
    expect(s?.slug).toBe("demo");
    expect(s?.description).toBe("A demo skill.");
    expect(s?.body).toContain("body text");
    // Path traversal is rejected before touching disk.
    expect(getBrainSkill("../secret", { skillsDir: dir })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("get_recent_transcripts dispatch", () => {
  it("returns transcript pages for an unscoped caller", async () => {
    const p = payload(await call("get_recent_transcripts", {}));
    expect(p.ok).toBe(true);
    const slugs = p.transcripts.map((t: any) => t.slug);
    expect(slugs).toContain("meet-a");
    expect(slugs).toContain("note-b");
  });

  it("scopes to one tenant and never leaks the other's body", async () => {
    const p = payload(await call("get_recent_transcripts", {}, auth(A)));
    const slugs = p.transcripts.map((t: any) => t.slug);
    expect(slugs).toContain("meet-a");
    expect(slugs).not.toContain("note-b");
    const blob = JSON.stringify(p);
    expect(blob).not.toContain("BBB_TRANSCRIPT_BODY");
    expect(blob).toContain("AAA_TRANSCRIPT_BODY");
  });
});
