/**
 * Tenant agent jobs end to end on a seeded two-tenant brain: submit_agent and
 * get_agent_job through the real dispatchTool with real OAuth client tokens,
 * the `subagent` handler with a scripted model behind the real Converse
 * booking path, and the real tool dispatch.
 *
 * Locks: a tenant's run reads only its own source (the operator's run of the
 * same script does see the other tenant, so the fixture is not vacuous); a
 * revoked or rescoped grant stops the run at the next model call or tool with
 * nothing dispatched or appended after it; bound_max_concurrent is enforced at
 * submit; every model call is booked to the tenant, and a spent daily cap ends
 * the run before any call; every submit gate fails closed; get_agent_job gives
 * one not-found for any job that is not the caller's; a payload edited after
 * submit is refused at claim.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BedrockRuntimeClient, ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import type { JobRow } from "../src/core/jobs/types.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { runWithSpendClient, setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";
import { converseTurn, type ConverseFn } from "../src/core/llm/converse.ts";
import { dispatchTool, type ToolCallRequest, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { listMessages, listToolExecutions } from "../src/core/subagent_ledger.ts";
import { AGENT_JOB_TIMEOUT_MS, SUBAGENT_JOB_KIND, makeSubagentHandler } from "../src/core/agent/handler.ts";
import { AgentGrantRevoked } from "../src/core/agent/authority.ts";
import { submitTenantAgent } from "../src/core/agent/submit.ts";
import type { AgentDispatch } from "../src/core/agent/tools.ts";
import { A, B, KEYWORD, SHARED_PATH, SHARED_TITLE, seedTenantContract } from "./helpers/tenant_seed.ts";
import { TENANT_B_TOKENS } from "./fixtures/tenant_isolation_matrix.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60000);

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let queue: Queue;
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};
const FLAGS = ["MEMEX_AGENT_ENABLED", "MEMEX_AGENT_TENANT_ENABLED", "MEMEX_TENANT_FAIL_CLOSED"];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-agent-tenant-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await seedTenantContract(storage);
  provider = new OAuthProvider({ engine: storage.raw() });
  queue = new Queue(storage.engine());
  setSpendLedgerEngine(storage.engine());
});

afterAll(async () => {
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of FLAGS) savedEnv[f] = process.env[f];
  process.env.MEMEX_AGENT_ENABLED = "1";
  process.env.MEMEX_AGENT_TENANT_ENABLED = "1";
});

afterEach(() => {
  for (const f of FLAGS) {
    if (savedEnv[f] === undefined) delete process.env[f];
    else process.env[f] = savedEnv[f];
  }
});

interface Tenant {
  clientId: string;
  token: string;
  auth: AuthInfo;
}

/** A client_credentials client in `source`, and the AuthInfo its real token verifies to. */
async function tenant(
  source: string,
  opts: { scopes?: string; budget?: number | null; maxConcurrent?: number; boundTools?: string[] } = {},
): Promise<Tenant> {
  seq++;
  const scopes = opts.scopes ?? "agent read";
  const reg = await provider.registerClientManual(`t${seq}`, ["client_credentials"], scopes, [], source);
  const budget = opts.budget === undefined ? 1 : opts.budget;
  if (budget !== null) await provider.setClientBudget(reg.clientId, budget);
  if (opts.maxConcurrent !== undefined || opts.boundTools !== undefined) {
    await storage.engine().query(
      `UPDATE oauth_clients
          SET bound_max_concurrent = COALESCE($2, bound_max_concurrent), bound_tools = $3::text[]
        WHERE client_id = $1`,
      [reg.clientId, opts.maxConcurrent ?? null, opts.boundTools ?? null],
    );
  }
  const tokens = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!, scopes);
  return { clientId: reg.clientId, token: tokens.access_token, auth: await reverify(tokens.access_token) };
}

async function reverify(token: string): Promise<AuthInfo> {
  return { ...(await provider.verifyAccessToken(token)), isPublic: false };
}

async function call(name: string, args: Record<string, unknown>, authInfo?: AuthInfo): Promise<ToolCallResult> {
  return dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {});
}

function body(r: ToolCallResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function submit(t: Tenant, task = "What does the brain say?"): Promise<string> {
  const r = await call("submit_agent", { task, max_usd: 0.2 }, t.auth);
  expect(r.isError, r.content[0]!.text).toBeUndefined();
  return body(r).job_id as string;
}

interface Turn {
  content: ContentBlock[];
  stopReason: string;
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({
  toolUse: { toolUseId: id, name, input: input as never },
});

/**
 * A scripted model behind the real `converseTurn`, so every call is held and
 * booked by the spend chokepoint exactly as in production. `sent` counts the
 * calls that reached the model; a call refused by a budget never does.
 */
function scriptedModel(turns: Turn[], onCall?: (n: number) => Promise<void>): { fn: ConverseFn; sent: () => number } {
  let n = 0;
  const client = {
    send: async () => {
      const t = turns[n];
      n++;
      if (!t) throw new Error(`unscripted model call #${n}`);
      await onCall?.(n);
      return {
        output: { message: { role: "assistant", content: t.content } },
        stopReason: t.stopReason,
        usage: { inputTokens: 1000, outputTokens: 100 },
      };
    },
  } as unknown as BedrockRuntimeClient;
  return { fn: (input) => converseTurn({ ...input, client }), sent: () => n };
}

/** The real dispatcher, with hermetic query embeddings; counts every dispatch. */
function countingDispatch(onDispatch?: (n: number) => Promise<void>): { fn: AgentDispatch; calls: ToolCallRequest[] } {
  const calls: ToolCallRequest[] = [];
  const fn: AgentDispatch = async (s, req, authInfo) => {
    calls.push(req);
    await onDispatch?.(calls.length);
    return dispatchTool(s, req, {
      ...(authInfo ? { authInfo } : {}),
      embedQuery: async (text: string) => deterministicEmbed(text),
    });
  };
  return { fn, calls };
}

/** Claim `id` and run it through the handler the way the worker does. */
async function runJob(
  id: string,
  model: ConverseFn,
  dispatch: AgentDispatch,
): Promise<{ job: JobRow; error?: unknown }> {
  await storage.engine().query(`UPDATE jobs SET priority = 1 WHERE id = $1`, [id]);
  const job = (await queue.claim({ kinds: [SUBAGENT_JOB_KIND] }))!;
  expect(job.id).toBe(id);
  const handler = makeSubagentHandler(storage, { converse: model, dispatch, modelId: HAIKU });
  const gen = job.claimGeneration;
  try {
    const result = await handler(job.payload, {
      job,
      updateProgress: (p) => queue.updateProgress(id, gen, p),
      recordUsage: (u) => queue.recordUsage(id, gen, u),
    });
    await queue.complete(id, gen, result ?? {});
    return { job: (await queue.get(id))! };
  } catch (error) {
    await queue.fail(id, gen, error instanceof Error ? error.message : String(error));
    return { job: (await queue.get(id))!, error };
  }
}

const CROSS_TENANT_SCRIPT: Turn[] = [
  {
    stopReason: "tool_use",
    content: [
      toolUse("u1", "page_get", { slug: "team-b/alice" }),
      toolUse("u2", "resolve_slugs", { query: SHARED_TITLE }),
      toolUse("u3", "search", { q: KEYWORD }),
      toolUse("u4", "get_chunks", { source_path: SHARED_PATH }),
    ],
  },
  { stopReason: "end_turn", content: [{ text: "done" }] },
];

/** Tenant-B tokens in a tool's output that its own input did not carry. */
async function leakedTokens(jobId: string): Promise<string[]> {
  const leaks: string[] = [];
  for (const ex of await listToolExecutions(storage, jobId)) {
    const input = JSON.stringify(ex.input).toLowerCase();
    const output = JSON.stringify(ex.output).toLowerCase();
    for (const t of TENANT_B_TOKENS) {
      if (!input.includes(t.toLowerCase()) && output.includes(t.toLowerCase())) leaks.push(`${ex.tool_name}:${t}`);
    }
  }
  return leaks;
}

describe("a tenant agent reads only its own source", () => {
  it("never sees tenant B, while the operator's run of the same script does", async () => {
    const a = await tenant(A);
    const tenantJob = await submit(a);
    const tenantRun = await runJob(tenantJob, scriptedModel(CROSS_TENANT_SCRIPT).fn, countingDispatch().fn);
    expect(tenantRun.error).toBeUndefined();
    expect(tenantRun.job.status).toBe("succeeded");
    expect(await listToolExecutions(storage, tenantJob)).toHaveLength(4);
    expect(await leakedTokens(tenantJob)).toEqual([]);

    const opJob = await queue.enqueue({
      kind: SUBAGENT_JOB_KIND,
      payload: { task: "same" },
      timeoutMs: AGENT_JOB_TIMEOUT_MS,
      maxRetries: 0,
    });
    const opRun = await runJob(opJob.id, scriptedModel(CROSS_TENANT_SCRIPT).fn, countingDispatch().fn);
    expect(opRun.job.status).toBe("succeeded");
    expect((await leakedTokens(opJob.id)).length).toBeGreaterThan(0);
  });

  it("books every model call to the tenant under 'agent'", async () => {
    const a = await tenant(A);
    const id = await submit(a);
    await runJob(id, scriptedModel(CROSS_TENANT_SCRIPT).fn, countingDispatch().fn);
    const rows = await storage.engine().query<{ client_id: string | null; n: number | string }>(
      `SELECT client_id, COUNT(*) AS n FROM mcp_spend_log WHERE operation = 'agent' AND client_id = $1 GROUP BY client_id`,
      [a.clientId],
    );
    expect(Number(rows.rows[0]?.n ?? 0)).toBe(2);
  });

  it("stops before any model call when the tenant's daily cap is spent", async () => {
    const a = await tenant(A, { budget: 0.05 });
    await runWithSpendClient(a.clientId, () =>
      trackedInvoke({ operation: "think", model: HAIKU, worstCase: { input: "x", maxOutputTokens: 0 } }, async (m) => {
        m.report({ inputTokens: 50_000, outputTokens: 0 });
      }),
    );
    const id = await submit(a);
    const model = scriptedModel(CROSS_TENANT_SCRIPT);
    const run = await runJob(id, model.fn, countingDispatch().fn);
    expect(model.sent()).toBe(0);
    expect(run.job.status).toBe("succeeded");
    expect(run.job.result?.stop_reason).toBe("budget_exhausted");
  });
});

describe("revoking the grant stops a running job", () => {
  it("at the next tool, when the grant is rescoped during a model call", async () => {
    const a = await tenant(A);
    const id = await submit(a);
    const model = scriptedModel(CROSS_TENANT_SCRIPT, async (n) => {
      if (n === 1) await provider.rescopeClient(a.clientId, { sourceId: A }, { actor: "test", via: "cli" });
    });
    const dispatch = countingDispatch();
    const run = await runJob(id, model.fn, dispatch.fn);
    expect(run.error).toBeInstanceOf(AgentGrantRevoked);
    expect(run.job.status).toBe("failed");
    expect(run.job.lastError).toContain("grant changed");
    expect(dispatch.calls).toHaveLength(0);
    expect(await listToolExecutions(storage, id)).toHaveLength(0);
    // The task and the assistant turn that was already paid for; nothing after.
    expect((await listMessages(storage, id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("at the next model call, when the client is revoked while a tool runs", async () => {
    const a = await tenant(A);
    const id = await submit(a);
    const script: Turn[] = [
      { stopReason: "tool_use", content: [toolUse("u1", "page_get", { slug: "team-a/alice" })] },
      { stopReason: "end_turn", content: [{ text: "never sent" }] },
    ];
    const model = scriptedModel(script);
    const dispatch = countingDispatch(async () => {
      await storage.engine().query("DELETE FROM oauth_clients WHERE client_id = $1", [a.clientId]);
    });
    const run = await runJob(id, model.fn, dispatch.fn);
    expect(run.error).toBeInstanceOf(AgentGrantRevoked);
    expect(run.job.lastError).toContain("client revoked");
    expect(model.sent()).toBe(1);
    expect(dispatch.calls).toHaveLength(1);
    const before = await listMessages(storage, id);
    expect(before.map((m) => m.role)).toEqual(["user", "assistant", "tool_result"]);
  });

  it("at claim, before the ledger gets its first row", async () => {
    const a = await tenant(A);
    const id = await submit(a);
    await storage.engine().query("UPDATE oauth_clients SET scope = 'read' WHERE client_id = $1", [a.clientId]);
    const model = scriptedModel(CROSS_TENANT_SCRIPT);
    const run = await runJob(id, model.fn, countingDispatch().fn);
    expect(run.error).toBeInstanceOf(AgentGrantRevoked);
    expect(model.sent()).toBe(0);
    expect(await listMessages(storage, id)).toHaveLength(0);
  });
});

describe("submit_agent concurrency", () => {
  it("refuses a submit beyond bound_max_concurrent until a slot frees", async () => {
    const a = await tenant(A, { maxConcurrent: 1 });
    const first = await submit(a);
    const refused = await call("submit_agent", { task: "second" }, a.auth);
    expect(refused.isError).toBe(true);
    expect(body(refused).error).toBe("rate_limited");
    await runJob(first, scriptedModel([{ stopReason: "end_turn", content: [{ text: "ok" }] }]).fn, countingDispatch().fn);
    expect(await submit(a, "third")).toBeString();
  });
});

describe("submit_agent fails closed", () => {
  async function refusedCode(args: Record<string, unknown>, authInfo?: AuthInfo): Promise<string> {
    const r = await call("submit_agent", args, authInfo);
    expect(r.isError, r.content[0]!.text).toBe(true);
    return body(r).error as string;
  }

  it("when the tenant flag is off", async () => {
    const a = await tenant(A);
    delete process.env.MEMEX_AGENT_TENANT_ENABLED;
    expect(await refusedCode({ task: "t" }, a.auth)).toBe("unsupported");
  });

  it("when the agent loop itself is off", async () => {
    const a = await tenant(A);
    delete process.env.MEMEX_AGENT_ENABLED;
    expect(await refusedCode({ task: "t" }, a.auth)).toBe("unsupported");
  });

  it("when the token lacks the agent scope", async () => {
    const a = await tenant(A, { scopes: "read" });
    expect(await refusedCode({ task: "t" }, a.auth)).toBe("insufficient_scope");
  });

  it("when the client has no daily cap", async () => {
    const a = await tenant(A, { budget: null });
    expect(await refusedCode({ task: "t" }, a.auth)).toBe("permission_denied");
  });

  it("when the bound tools leave the agent nothing", async () => {
    const a = await tenant(A, { boundTools: ["page_put"] });
    expect(await refusedCode({ task: "t" }, a.auth)).toBe("permission_denied");
  });

  it("when the caller holds no read grant", async () => {
    const a = await tenant(A);
    const bare: AuthInfo = { ...a.auth, sourceId: undefined, allowedSources: [] };
    expect(await refusedCode({ task: "t" }, bare)).toBe("permission_denied");
  });

  it("for an enrollment-bound session", async () => {
    const a = await tenant(A);
    expect(await refusedCode({ task: "t" }, { ...a.auth, spendId: "enr-x" })).toBe("unsupported");
  });

  it("for a token whose grant is not its client's", async () => {
    const a = await tenant(A);
    expect(await refusedCode({ task: "t" }, { ...a.auth, sourceId: B, allowedSources: [B] })).toBe("unsupported");
  });

  it("for the operator path, with no AuthInfo", async () => {
    expect(await refusedCode({ task: "t" })).toBe("unsupported");
  });

  it("for a bad task, before anything is queued", async () => {
    const a = await tenant(A);
    expect(await refusedCode({ task: "" }, a.auth)).toBe("invalid_params");
    const n = await storage.engine().query<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE submitted_by = $1",
      [a.clientId],
    );
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  it("queues nothing the worker would run as the operator", async () => {
    const a = await tenant(A);
    const r = await submitTenantAgent(storage, a.auth, { task: "t" });
    const job = (await queue.get(r.job_id))!;
    expect(job.submittedBy).toBe(a.clientId);
    expect(job.authority).not.toBeNull();
    expect(job.maxRetries).toBe(0);
    expect(job.timeoutMs).toBe(AGENT_JOB_TIMEOUT_MS);
  });
});

describe("get_agent_job", () => {
  it("returns the owner's result", async () => {
    const a = await tenant(A);
    const id = await submit(a);
    await runJob(id, scriptedModel([{ stopReason: "end_turn", content: [{ text: "the answer" }] }]).fn, countingDispatch().fn);
    const r = await call("get_agent_job", { job_id: id }, a.auth);
    expect(body(r)).toMatchObject({ job_id: id, status: "succeeded", final_text: "the answer", stop_reason: "end_turn", turns: 1 });
  });

  it("gives one identical not-found for a foreign job, an operator job and a missing id", async () => {
    const a = await tenant(A);
    const b = await tenant(B);
    const foreign = await submit(b);
    const operator = await queue.enqueue({ kind: SUBAGENT_JOB_KIND, payload: { task: "op" }, timeoutMs: AGENT_JOB_TIMEOUT_MS });
    const texts = await Promise.all(
      [foreign, operator.id, "no-such-job"].map(async (id) => {
        const r = await call("get_agent_job", { job_id: id }, a.auth);
        expect(r.isError).toBe(true);
        return r.content[0]!.text;
      }),
    );
    expect(texts[0]).toBe(texts[1]);
    expect(texts[1]).toBe(texts[2]);
    expect(JSON.parse(texts[0]!).error).toBe("not_found");
  });

  async function answered(t: Tenant): Promise<string> {
    const id = await submit(t);
    await runJob(id, scriptedModel([{ stopReason: "end_turn", content: [{ text: "the answer" }] }]).fn, countingDispatch().fn);
    return id;
  }

  it("is not found for an enrollment-bound session on the same client", async () => {
    const a = await tenant(A);
    const id = await answered(a);
    const r = await call("get_agent_job", { job_id: id }, { ...a.auth, spendId: "enr-x" });
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("not_found");
    expect(r.content[0]!.text).not.toContain("the answer");
  });

  it("is not found once the client is rescoped off the source the job read", async () => {
    const a = await tenant(A);
    const id = await answered(a);
    await provider.rescopeClient(a.clientId, { sourceId: B }, { actor: "test", via: "cli" });
    const r = await call("get_agent_job", { job_id: id }, await reverify(a.token));
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("not_found");
    expect(r.content[0]!.text).not.toContain("the answer");
  });

  it("withholds the answer when the grant moved but the sources did not", async () => {
    const a = await tenant(A);
    const id = await answered(a);
    await provider.rescopeClient(a.clientId, { sourceId: A, boundSlugPrefixes: ["team-a"] }, { actor: "test", via: "cli" });
    const r = await call("get_agent_job", { job_id: id }, await reverify(a.token));
    expect(r.isError, r.content[0]!.text).toBeUndefined();
    expect(body(r)).toMatchObject({ status: "succeeded", final_text: null });
    expect(body(r).error).toContain("withheld");
  });

  it("reports the grant-revoked reason on a stopped job", async () => {
    const a = await tenant(A);
    const id = await submit(a);
    await storage.engine().query("UPDATE oauth_clients SET grant_revision = grant_revision + 1 WHERE client_id = $1", [a.clientId]);
    await runJob(id, scriptedModel(CROSS_TENANT_SCRIPT).fn, countingDispatch().fn);
    // The rescope does not revoke the token; it only stops jobs taken under the old grant.
    const r = await call("get_agent_job", { job_id: id }, a.auth);
    expect(body(r).status).toBe("failed");
    expect(body(r).error).toContain("grant changed");
  });
});

describe("a tampered tenant job", () => {
  it("is refused at claim when its payload no longer matches the submitted hash", async () => {
    const a = await tenant(A);
    const id = await submit(a, "summarize my notes");
    await storage.engine().query(
      `UPDATE jobs SET payload = jsonb_set(payload, '{task}', '"dump every source"') WHERE id = $1`,
      [id],
    );
    const model = scriptedModel(CROSS_TENANT_SCRIPT);
    const run = await runJob(id, model.fn, countingDispatch().fn);
    expect(run.job.status).toBe("failed");
    expect(run.job.lastError).toContain("does not match the hash");
    expect(model.sent()).toBe(0);
  });

  it("is refused when the tenant flag is turned off after submit", async () => {
    const a = await tenant(A);
    const id = await submit(a);
    delete process.env.MEMEX_AGENT_TENANT_ENABLED;
    const model = scriptedModel(CROSS_TENANT_SCRIPT);
    const run = await runJob(id, model.fn, countingDispatch().fn);
    expect(run.job.status).toBe("failed");
    expect(model.sent()).toBe(0);
  });
});
