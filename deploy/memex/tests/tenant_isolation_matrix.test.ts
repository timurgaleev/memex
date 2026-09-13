/**
 * Isolation matrix — every MCP operation, every caller shape.
 *
 * `tests/fixtures/tenant_isolation_matrix.ts` holds one row per operation; this
 * suite first proves the table covers the registry exactly, then drives each
 * row through the real `dispatchTool`:
 *
 *   isolated       the operator (no authInfo) must see a tenant-B token — else
 *                  the row is VACUOUS and fails — and none of these may:
 *                    scalar     tenant A via sourceId
 *                    federated  tenant A via allowedSources only
 *                    no grant   an authenticated caller with no source, fail-closed on
 *   brainwide      scoped callers get an answer, never a thrown error
 *   operator_only  every token caller is refused
 *
 * A leak is any tenant-B token anywhere in the serialized envelope (content,
 * structured fields, error text), except tokens the caller itself passed in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, OPERATOR_ONLY_TOOLS, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { OPERATIONS, WRITE_SCOPED_TOOLS } from "../src/mcp/operations.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { A, auth, B, ENTITY_SLUG, seedTenantContract } from "./helpers/tenant_seed.ts";
import { MATRIX, type MatrixRow, TENANT_A_TOKENS, TENANT_B_TOKENS } from "./fixtures/tenant_isolation_matrix.ts";

setDefaultTimeout(60000);

let tmp: string;
let storage: Storage;
let factIdB = 0;

// Chronicle reads are windowed around "now"; derive the seed dates from it.
const DAY = 86_400_000;
const recentDate = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
const nextYear = new Date(`${recentDate}T00:00:00Z`);
nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
const nextYearDate = nextYear.toISOString().slice(0, 10);
const PLACEHOLDERS: Record<string, unknown> = { $recentDate: recentDate, $nextYearDate: nextYearDate };

const federatedA: AuthInfo = { ...auth(A), sourceId: undefined, allowedSources: [A] };
const noGrant: AuthInfo = { token: "tok-none", clientId: "client-none", scopes: ["read"], isPublic: false };

function argsFor(row: { args: Record<string, unknown> }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row.args).map(([k, v]) => {
    if (v === "$factIdB") return [k, factIdB];
    return [k, typeof v === "string" && v in PLACEHOLDERS ? PLACEHOLDERS[v] : v];
  }));
}

async function call(name: string, args: Record<string, unknown>, authInfo?: AuthInfo): Promise<ToolCallResult> {
  return dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {});
}

function leakedToken(
  result: ToolCallResult,
  args: Record<string, unknown>,
  tokens: readonly string[] = TENANT_B_TOKENS,
): string | undefined {
  const echoed = JSON.stringify(args).toLowerCase();
  const body = JSON.stringify(result).toLowerCase();
  return tokens.find(t => !echoed.includes(t.toLowerCase()) && body.includes(t.toLowerCase()));
}

async function seedMatrixExtras(): Promise<void> {
  for (const [who, tag] of [[A, "AAA"], [B, "BBB"]] as const) {
    const a = auth(who);
    const slug = who === A ? "team-a/alice" : "team-b/alice";
    await call("put_raw_data", { slug, source: "matrix", data: { note: `${tag}_RAW_note` } }, a);
    await call("log_ingest", { source_type: "matrix", source_ref: `${tag}_INGEST_ref`, summary: `${tag}_INGEST_summary` }, a);
    await call("ontology_propose", { entity: ENTITY_SLUG, dimension: "role", value: `${tag}_ONTO_first`, visibility: "world" }, a);
    await call("ontology_propose", { entity: ENTITY_SLUG, dimension: "role", value: `${tag}_ONTO_second`, visibility: "world" }, a);
    await call("add_tag", { slug, tag: `${tag}_TAG_label` }, a);
    await call("add_timeline_event", { slug, occurred_at: `${recentDate}T12:00:00Z`, event: `${tag}_EVENT_recent` }, a);
    // A retired fact with a replacement pointer is what the supersession audit lists.
    const kept = await call("add_fact", { entity_slug: slug, fact: `${tag}_FACT_current`, visibility: "world" }, a);
    const old = await call("add_fact", { entity_slug: slug, fact: `${tag}_FACT_retired`, visibility: "world" }, a);
    const id = (r: ToolCallResult) => Number(JSON.parse(r.content[0]!.text).id);
    await storage.engine().query(
      `UPDATE entity_facts SET forgotten_at = NOW(), superseded_by = $2 WHERE id = $1`,
      [id(old), id(kept)],
    );
  }
  await call("chronicle_backfill", {});
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-isolation-matrix-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  ({ factIdB } = await seedTenantContract(storage));
  await seedMatrixExtras();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env["MEMEX_TENANT_FAIL_CLOSED"];
});

describe("isolation matrix covers the registry", () => {
  it("has exactly one row per operation", () => {
    const names = MATRIX.map(r => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(OPERATIONS.map(o => o.name).sort());
  });

  it("marks exactly the operator-only tools operator_only", () => {
    const rows = MATRIX.filter(r => r.mode === "operator_only").map(r => r.name).sort();
    expect(rows).toEqual([...OPERATOR_ONLY_TOOLS].filter(n => !WRITE_SCOPED_TOOLS.has(n)).sort());
  });

  it("marks exactly the write-scoped tools write", () => {
    const rows = MATRIX.filter(r => r.mode === "write").map(r => r.name).sort();
    expect(rows).toEqual([...WRITE_SCOPED_TOOLS].sort());
  });

  it("names an existing owner suite for every skipped row", () => {
    for (const row of MATRIX) {
      if (row.mode === "skip") expect(existsSync(join(import.meta.dir, "..", row.owner))).toBe(true);
    }
  });
});

const byMode = <M extends MatrixRow["mode"]>(mode: M) =>
  MATRIX.filter((r): r is Extract<MatrixRow, { mode: M }> => r.mode === mode);

describe("isolated operations never cross the source boundary", () => {
  for (const row of byMode("isolated")) {
    it(row.name, async () => {
      const args = argsFor(row);
      const control = await call(row.name, args);
      if (!leakedToken(control, args)) {
        throw new Error(`VACUOUS: the operator sees no tenant-B data through ${row.name}; fix the seed or the row`);
      }
      const principals: Array<[string, AuthInfo, boolean]> = [
        ["scalar", auth(A), false],
        ["federated", federatedA, false],
        ["no grant", noGrant, true],
      ];
      for (const [label, authInfo, failClosed] of principals) {
        if (failClosed) process.env["MEMEX_TENANT_FAIL_CLOSED"] = "1";
        else delete process.env["MEMEX_TENANT_FAIL_CLOSED"];
        const tokens = failClosed ? [...TENANT_B_TOKENS, ...TENANT_A_TOKENS] : TENANT_B_TOKENS;
        const leaked = leakedToken(await call(row.name, args, authInfo), args, tokens);
        expect({ caller: label, leaked }).toEqual({ caller: label, leaked: undefined });
      }
    });
  }
});

describe("brainwide operations answer scoped callers", () => {
  for (const row of byMode("brainwide")) {
    it(row.name, async () => {
      for (const authInfo of [auth(A), federatedA]) {
        const res = await call(row.name, argsFor(row), authInfo);
        expect(JSON.stringify(res)).not.toContain("permission_denied");
      }
    });
  }
});

describe("operator-only operations refuse token callers", () => {
  for (const row of byMode("operator_only")) {
    it(row.name, async () => {
      for (const authInfo of [auth(A), federatedA]) {
        const res = await call(row.name, { id: 1, kind: "noop" }, authInfo);
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res)).toContain("permission_denied");
      }
    });
  }
});
