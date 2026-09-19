/**
 * The GitHub connector: mirror a repository's issues and pull requests into one
 * named source.
 *
 * One run pages through `/repos/<owner>/<repo>/issues` (GitHub lists pull
 * requests there too) sorted by `updated_at`, from the watermark minus the
 * gap-heal window, or from the start with `full`. Each item is rendered,
 * secret-scanned and written through `putPage`, whose content-hash no-op makes
 * an unchanged item free; only pages that changed are mirrored into search.
 * Wiki links are synced after every page of the run is written, so a reference
 * to an item written later in the same run still resolves.
 *
 * The run ends:
 *   auth_required / forbidden — on the first 401 / 403 (or 404: a private
 *     repository the token cannot see); nothing after it is fetched;
 *   partial — a page fetch failed (rate limit past the cap, server error after
 *     retries, challenge page, a pagination link off the origin), or an item
 *     was refused or could not be written;
 *   nothing_new — the delta was empty;
 *   success — otherwise.
 * Only success and nothing_new move the watermark.
 */
import type { Storage } from "../storage.ts";
import type { EmbedFn } from "../indexer.ts";
import { putPage } from "../pages.ts";
import { mirrorPage } from "../page-index.ts";
import { syncWikilinksForPage } from "../links.ts";
import { logIngest } from "../ingest-log.ts";
import { OperationError } from "../operation-error.ts";
import { getSource } from "../sources.ts";
import {
  auditRejection,
  auditSecrets,
  describeFindings,
  SecretRejectedError,
  secretDisposition,
} from "../secret-scan.ts";
import { ConnectorClient, ConnectorRequestError, type FetchFn } from "./client.ts";
import { parseGithubItem, renderItem, type RenderedItem } from "./github-render.ts";
import type { ConnectorRunCounts, ConnectorRunStatus, ResponseClass } from "./types.ts";
import {
  connectorRecipeId,
  gapHealMinutes,
  laterOf,
  readWatermark,
  recordRun,
  sinceFor,
} from "./watermark.ts";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_PROVIDER = "github";
const WRITTEN_BY = "connector-github";
const PER_PAGE = 100;
/** 100 000 items; a run past this stops as partial rather than looping forever. */
const MAX_PAGES = 1000;
const LOG_SLUG_CAP = 500;

// GitHub's documented limits: owner up to 39 chars of [A-Za-z0-9-], a
// repository name up to 100 of [A-Za-z0-9._-]. Both bounded, so linear.
const OWNER_RE = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const REPO_RE = /^[\w.-]{1,100}$/;

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Parse `owner/repo`, or null when it is not one. */
export function parseRepoRef(s: string): RepoRef | null {
  const slash = s.indexOf("/");
  if (slash === -1 || s.includes("/", slash + 1)) return null;
  const owner = s.slice(0, slash);
  const repo = s.slice(slash + 1);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

export function githubTarget(ref: RepoRef, sourceId: string): string {
  return `${ref.owner}/${ref.repo}@${sourceId}`;
}

export function githubClient(token: string, opts: { fetch?: FetchFn; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): ConnectorClient {
  return new ConnectorClient({
    origin: GITHUB_API_ORIGIN,
    token,
    headers: {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "memex-connector",
    },
    ...opts,
  });
}

export function issuesPath(ref: RepoRef, since: string | null): string {
  const q = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", per_page: String(PER_PAGE) });
  if (since !== null) q.set("since", since);
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues?${q.toString()}`;
}

export interface GithubSyncResult {
  provider: "github";
  target: string;
  source_id: string;
  status: ConnectorRunStatus;
  full: boolean;
  since: string | null;
  counts: ConnectorRunCounts;
  redactions: number;
  mirror_failures: number;
  links_added: number;
  error_class: ResponseClass | null;
  http_status: number | null;
  error: string | null;
  watermark_before: string | null;
  watermark_after: string | null;
  rejected: Array<{ slug: string; reason: string }>;
  failed: Array<{ slug: string; code: string; reason: string }>;
}

export interface FetchedItems {
  items: unknown[];
  /** The response class that stopped paging early, if any. */
  stopClass: ResponseClass | null;
  stopStatus: number | null;
  stopError: string | null;
}

/** Page through the list. Stops at the first page that is not `ok`. */
export async function fetchIssuePages(client: ConnectorClient, ref: RepoRef, since: string | null): Promise<FetchedItems> {
  const items: unknown[] = [];
  let path: string | null = issuesPath(ref, since);
  for (let page = 0; path !== null; page++) {
    if (page >= MAX_PAGES) {
      return { items, stopClass: "server_error", stopStatus: null, stopError: `stopped after ${MAX_PAGES} pages` };
    }
    let res;
    try {
      res = await client.get(path);
    } catch (e) {
      if (!(e instanceof ConnectorRequestError)) throw e;
      return { items, stopClass: "challenge", stopStatus: null, stopError: e.message };
    }
    if (res.class !== "ok") return { items, stopClass: res.class, stopStatus: res.status, stopError: res.error };
    if (!Array.isArray(res.body)) {
      return { items, stopClass: "challenge", stopStatus: res.status, stopError: "list response is not an array" };
    }
    items.push(...res.body);
    path = res.next;
  }
  return { items, stopClass: null, stopStatus: null, stopError: null };
}

/** The run status for a fetch that stopped on `cls` (null: it did not stop). */
function statusForStop(cls: ResponseClass | null): ConnectorRunStatus | null {
  if (cls === null || cls === "ok") return null;
  if (cls === "auth_required") return "auth_required";
  if (cls === "forbidden") return "forbidden";
  return "partial";
}

export interface RenderPreview {
  items: number;
  issues: number;
  pull_requests: number;
  rejected: number;
  invalid: number;
  redactions: number;
}

/** Render every fetched item without writing: what `--dry-run` reports. */
export function previewItems(ref: RepoRef, raw: readonly unknown[]): RenderPreview {
  const out: RenderPreview = { items: raw.length, issues: 0, pull_requests: 0, rejected: 0, invalid: 0, redactions: 0 };
  for (const r of raw) {
    const item = parseGithubItem(r);
    if (item === null) {
      out.invalid++;
      continue;
    }
    if (item.is_pull_request) out.pull_requests++;
    else out.issues++;
    try {
      out.redactions += renderItem(ref.owner, ref.repo, item).findings.length;
    } catch (e) {
      if (!(e instanceof SecretRejectedError)) throw e;
      out.rejected++;
    }
  }
  return out;
}

/** Audit a refusal once per identical finding set, so a re-fetch in the gap window adds no rows. */
async function auditRejectionOnce(storage: Storage, e: SecretRejectedError, ref: string, sourceId: string): Promise<void> {
  const seen = await storage.engine().query(
    `SELECT 1 FROM ingest_log
      WHERE source_type = 'secret-rejected' AND source_ref = $1 AND source_id = $2 AND summary = $3
      LIMIT 1`,
    [ref, sourceId, describeFindings(e.findings)],
  );
  if (seen.rows.length === 0) await auditRejection(storage.engine(), e, ref, sourceId);
}

export interface GithubSyncOptions {
  ref: RepoRef;
  sourceId: string;
  client: ConnectorClient;
  full?: boolean;
  now?: () => number;
  embedFn?: EmbedFn;
}

/** Refuse a source that does not exist or is not a `github` source. */
export async function assertGithubSource(storage: Storage, sourceId: string): Promise<void> {
  const source = await getSource(storage.engine(), sourceId);
  if (source === null) {
    throw new OperationError(
      "invalid_params",
      `unknown source '${sourceId}'`,
      "Register it first: memex sources register <id> --kind github --path-prefix github/<owner>/<repo>/",
    );
  }
  if (source.kind !== "github") {
    throw new OperationError(
      "invalid_params",
      `source '${sourceId}' is kind '${source.kind}', not 'github'`,
      "Connector pages go only into a source registered with --kind github.",
    );
  }
}

async function writeItem(
  storage: Storage,
  rendered: RenderedItem,
  sourceId: string,
  opts: GithubSyncOptions,
  result: GithubSyncResult,
  changed: RenderedItem[],
): Promise<void> {
  const put = await putPage(storage, {
    slug: rendered.slug,
    type: rendered.type,
    allowAdHocType: true,
    title: rendered.title,
    markdown_body: rendered.body,
    compiled_truth: rendered.truth,
    written_by: WRITTEN_BY,
    source_id: sourceId,
  });
  if (!put.changed && !put.created) {
    result.counts.pages_unchanged++;
    return;
  }
  result.counts.pages_written++;
  changed.push(rendered);
  // Under `flag` the credential is still in the text and putPage audited it.
  if (secretDisposition() !== "flag") await auditSecrets(storage.engine(), rendered.findings, rendered.slug, sourceId);
  const ok = await mirrorPage(
    storage,
    { slug: rendered.slug, title: rendered.title, markdown_body: rendered.body, content_hash: put.content_hash, source_id: sourceId },
    { remote: false, timingLabel: "connector_github", ...(opts.embedFn ? { embedFn: opts.embedFn } : {}) },
  );
  if (!ok) result.mirror_failures++;
}

export async function syncGithub(storage: Storage, opts: GithubSyncOptions): Promise<GithubSyncResult> {
  const { ref, sourceId } = opts;
  await assertGithubSource(storage, sourceId);
  const engine = storage.engine();
  const now = opts.now ?? Date.now;
  const target = githubTarget(ref, sourceId);
  const recipeId = connectorRecipeId(GITHUB_PROVIDER, target);
  const watermarkBefore = await readWatermark(engine, recipeId);
  const since = opts.full ? null : sinceFor(watermarkBefore, gapHealMinutes());

  const result: GithubSyncResult = {
    provider: "github",
    target,
    source_id: sourceId,
    status: "success",
    full: opts.full === true,
    since,
    counts: { items: 0, pages_written: 0, pages_unchanged: 0, items_rejected: 0, items_failed: 0 },
    redactions: 0,
    mirror_failures: 0,
    links_added: 0,
    error_class: null,
    http_status: null,
    error: null,
    watermark_before: watermarkBefore,
    watermark_after: watermarkBefore,
    rejected: [],
    failed: [],
  };

  const fetched = await fetchIssuePages(opts.client, ref, since);
  const stopStatus = statusForStop(fetched.stopClass);
  result.error_class = fetched.stopClass;
  result.http_status = fetched.stopStatus;
  result.error = fetched.stopError;

  const changed: RenderedItem[] = [];
  let maxUpdated: string | null = null;
  // A refused credential ends the run before anything is written: the items
  // of a page that did arrive belong to a token the provider no longer honours.
  if (stopStatus !== "auth_required" && stopStatus !== "forbidden") {
    for (const raw of fetched.items) {
      const item = parseGithubItem(raw);
      result.counts.items++;
      if (item === null) {
        result.counts.items_failed++;
        result.failed.push({ slug: "(unparsed)", code: "invalid_item", reason: "list element is not an issue" });
        continue;
      }
      maxUpdated = laterOf(maxUpdated, item.updated_at);
      let rendered: RenderedItem;
      try {
        rendered = renderItem(ref.owner, ref.repo, item);
      } catch (e) {
        if (!(e instanceof SecretRejectedError)) throw e;
        const slugRef = `github:${ref.owner}/${ref.repo}#${item.number}`;
        await auditRejectionOnce(storage, e, slugRef, sourceId);
        result.counts.items_rejected++;
        result.rejected.push({ slug: slugRef, reason: e.message });
        continue;
      }
      result.redactions += rendered.findings.length;
      try {
        await writeItem(storage, rendered, sourceId, opts, result, changed);
      } catch (e) {
        if (!(e instanceof OperationError)) throw e;
        result.counts.items_failed++;
        result.failed.push({ slug: rendered.slug, code: e.code, reason: e.message });
      }
    }
    for (const page of changed) {
      const r = await syncWikilinksForPage(storage, page.slug, page.body, sourceId);
      result.links_added += r.added;
    }
  }

  const itemTrouble = result.counts.items_rejected + result.counts.items_failed > 0;
  result.status =
    stopStatus ?? (itemTrouble ? "partial" : result.counts.items === 0 ? "nothing_new" : "success");

  // An empty delta advances to the run's start. The next since is that minus
  // the gap-heal window, which also absorbs a clock skew smaller than it.
  const newWatermark = result.status === "nothing_new" ? new Date(now()).toISOString() : maxUpdated;
  await recordRun(
    engine,
    recipeId,
    {
      provider: GITHUB_PROVIDER,
      target,
      source_id: sourceId,
      status: result.status,
      at: new Date(now()).toISOString(),
      counts: result.counts,
      error_class: result.error_class,
      http_status: result.http_status,
    },
    newWatermark,
  );
  result.watermark_after = await readWatermark(engine, recipeId);

  if (changed.length > 0) {
    await logIngest(engine, {
      source_type: "connector-github",
      source_ref: target,
      pages_updated: changed.slice(0, LOG_SLUG_CAP).map((p) => p.slug),
      summary:
        `status ${result.status}, items ${result.counts.items}, written ${result.counts.pages_written}, ` +
        `unchanged ${result.counts.pages_unchanged}, rejected ${result.counts.items_rejected}, ` +
        `failed ${result.counts.items_failed}, redactions ${result.redactions}`,
      source_id: sourceId,
    });
  }
  return result;
}
