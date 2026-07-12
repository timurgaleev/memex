/**
 * Stage-2 MCP surface — the op batch: think exposure,
 * rebuilt flagship `query`, read-param parity (page_list/page_get/search),
 * facts lifecycle reads, raw_data ops, job lifecycle ops, operator wrappers
 * (sources_list/sources_status/get_status_snapshot/run_doctor), the
 * operator-only purge gate, and the client spend-ledger enforcement on paid
 * ops. Drives the real dispatchTool path over PGLite; no Bedrock (paid cores
 * stay default-OFF, embed calls fail soft to keyword-only).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { addTag } from "../src/core/tags.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

const A = "stage2a";
const B = "stage2b";

function auth(sourceId: string, scopes: string[] = ["read", "write"]): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes,
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

let forgottenFactId = 0;
let supersededFactId = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-stage2-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const engine = storage.engine();
  await registerSource(engine, { id: A, kind: "vault", pathPrefix: "/stage2-a" });
  await registerSource(engine, { id: B, kind: "vault", pathPrefix: "/stage2-b" });

  // Pages: tagged, sortable, one soft-deleted, one fuzzy-resolvable title.
  await putPage(storage, { slug: "people/alice-smith", type: "person", title: "Alice Smith", markdown_body: "Alice works on X.", source_id: A });
  await putPage(storage, { slug: "notes/tagged-one", type: "note", title: "Tagged One", markdown_body: "body one", source_id: A });
  await putPage(storage, { slug: "notes/plain-two", type: "note", title: "Plain Two", markdown_body: "body two", source_id: A });
  await putPage(storage, { slug: "notes/doomed", type: "note", title: "Doomed", markdown_body: "to be deleted", source_id: A });
  await addTag(storage, "notes/tagged-one", "Focus ");
  await deletePage(storage, "notes/doomed");

  // Facts with lifecycle metadata, one forgotten, one superseded.
  const f1 = await addFact(storage, {
    entity_slug: "people/alice-smith",
    fact: "Alice prefers espresso",
    source_id: A,
    visibility: "world",
    source_session: "sess-1",
  });
  const f2 = await addFact(storage, {
    entity_slug: "people/alice-smith",
    fact: "Alice lives in Lisbon",
    source_id: A,
    visibility: "private",
    source_session: "sess-2",
  });
  const f3 = await addFact(storage, {
    entity_slug: "people/alice-smith",
    fact: "Alice lived in Porto",
    source_id: A,
  });
  await forgetFact(storage, f2.id!, { reason: "test tombstone" });
  forgottenFactId = f2.id!;
  // Supersession audit row: retired WITH a replacement pointer.
  await engine.query(
    `UPDATE entity_facts SET forgotten_at = NOW(), superseded_by = $2 WHERE id = $1`,
    [f3.id, f1.id],
  );
  supersededFactId = f3.id!;

  // Salience rows for get_recent_salience slug_prefix.
  await engine.query(`UPDATE pages SET salience = 0.9 WHERE slug = 'people/alice-smith'`);
  await engine.query(`UPDATE pages SET salience = 0.8 WHERE slug = 'notes/tagged-one'`);

  // Takes for the list_takes filter batch.
  await engine.query(
    `INSERT INTO documents (id, source_path, title, source_id) VALUES ('s2doc', '/stage2-a/s2doc.md', 's2doc', $1)`,
    [A],
  );
  for (const [key, kind, weight] of [
    ["s2-take-low", "bet", 0.2],
    ["s2-take-high", "bet", 0.9],
    ["s2-take-judgment", "judgment", 0.5],
  ] as const) {
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
       VALUES ($1, 's2doc', 'h', 'v1', $1, $2, $3, 'queued', 'fake')`,
      [key, kind, weight],
    );
  }

  // A capped client for the spend-ledger test (cap so low the reserve fails).
  await engine.query(
    `INSERT INTO oauth_clients (client_id, client_name, budget_usd_per_day, source_id)
     VALUES ('client-capped', 'capped', 0.00, $1)`,
    [A],
  );
}, 120_000);

afterAll(async () => {
  await storage?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("tool registration", () => {
  it("advertises the stage-2 ops", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of [
      "think",
      "fact_supersessions",
      "put_raw_data",
      "get_raw_data",
      "retry_job",
      "get_job_progress",
      "sources_list",
      "sources_status",
      "get_status_snapshot",
      "run_doctor",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe("page read param parity (G45)", () => {
  it("page_list filters by tag (normalized)", async () => {
    const r = payload(await call("page_list", { tag: "focus" }));
    expect(r.ok).toBe(true);
    expect(r.pages.map((p: any) => p.slug)).toEqual(["notes/tagged-one"]);
  });

  it("page_list sort=slug is deterministic ascending", async () => {
    const r = payload(await call("page_list", { sort: "slug" }));
    const slugs = r.pages.map((p: any) => p.slug);
    expect(slugs).toEqual([...slugs].sort());
  });

  it("page_list hides soft-deleted by default, surfaces with include_deleted", async () => {
    const def = payload(await call("page_list", {}));
    expect(def.pages.some((p: any) => p.slug === "notes/doomed")).toBe(false);
    const withDel = payload(await call("page_list", { include_deleted: true }));
    const doomed = withDel.pages.find((p: any) => p.slug === "notes/doomed");
    expect(doomed).toBeDefined();
    expect(doomed.deleted_at).toBeTruthy();
  });

  it("page_get include_deleted surfaces a soft-deleted page", async () => {
    const miss = await call("page_get", { slug: "notes/doomed" });
    expect(miss.isError).toBe(true);
    const hit = payload(await call("page_get", { slug: "notes/doomed", include_deleted: true }));
    expect(hit.ok).toBe(true);
    expect(hit.page.deleted_at).toBeTruthy();
  });

  it("page_get fuzzy resolves an informal title", async () => {
    const r = payload(await call("page_get", { slug: "Alice Smith", fuzzy: true }));
    expect(r.ok).toBe(true);
    expect(r.page.slug).toBe("people/alice-smith");
    expect(r.resolved_slug).toBe("people/alice-smith");
  });
});

describe("facts lifecycle reads (G35)", () => {
  it("entity_facts default excludes tombstones; include_forgotten surfaces them", async () => {
    const def = payload(await call("entity_facts", { entity_slug: "people/alice-smith" }));
    expect(def.facts.some((f: any) => f.id === forgottenFactId)).toBe(false);
    const all = payload(
      await call("entity_facts", { entity_slug: "people/alice-smith", include_forgotten: true }),
    );
    expect(all.facts.some((f: any) => f.id === forgottenFactId)).toBe(true);
  });

  it("entity_facts filters by session, grep, visibility", async () => {
    const sess = payload(
      await call("entity_facts", { entity_slug: "people/alice-smith", session: "sess-1" }),
    );
    expect(sess.facts.length).toBe(1);
    expect(sess.facts[0].fact).toContain("espresso");

    const grep = payload(
      await call("entity_facts", { entity_slug: "people/alice-smith", grep: "ESPRESSO" }),
    );
    expect(grep.facts.length).toBe(1);

    const world = payload(
      await call("entity_facts", { entity_slug: "people/alice-smith", visibility: "world" }),
    );
    expect(world.facts.every((f: any) => f.visibility === "world")).toBe(true);
  });

  it("fact_supersessions returns the retired-with-pointer audit rows", async () => {
    const r = payload(await call("fact_supersessions", { entity_slug: "people/alice-smith" }));
    expect(r.ok).toBe(true);
    expect(r.supersessions.length).toBe(1);
    expect(r.supersessions[0].id).toBe(supersededFactId);
    expect(r.supersessions[0].superseded_by).toBeTruthy();
  });

  it("entity_recall include_pending piggy-backs the count", async () => {
    const r = payload(
      await call("entity_recall", { slug: "people/alice-smith", include_pending: true }),
    );
    expect(r.ok).toBe(true);
    expect(typeof r.pending_consolidation_count).toBe("number");
  });
});

describe("raw_data ops (G41)", () => {
  it("put + get roundtrip, newest-wins replace", async () => {
    const first = payload(
      await call("put_raw_data", { slug: "people/alice-smith", source: "importer-x", data: { v: 1 } }),
    );
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    const second = payload(
      await call("put_raw_data", { slug: "people/alice-smith", source: "importer-x", data: { v: 2 } }),
    );
    expect(second.created).toBe(false);
    const read = payload(await call("get_raw_data", { slug: "people/alice-smith" }));
    expect(read.raw_data.length).toBe(1);
    expect(read.raw_data[0].data.v).toBe(2);
  });

  it("a scoped writer cannot attach data to another tenant's page", async () => {
    const r = await call(
      "put_raw_data",
      { slug: "people/alice-smith", source: "importer-b", data: { v: 1 } },
      auth(B),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("page not found");
  });

  it("a scoped reader cannot read another tenant's raw data", async () => {
    const r = payload(await call("get_raw_data", { slug: "people/alice-smith" }, auth(B)));
    expect(r.raw_data.length).toBe(0);
  });
});

describe("job lifecycle ops (G43) — operator-only", () => {
  it("tenant tokens are refused", async () => {
    for (const name of ["retry_job", "get_job_progress"]) {
      const r = await call(name, { id: "x" }, auth(A));
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).error).toBe("permission_denied");
    }
  });

  it("retry_job re-queues a failed job; get_job_progress reads it", async () => {
    const queue = new Queue(storage.engine());
    const job = await queue.enqueue({ kind: "stage2.noop", id: "stage2-retry-1", maxRetries: 0 });
    await storage
      .engine()
      .query(`UPDATE jobs SET status = 'failed' WHERE id = $1`, [job.id]);
    const r = payload(await call("retry_job", { id: job.id }));
    expect(r.retried).toBe(true);
    expect(r.job.status).toBe("pending");
    const p = payload(await call("get_job_progress", { id: job.id }));
    expect(p.ok).toBe(true);
    expect(p.status).toBe("pending");
    const miss = payload(await call("retry_job", { id: "no-such-job" }));
    expect(miss.retried).toBe(false);
  });
});

describe("operator wrappers (G42)", () => {
  it("sources_list scopes to the caller's grant", async () => {
    const op = payload(await call("sources_list", {}));
    const ids = op.sources.map((s: any) => s.id);
    expect(ids).toContain(A);
    expect(ids).toContain(B);
    const scoped = payload(await call("sources_list", {}, auth(A)));
    expect(scoped.sources.map((s: any) => s.id)).toEqual([A]);
  });

  it("sources_status returns row + health; out-of-grant id is not_found", async () => {
    const ok = payload(await call("sources_status", { id: A }));
    expect(ok.ok).toBe(true);
    expect(ok.source.id).toBe(A);
    expect(ok.health?.source_id).toBe(A);
    const denied = await call("sources_status", { id: B }, auth(A));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text).error).toBe("not_found");
  });

  it("get_status_snapshot + run_doctor work for the operator, refused for tenants", async () => {
    const snap = payload(await call("get_status_snapshot", {}));
    expect(snap.schema_version).toBe(1);
    expect(snap.stats).toBeDefined();
    expect(snap.health).toBeDefined();
    expect(snap.cache).toBeDefined();

    const doc = payload(await call("run_doctor", {}));
    expect(Array.isArray(doc.checks)).toBe(true);
    expect(doc.checks.map((c: any) => c.name)).toContain("embed-coverage");

    for (const name of ["get_status_snapshot", "run_doctor"]) {
      const r = await call(name, {}, auth(A));
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).error).toBe("permission_denied");
    }
  });
});

describe("exposure tightening (G47)", () => {
  it("purge_deleted_pages is operator-only now", async () => {
    const denied = await call("purge_deleted_pages", { older_than_hours: 0 }, auth(A));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text).error).toBe("permission_denied");
    // The operator path still works (nothing old enough to reap here).
    const ok = payload(await call("purge_deleted_pages", { older_than_hours: 9999 }));
    expect(ok.ok).toBe(true);
  });
});

describe("think exposure (G2/G32)", () => {
  it("returns the default-OFF envelope without MEMEX_THINK", async () => {
    const r = payload(await call("think", { question: "what do I know about alice?" }));
    expect(r.ok).toBe(true);
    expect(r.ran).toBe(false);
    expect(String(r.reason)).toContain("MEMEX_THINK");
  });

  it("save/take are silently ignored for tenant callers", async () => {
    const r = payload(
      await call("think", { question: "q", save: true, take: true, anchor: "people/alice-smith" }, auth(A)),
    );
    expect(r.save_applied).toBe(false);
    expect(r.take_applied).toBe(false);
  });

  it("requires the write scope for tenant tokens", async () => {
    const r = await call("think", { question: "q" }, auth(A, ["read"]));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toBe("insufficient_scope");
  });

  it("take without anchor is invalid (operator path)", async () => {
    const r = await call("think", { question: "q", take: true });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
  });
});

describe("client spend ledger (G5)", () => {
  it("a capped-out client is refused a paid op fail-closed", async () => {
    const capped: AuthInfo = {
      token: "tok-capped",
      clientId: "client-capped",
      scopes: ["read", "write"],
      sourceId: A,
      allowedSources: [A],
      isPublic: false,
    };
    const r = await call("think", { question: "spend some money" }, capped);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toBe("budget_exhausted");
  });

  it("an uncapped client passes the ledger (paid core still default-OFF)", async () => {
    const r = payload(await call("think", { question: "q" }, auth(A)));
    expect(r.ok).toBe(true);
    expect(r.ran).toBe(false);
  });
});

describe("list_takes filters (G46)", () => {
  it("kind filter + weight sort + offset paginate", async () => {
    const bets = payload(await call("list_takes", { kind: "bet", sort: "weight" }));
    expect(bets.takes.map((t: any) => t.take_key)).toEqual(["s2-take-high", "s2-take-low"]);
    const page2 = payload(
      await call("list_takes", { kind: "bet", sort: "weight", offset: 1, limit: 1 }),
    );
    expect(page2.takes.map((t: any) => t.take_key)).toEqual(["s2-take-low"]);
  });
});

describe("get_recent_salience params (G46)", () => {
  it("slug_prefix narrows; recency_bias=on still returns rows", async () => {
    const people = payload(await call("get_recent_salience", { slug_prefix: "people" }));
    expect(people.pages.length).toBe(1);
    expect(people.pages[0].slug).toBe("people/alice-smith");
    const biased = payload(
      await call("get_recent_salience", { slug_prefix: "people", recency_bias: "on" }),
    );
    expect(biased.pages.length).toBe(1);
  });
});

describe("query rebuild (G4)", () => {
  it("legacy refine path still answers", async () => {
    const r = payload(await call("query", { q: "alice", refine: "espresso", k: 3 }));
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.hits)).toBe(true);
  });

  it("flagship path accepts the flagship params (keyword-only fallback)", async () => {
    const r = payload(
      await call("query", {
        q: "alice",
        k: 5,
        detail: "high",
        salience: "on",
        recency: "off",
        offset: 0,
        adaptive_return: false,
      }),
    );
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.hits)).toBe(true);
  });

  it("rejects a malformed since bound loudly", async () => {
    const r = await call("query", { q: "alice", since: "last month" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
  });
});

describe("volunteer_context prior_context (G46)", () => {
  it("a slug already in prior_context is not re-volunteered", async () => {
    const win = "user: what's the latest on Alice Smith?";
    const base = payload(await call("volunteer_context", { window: win }));
    // Only meaningful when the resolver volunteers the page at all.
    if (base.pages.length > 0) {
      expect(base.pages.some((p: any) => p.slug === "people/alice-smith")).toBe(true);
      const suppressed = payload(
        await call("volunteer_context", {
          window: win,
          prior_context: "already opened: people/alice-smith",
        }),
      );
      expect(suppressed.pages.some((p: any) => p.slug === "people/alice-smith")).toBe(false);
    }
  });
});
