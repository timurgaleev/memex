/**
 * The GitHub connector end to end on PGLite, against recorded API responses:
 * a fixture repository mirrored with its links and a redacted credential, a
 * free re-run, each run status, the clean-run-only watermark with its gap-heal
 * window, and the CLI's refusals, dry run and exit codes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import * as pages from "../src/core/pages.ts";
import * as pageIndex from "../src/core/page-index.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { SecretRejectedError } from "../src/core/secret-scan.ts";
import {
  githubClient,
  githubTarget,
  isDeterministicRefusal,
  issuesPath,
  syncGithub,
  type RepoRef,
} from "../src/core/connectors/github.ts";
import { checkConnectorHealth } from "../src/core/connectors/health.ts";
import { connectorRecipeId, readLastRun, readRefused, readWatermark } from "../src/core/connectors/watermark.ts";
import { runConnectors } from "../src/commands/connectors.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { API, fakeClock, LEAKED_TOKEN, recorded, replay, type Recorded } from "./github-recorded.ts";

const embedFn = async (t: string) => deterministicEmbed(t);
const REF: RepoRef = { owner: "acme", repo: "widgets" };
const RECIPE = connectorRecipeId("github", "acme/widgets@gh-acme");
// Assembled at run time: a token shape must not sit in the source.
const API_TOKEN = ["fixture", "token", "value"].join("-");
const FULL_REPO = () => [recorded("issues-page-1"), recorded("issues-page-2")];

let tmp: string;
let storage: Storage;
const savedGap = process.env.MEMEX_CONNECTOR_GAP_HEAL_MINUTES;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(sql, params);
  return Number(r.rows[0]!.n);
}

async function sync(responses: Array<Recorded | Error>, opts: { full?: boolean; sourceId?: string } = {}) {
  const clock = fakeClock();
  const fake = replay(responses);
  const { sourceId = "gh-acme", ...rest } = opts;
  const result = await syncGithub(storage, {
    ref: REF,
    sourceId,
    client: githubClient(API_TOKEN, { fetch: fake.fetch, now: clock.now, sleep: clock.sleep }),
    now: clock.now,
    embedFn,
    ...rest,
  });
  return { result, fake };
}

async function withDisposition<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.MEMEX_SECRET_SCAN_DISPOSITION;
  process.env.MEMEX_SECRET_SCAN_DISPOSITION = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.MEMEX_SECRET_SCAN_DISPOSITION;
    else process.env.MEMEX_SECRET_SCAN_DISPOSITION = saved;
  }
}

const listPage = (items: Array<{ number: number; updated_at: string }>, nextPage: number | null): Recorded => ({
  status: 200,
  headers: nextPage === null
    ? {}
    : { link: `<${API}/repositories/4242/issues?state=all&sort=updated&direction=desc&per_page=2&page=${nextPage}>; rel="next"` },
  body: items.map((i) => ({ ...i, title: `Item ${i.number}`, body: "", state: "open" })),
});

beforeEach(async () => {
  process.env.MEMEX_CONNECTOR_GAP_HEAL_MINUTES = "30";
  tmp = mkdtempSync(join(tmpdir(), "memex-connectors-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "gh-acme", kind: "github", pathPrefix: "github/acme/widgets/" });
  await registerSource(storage.engine(), { id: "notes", kind: "other", pathPrefix: "/srv/notes" });
});
afterEach(async () => {
  if (savedGap === undefined) delete process.env.MEMEX_CONNECTOR_GAP_HEAL_MINUTES;
  else process.env.MEMEX_CONNECTOR_GAP_HEAL_MINUTES = savedGap;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("a fixture repository", () => {
  it("mirrors issues and pull requests with their links and the credential redacted", async () => {
    const { result, fake } = await sync(FULL_REPO());
    expect(result.status).toBe("success");
    expect(result.counts).toMatchObject({ items: 3, pages_written: 3, items_rejected: 0, items_failed: 0 });
    expect(result.redactions).toBe(1);
    expect(fake.urls[1]).toBe(`${API}/repositories/4242/issues?state=all&sort=updated&direction=desc&per_page=100&page=2`);

    const pr = await getPage(storage, "github/acme/widgets/pulls/2");
    expect(pr?.source_id).toBe("gh-acme");
    expect(pr?.type).toBe("github-pull-request");
    const issue3 = await getPage(storage, "github/acme/widgets/issues/3");
    expect(issue3!.markdown_body).not.toContain(LEAKED_TOKEN);
    expect(issue3!.markdown_body).toContain("[REDACTED:github-token:");

    const links = await storage.engine().query<{ target_slug: string; source_id: string }>(
      `SELECT target_slug, source_id FROM links WHERE source_slug = $1 ORDER BY target_slug`,
      ["github/acme/widgets/pulls/2"],
    );
    expect(links.rows).toEqual([
      { target_slug: "github/acme/widgets/issues/1", source_id: "gh-acme" },
      { target_slug: "github/acme/widgets/issues/3", source_id: "gh-acme" },
    ]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ingest_log WHERE source_type = 'secret-redacted'`)).toBe(1);

    expect(await readWatermark(storage.engine(), RECIPE)).toBe("2026-09-03T09:30:00Z");
    const run = await readLastRun(storage.engine(), RECIPE);
    expect(run).toMatchObject({ status: "success", source_id: "gh-acme", error_class: null });
    expect(JSON.stringify(run)).not.toContain(API_TOKEN);
  });

  it("lands a reference to a pull request on the pull-request page", async () => {
    const page: Recorded = {
      status: 200,
      headers: {},
      body: [{ number: 5, title: "Follow-up", body: "Continues #2.", state: "open", updated_at: "2026-09-04T00:00:00Z" }],
    };
    await sync(FULL_REPO());
    await sync([page]);
    const links = await storage.engine().query<{ target_slug: string }>(
      `SELECT target_slug FROM links WHERE source_slug = 'github/acme/widgets/issues/5'`,
    );
    expect(links.rows.map((r) => r.target_slug)).toEqual(["github/acme/widgets/pulls/2"]);
  });

  it("writes nothing on an identical re-run", async () => {
    await sync(FULL_REPO());
    const versions = await count(`SELECT COUNT(*)::int AS n FROM page_versions`);
    const audits = await count(`SELECT COUNT(*)::int AS n FROM ingest_log`);
    const { result } = await sync(FULL_REPO(), { full: true });
    expect(result.status).toBe("success");
    expect(result.counts).toMatchObject({ items: 3, pages_written: 0, pages_unchanged: 3 });
    expect(await count(`SELECT COUNT(*)::int AS n FROM page_versions`)).toBe(versions);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ingest_log`)).toBe(audits);
  });

  it("indexes issue and pull request text as untrusted", async () => {
    const mirror = spyOn(pageIndex, "mirrorPage");
    try {
      await sync(FULL_REPO());
      expect(mirror).toHaveBeenCalledTimes(3);
      for (const call of mirror.mock.calls) expect(call[2].remote).toBe(true);
    } finally {
      mirror.mockRestore();
    }
  });

  it("refuses a source that is not a github source, before any request", async () => {
    const fake = replay([]);
    const run = syncGithub(storage, { ref: REF, sourceId: "notes", client: githubClient(API_TOKEN, { fetch: fake.fetch }) });
    await expect(run).rejects.toThrow("not 'github'");
    expect(fake.urls).toEqual([]);
  });
});

describe("run statuses and the watermark", () => {
  it("asks for the watermark minus the gap-heal window", async () => {
    await sync(FULL_REPO());
    const { result, fake } = await sync([recorded("empty")]);
    expect(result.since).toBe("2026-09-03T09:00:00.000Z");
    expect(fake.urls[0]).toBe(`${API}${issuesPath(REF, "2026-09-03T09:00:00.000Z")}`);
    expect(fake.urls[0]).toContain("since=2026-09-03T09%3A00%3A00.000Z");
  });

  it("reports nothing_new on an empty delta and advances to the run start", async () => {
    await sync(FULL_REPO());
    const { result } = await sync([recorded("empty")]);
    expect(result.status).toBe("nothing_new");
    expect(result.watermark_after).toBe("2026-09-19T12:00:00.000Z");
  });

  it("is partial on a mid-run 502 and keeps the watermark", async () => {
    await sync([recorded("empty")]);
    const before = await readWatermark(storage.engine(), RECIPE);
    const bad = recorded("bad-gateway");
    const { result } = await sync([recorded("issues-page-1"), bad, bad, bad, bad]);
    expect(result.status).toBe("partial");
    expect(result.error_class).toBe("server_error");
    expect(result.counts.pages_written).toBe(2);
    expect(await readWatermark(storage.engine(), RECIPE)).toBe(before);
    expect(await readLastRun(storage.engine(), RECIPE)).toMatchObject({ status: "partial", http_status: 502 });
  });

  it("is auth_required on a 401: no writes, watermark unchanged, last run recorded", async () => {
    await sync([recorded("empty")]);
    const before = await readWatermark(storage.engine(), RECIPE);
    const { result } = await sync([recorded("unauthorized")]);
    expect(result.status).toBe("auth_required");
    expect(await count(`SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'gh-acme'`)).toBe(0);
    expect(await readWatermark(storage.engine(), RECIPE)).toBe(before);
    const run = await readLastRun(storage.engine(), RECIPE);
    expect(run).toMatchObject({ status: "auth_required", http_status: 401, error_class: "auth_required" });
    expect(run!.last_success_at).toBe("2026-09-19T12:00:00.000Z");
  });

  it("is forbidden on a plain 403", async () => {
    const { result } = await sync([recorded("forbidden")]);
    expect(result.status).toBe("forbidden");
    expect(await readWatermark(storage.engine(), RECIPE)).toBeNull();
  });

  it("is partial when paging stops on a rate limit past the cap", async () => {
    const { result } = await sync([recorded("issues-page-1"), recorded("primary-limit")]);
    expect(result.status).toBe("partial");
    expect(result.error_class).toBe("rate_limited");
    expect(await readWatermark(storage.engine(), RECIPE)).toBeNull();
  });

  it("records an item refused under reject without holding the watermark, and clears it once written", async () => {
    const first = await withDisposition("reject", () => sync(FULL_REPO()));
    expect(first.result.status).toBe("success");
    expect(first.result.counts).toMatchObject({ pages_written: 2, items_rejected: 1 });
    expect(await getPage(storage, "github/acme/widgets/issues/3")).toBeNull();
    expect(await readWatermark(storage.engine(), RECIPE)).toBe("2026-09-03T09:30:00Z");
    expect(await readRefused(storage.engine(), RECIPE)).toMatchObject([{ slug: "github/acme/widgets/issues/3", code: "invalid_params" }]);
    const doctor = await checkConnectorHealth(storage.engine(), Date.parse("2026-09-19T12:00:00Z"));
    expect(doctor.status).toBe("warn");
    expect(doctor.detail).toContain("1 item(s) refused, github/acme/widgets/issues/3 (invalid_params:");

    await sync(FULL_REPO(), { full: true });
    expect(await getPage(storage, "github/acme/widgets/issues/3")).not.toBeNull();
    expect(await readRefused(storage.engine(), RECIPE)).toEqual([]);
    expect((await checkConnectorHealth(storage.engine(), Date.parse("2026-09-19T12:00:00Z"))).status).toBe("ok");
  });

  it("does not stall on slugs another source owns: refused, named, watermark advanced", async () => {
    await sync(FULL_REPO());
    await registerSource(storage.engine(), { id: "gh-copy", kind: "github", pathPrefix: "github/acme/widgets-copy/" });
    const { result } = await sync(FULL_REPO(), { sourceId: "gh-copy" });
    expect(result.status).toBe("success");
    expect(result.counts).toMatchObject({ items: 3, pages_written: 0, items_failed: 3 });
    expect(result.failed.every((f) => f.code === "permission_denied" && !f.retryable)).toBe(true);
    const copy = connectorRecipeId("github", "acme/widgets@gh-copy");
    expect(await readWatermark(storage.engine(), copy)).toBe("2026-09-03T09:30:00Z");
    expect((await readRefused(storage.engine(), copy)).map((r) => r.slug).sort()).toEqual([
      "github/acme/widgets/issues/1",
      "github/acme/widgets/issues/3",
      "github/acme/widgets/pulls/2",
    ]);
  });

  it("is partial on a write failure a retry may fix, and keeps the watermark", async () => {
    const put = spyOn(pages, "putPage").mockImplementationOnce(async () => {
      throw new OperationError("storage_error", "connection reset");
    });
    try {
      const { result } = await sync(FULL_REPO());
      expect(result.status).toBe("partial");
      expect(result.failed).toMatchObject([{ code: "storage_error", retryable: true }]);
      expect(await readWatermark(storage.engine(), RECIPE)).toBeNull();
      expect(await readRefused(storage.engine(), RECIPE)).toEqual([]);
    } finally {
      put.mockRestore();
    }
  });

  it("tells a refusal that repeats from a failure that may not", () => {
    expect(isDeterministicRefusal(new SecretRejectedError("x", []))).toBe(true);
    expect(isDeterministicRefusal(new OperationError("permission_denied", "owned elsewhere"))).toBe(true);
    expect(isDeterministicRefusal(new OperationError("storage_error", "reset"))).toBe(false);
  });
});

describe("a list that changes while the run pages through it", () => {
  // Newest first, two per page. Item 3 is updated after the run starts, so it
  // jumps to the front (a page already read) and every item behind it shifts
  // one place: item 4 shows up on page 1 and again on page 2.
  const shifted = () => [
    listPage([{ number: 6, updated_at: "2026-09-19T12:00:30Z" }, { number: 5, updated_at: "2026-09-10T00:00:00Z" }], 2),
    listPage([{ number: 4, updated_at: "2026-09-09T00:00:00Z" }, { number: 2, updated_at: "2026-09-07T00:00:00Z" }], 3),
    listPage([{ number: 1, updated_at: "2026-09-06T00:00:00Z" }], null),
  ];

  it("repeats an item instead of skipping one, and writes every item it saw once", async () => {
    const { result } = await sync(shifted());
    expect(result.status).toBe("success");
    expect(result.counts).toMatchObject({ items: 5, pages_written: 5, items_failed: 0 });
    for (const n of [1, 2, 4, 5, 6]) expect(await getPage(storage, `github/acme/widgets/issues/${n}`)).not.toBeNull();
  });

  it("never moves the watermark past the run's start, so an item updated mid-run is the next run's", async () => {
    await sync(shifted());
    // Item 6 carries a time after the run began; the watermark stops at the start.
    expect(await readWatermark(storage.engine(), RECIPE)).toBe("2026-09-19T12:00:00.000Z");
    const { result } = await sync([recorded("empty")]);
    // Item 3's new version (updated at 12:00:10) falls inside the next delta.
    expect(Date.parse(result.since!)).toBeLessThanOrEqual(Date.parse("2026-09-19T12:00:10Z"));
  });

  it("asks for the newest items first", () => {
    expect(issuesPath(REF, null)).toContain("direction=desc");
  });
});

describe("targets", () => {
  it("fold case, so one repository has one watermark", () => {
    expect(githubTarget({ owner: "Acme", repo: "Widgets" }, "gh-acme")).toBe(githubTarget(REF, "gh-acme"));
  });
});

describe("memex connectors", () => {
  const cliTmp = mkdtempSync(join(tmpdir(), "memex-connectors-cli-"));
  const cfgPath = join(cliTmp, ".memex", "config.json");
  const tokenFile = join(cliTmp, "token");
  let log: ReturnType<typeof spyOn>;
  let err: ReturnType<typeof spyOn>;
  const savedToken = process.env.MEMEX_GITHUB_TOKEN;

  beforeAll(async () => {
    mkdirSync(join(cliTmp, ".memex"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { type: "pglite", path: join(cliTmp, ".memex", "brain.pglite") },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }),
    );
    writeFileSync(tokenFile, `${API_TOKEN}\n`);
    const s = new Storage(JSON.parse(readFileSync(cfgPath, "utf-8")));
    await s.init();
    try {
      await registerSource(s.engine(), { id: "gh-acme", kind: "github", pathPrefix: "github/acme/widgets/" });
    } finally {
      await s.close();
    }
  });
  beforeEach(() => {
    delete process.env.MEMEX_GITHUB_TOKEN;
    log = spyOn(console, "log").mockImplementation(() => {});
    err = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    if (savedToken === undefined) delete process.env.MEMEX_GITHUB_TOKEN;
    else process.env.MEMEX_GITHUB_TOKEN = savedToken;
  });
  afterAll(() => rmSync(cliTmp, { recursive: true, force: true }));

  const lastJson = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
  const everythingPrinted = () => JSON.stringify([...log.mock.calls, ...err.mock.calls]);
  const base = { sub: "github", action: "sync", target: "acme/widgets", sourceId: "gh-acme", json: true, configPath: cfgPath, embedFn };

  it("refuses to run without a token", async () => {
    expect(await runConnectors({ ...base })).toBe(1);
    expect(lastJson().error).toContain("MEMEX_GITHUB_TOKEN");
  });

  it("refuses a token file that is a directory", async () => {
    expect(await runConnectors({ ...base, tokenFile: cliTmp })).toBe(1);
    expect(lastJson().error).toContain("not a regular file");
  });

  it("refuses a malformed repository and a missing --source", async () => {
    expect(await runConnectors({ ...base, tokenFile, target: "acme" })).toBe(1);
    const { sourceId: _drop, ...noSource } = base;
    expect(await runConnectors({ ...noSource, tokenFile })).toBe(1);
    expect(lastJson().error).toContain("--source");
  });

  it("refuses an unknown source without spending a request", async () => {
    const fake = replay([]);
    expect(await runConnectors({ ...base, tokenFile, sourceId: "nope", fetch: fake.fetch })).toBe(1);
    expect(lastJson().error).toContain("unknown source 'nope'");
    expect(fake.urls).toEqual([]);
  });

  it("previews on --dry-run without opening the brain, then syncs, then writes nothing", async () => {
    const clock = fakeClock();
    const seams = { now: clock.now, sleep: clock.sleep };
    const dry = replay(FULL_REPO());
    expect(await runConnectors({ ...base, tokenFile, dryRun: true, fetch: dry.fetch, ...seams })).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      dry_run: true,
      status: "success",
      preview: { items: 3, issues: 2, pull_requests: 1, redactions: 1 },
    });

    process.env.MEMEX_GITHUB_TOKEN = API_TOKEN;
    const first = replay(FULL_REPO());
    expect(await runConnectors({ ...base, fetch: first.fetch, full: true, ...seams })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, status: "success", counts: { pages_written: 3 } });
    expect((first.inits[0]!.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${API_TOKEN}`);

    const second = replay(FULL_REPO());
    expect(await runConnectors({ ...base, fetch: second.fetch, full: true, ...seams })).toBe(0);
    expect(lastJson()).toMatchObject({ status: "success", counts: { pages_written: 0, pages_unchanged: 3 } });

    expect(await runConnectors({ sub: "status", json: true, configPath: cfgPath })).toBe(0);
    expect(lastJson().connectors[0]).toMatchObject({
      recipe_id: RECIPE,
      watermark: "2026-09-03T09:30:00Z",
      last_run: { status: "success" },
    });
    expect(everythingPrinted()).not.toContain(API_TOKEN);
  });

  it("exits 2 on a refused credential and 1 on a partial run", async () => {
    const clock = fakeClock();
    const seams = { now: clock.now, sleep: clock.sleep };
    expect(await runConnectors({ ...base, tokenFile, fetch: replay([recorded("unauthorized")]).fetch, ...seams })).toBe(2);
    expect(lastJson()).toMatchObject({ ok: false, status: "auth_required" });
    const bad = recorded("bad-gateway");
    expect(await runConnectors({ ...base, tokenFile, fetch: replay([bad, bad, bad, bad]).fetch, ...seams })).toBe(1);
    expect(lastJson()).toMatchObject({ ok: false, status: "partial" });
    expect(everythingPrinted()).not.toContain(API_TOKEN);
  });
});
