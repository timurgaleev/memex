/**
 * Gmail recipe — pulls recent messages, asks Nova Lite which ones are
 * worth keeping, and indexes the survivors directly into Postgres
 * (documents + chunks + embeddings) via `indexDocument`. No filesystem
 * artifact — the index is the durable surface.
 *
 * Flow per poll:
 *   1. throttle.preflight — soft-skip if the system is loaded.
 *   2. Load `<SECRETS_PREFIX>/gmail-oauth` from Secrets Manager (or env override
 *      `MEMEX_GMAIL_OAUTH` for tests).
 *   3. Refresh access_token if cache is stale.
 *   4. messages.list (q=newer_than:Hh, maxResults≤50).
 *   5. Filter against recipe_state dedup set.
 *   6. messages.get for each, extract subject/from/body.
 *   7. Nova Lite Converse → { score, reason }; keep if score ≥ threshold.
 *   8. indexDocument(storage, { sourcePath: 'gmail:<id>', text: <markdown> }).
 *   9. Append seen ids to recipe_state.
 *
 * Source attribution: documents land with sourcePath `gmail:<message.id>`
 * — the `gmail` source row has path_prefix `gmail:` so source_id
 * resolves correctly. Re-indexing the same message id is idempotent
 * because indexDocument keys the document row by sha256(sourcePath).
 *
 * Concurrency: meant to be called from a single Worker, single in-flight
 * job. No internal parallelism; a Bedrock burst of 50 calls is fine
 * sequentially (each ~200ms).
 */
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Storage } from "../core/storage.ts";
import { preflight, complete } from "../core/throttle.ts";
import { appendDedupIds, filterUnseenIds } from "../core/recipe-state.ts";
import {
  indexDocument,
  type IndexInput,
  type IndexResult,
  type IndexFileOptions,
} from "../core/indexer.ts";

export interface GmailSecret {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** Threshold from the secret; CLI/job payload can override. Default 0.1. */
  signal_threshold?: number;
  /** Cron cadence; not used by the recipe directly — read by the
   *  scheduler (cron job that enqueues `gmail.poll`). */
  poll_minutes?: number;
}

export interface PollGmailOptions {
  /** Stub fetch for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Stub the Bedrock client (tests pass a `{ send }` shim). */
  bedrockClient?: BedrockRuntimeClient;
  /** Bypass Secrets Manager — pass the parsed JSON directly. */
  secret?: GmailSecret;
  /** Override "now" (tests). */
  now?: Date;
  /** Hard cap on messages.list output. Default 50. */
  maxMessages?: number;
  /** Time window for the `newer_than:` query, hours. Default 24. */
  sinceHours?: number;
  /** Override secret.signal_threshold. */
  signalThreshold?: number;
  /** Bedrock model id (signal classifier). Default Nova Lite. */
  modelId?: string;
  /** Skip the indexDocument call + dedup persistence (still hits
   *  Gmail and Bedrock signal-detect — useful for ops smoke tests). */
  dryRun?: boolean;
  /** Override system sensors used by throttle.preflight (tests). */
  systemSensors?: { loadAvg1?: number; memoryRssMB?: number };
  /** Override the indexer (tests). Defaults to the real `indexDocument`. */
  indexFn?: (
    storage: Storage,
    input: IndexInput,
    opts?: IndexFileOptions,
  ) => Promise<IndexResult>;
  /** Embedding model override forwarded to `indexDocument` (tests). */
  embeddingModel?: string;
}

export interface PollGmailResult {
  scanned: number;
  processed: number;
  ingested: number;
  skippedDedup: number;
  skippedLowSignal: number;
  errors: { id: string; error: string }[];
  reason?: string; // populated when throttle declines
}

const SECRETS_PREFIX = process.env.SECRETS_PREFIX ?? "memex";
const SECRET_ID =
  process.env.MEMEX_GMAIL_SECRET_ID ?? `${SECRETS_PREFIX}/gmail-oauth`;
const REGION = process.env.AWS_REGION ?? "eu-west-1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_GRACE_MS = 60_000;

interface CachedToken {
  refreshToken: string; // bind cache to the source refresh_token
  accessToken: string;
  expiresAt: Date;
}
let _tokenCache: CachedToken | null = null;

/** Test hook — clears the in-process token cache. */
export function _resetTokenCacheForTesting(): void {
  _tokenCache = null;
}

let _smClient: SecretsManagerClient | null = null;
function getSecretsClient(): SecretsManagerClient {
  if (!_smClient) _smClient = new SecretsManagerClient({ region: REGION });
  return _smClient;
}

export async function loadGmailSecret(opts: {
  client?: SecretsManagerClient;
} = {}): Promise<GmailSecret> {
  // Tests + local dev: pass the secret as JSON via env.
  const envOverride = process.env.MEMEX_GMAIL_OAUTH;
  if (envOverride && envOverride.length > 0) {
    return JSON.parse(envOverride) as GmailSecret;
  }
  const client = opts.client ?? getSecretsClient();
  const r = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  if (!r.SecretString) {
    throw new Error(`loadGmailSecret: ${SECRET_ID} has no SecretString`);
  }
  const parsed = JSON.parse(r.SecretString) as GmailSecret;
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
    throw new Error(
      `loadGmailSecret: ${SECRET_ID} missing required fields (client_id, client_secret, refresh_token)`,
    );
  }
  return parsed;
}

export async function refreshAccessToken(
  secret: GmailSecret,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<{ accessToken: string; expiresAt: Date }> {
  const now = opts.now ?? new Date();
  if (
    _tokenCache &&
    _tokenCache.refreshToken === secret.refresh_token &&
    _tokenCache.expiresAt.getTime() - REFRESH_GRACE_MS > now.getTime()
  ) {
    return { accessToken: _tokenCache.accessToken, expiresAt: _tokenCache.expiresAt };
  }
  const f = opts.fetch ?? fetch;
  const body = new URLSearchParams({
    client_id: secret.client_id,
    client_secret: secret.client_secret,
    refresh_token: secret.refresh_token,
    grant_type: "refresh_token",
  }).toString();
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refreshAccessToken: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  if (!json.access_token || !json.expires_in) {
    throw new Error(`refreshAccessToken: malformed response ${JSON.stringify(json)}`);
  }
  const expiresAt = new Date(now.getTime() + json.expires_in * 1000);
  _tokenCache = {
    refreshToken: secret.refresh_token,
    accessToken: json.access_token,
    expiresAt,
  };
  return { accessToken: json.access_token, expiresAt };
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const MAX_BODY_CHARS = 4096;

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  payload?: {
    headers?: { name: string; value: string }[];
    parts?: GmailPart[];
    body?: { data?: string };
    mimeType?: string;
  };
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

export interface ExtractedMessage {
  id: string;
  threadId: string;
  date: string; // RFC 3339
  subject: string;
  from: string;
  to: string;
  body: string;
}

function header(message: GmailMessage, name: string): string {
  const h = (message.payload?.headers ?? []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

function decodeBase64Url(data: string): string {
  // Bun's Buffer supports "base64url" natively.
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function findFirstPart(
  parts: GmailPart[] | undefined,
  mimeType: string,
): GmailPart | null {
  if (!parts) return null;
  for (const p of parts) {
    if (p.mimeType === mimeType && p.body?.data) return p;
    const inner = findFirstPart(p.parts, mimeType);
    if (inner) return inner;
  }
  return null;
}

export function extractMessageContent(message: GmailMessage): ExtractedMessage {
  const subject = header(message, "Subject");
  const from = header(message, "From");
  const to = header(message, "To");
  const date = header(message, "Date") || new Date(Number(message.internalDate)).toISOString();

  let body = "";
  const plain = findFirstPart(message.payload?.parts, "text/plain");
  if (plain?.body?.data) {
    body = decodeBase64Url(plain.body.data);
  } else {
    const html = findFirstPart(message.payload?.parts, "text/html");
    if (html?.body?.data) {
      body = stripHtml(decodeBase64Url(html.body.data));
    } else if (message.payload?.body?.data) {
      const raw = decodeBase64Url(message.payload.body.data);
      body = message.payload.mimeType === "text/html" ? stripHtml(raw) : raw;
    }
  }

  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS);
  return { id: message.id, threadId: message.threadId, date, subject, from, to, body };
}

export async function listMessageIds(args: {
  accessToken: string;
  query: string;
  maxResults: number;
  fetch?: typeof fetch;
}): Promise<string[]> {
  const f = args.fetch ?? fetch;
  const url =
    `${GMAIL_BASE}/users/me/messages` +
    `?q=${encodeURIComponent(args.query)}` +
    `&maxResults=${args.maxResults}`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`listMessageIds: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { messages?: { id: string }[] };
  return (json.messages ?? []).map((m) => m.id);
}

export async function getMessage(args: {
  accessToken: string;
  id: string;
  fetch?: typeof fetch;
}): Promise<GmailMessage> {
  const f = args.fetch ?? fetch;
  const url = `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(args.id)}?format=full`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getMessage(${args.id}): ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as GmailMessage;
}

const DEFAULT_MODEL_ID =
  process.env.GMAIL_SIGNAL_MODEL_ID ?? "global.amazon.nova-2-lite-v1:0";

const SIGNAL_SYSTEM = `You score email messages for personal-knowledge ingestion.

Output a single JSON object (no surrounding code fences, no commentary):

{ "score": <float 0..1>, "reason": "<short phrase, ≤80 chars>" }

Scoring rubric:
- 0.9–1.0: direct action item or commitment from a real person
- 0.6–0.9: substantive correspondence (project updates, decisions)
- 0.3–0.6: contextual but not actionable (FYI threads, meeting recaps)
- 0.1–0.3: low-value notifications (calendar reminders, receipts)
- 0.0–0.1: marketing, transactional confirmations, automated digests

Be terse. Score conservatively — when in doubt, score lower.`;

let _bedrockClient: BedrockRuntimeClient | null = null;
function getBedrockClient(): BedrockRuntimeClient {
  if (!_bedrockClient) _bedrockClient = new BedrockRuntimeClient({ region: REGION });
  return _bedrockClient;
}

function parseSignalJson(raw: string): { score: number; reason: string } {
  // Tolerate ```json fences and trailing prose.
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const objMatch = /\{[\s\S]*\}/.exec(candidate ?? "");
  if (!objMatch) {
    throw new Error(`classifySignal: cannot parse JSON from response: ${raw.slice(0, 120)}`);
  }
  let parsed: { score?: number; reason?: string };
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch (e) {
    throw new Error(
      `classifySignal: cannot parse JSON from response: ${(e as Error).message}`,
    );
  }
  const score = Math.max(0, Math.min(1, Number(parsed.score ?? 0)));
  const reason = String(parsed.reason ?? "").slice(0, 200);
  return { score, reason };
}

export async function classifySignal(args: {
  client?: BedrockRuntimeClient;
  modelId?: string;
  subject: string;
  from: string;
  bodyExcerpt: string;
}): Promise<{ score: number; reason: string }> {
  const client = args.client ?? getBedrockClient();
  const modelId = args.modelId ?? DEFAULT_MODEL_ID;
  const userText =
    `From: ${args.from}\n` +
    `Subject: ${args.subject}\n\n` +
    `${args.bodyExcerpt.slice(0, 2000)}`;
  const cmd = new ConverseCommand({
    modelId,
    system: [{ text: SIGNAL_SYSTEM }],
    messages: [{ role: "user", content: [{ text: userText }] }],
    inferenceConfig: { maxTokens: 120, temperature: 0 },
  });
  const res = await client.send(cmd);
  const raw = res.output?.message?.content?.[0]?.text;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("classifySignal: empty response from model");
  }
  return parseSignalJson(raw.trim());
}

function escapeYamlValue(s: string): string {
  // Wrap in single quotes; escape embedded single quotes by doubling.
  // Single-quoted scalars cannot contain newlines, so a `\n---\n` in a
  // subject can never produce a stray document boundary.
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Serialise a Gmail message into the markdown shape `indexDocument`
 * consumes: YAML frontmatter (parsed into `documents.frontmatter`
 * JSONB) + the email body (chunked + embedded + indexed).
 *
 * Exported for tests; the recipe path uses it inline.
 */
export function buildMessageMarkdown(
  message: ExtractedMessage,
  signal: { score: number; reason: string },
): string {
  const fm =
    `---\n` +
    `source: gmail\n` +
    `gmail_id: ${message.id}\n` +
    `gmail_thread_id: ${message.threadId}\n` +
    `from: ${escapeYamlValue(message.from)}\n` +
    `to: ${escapeYamlValue(message.to)}\n` +
    `subject: ${escapeYamlValue(message.subject || "(no subject)")}\n` +
    `date: ${escapeYamlValue(message.date)}\n` +
    `signal_score: ${signal.score.toFixed(2)}\n` +
    `signal_reason: ${escapeYamlValue(signal.reason)}\n` +
    `---\n\n`;

  const heading = message.subject || "(no subject)";
  const meta =
    `**From:** ${message.from}\n` +
    `**To:** ${message.to}\n` +
    `**Date:** ${message.date}\n\n`;
  return `${fm}# ${heading}\n\n${meta}${message.body.trim()}\n`;
}

/** Stable, non-filesystem source path for a Gmail message. The
 *  matching source row's `path_prefix='gmail:'` lets
 *  `resolveSourceForPath` attribute these documents to the `gmail`
 *  source. */
export function gmailSourcePath(messageId: string): string {
  return `gmail:${messageId}`;
}

const RECIPE_ID = "gmail";
const PROCESS_NAME = "gmail.poll";
const DEDUP_MAX_IDS = 200;
const DEFAULT_MAX = 50;
const DEFAULT_SINCE_HOURS = 24;
const DEFAULT_THRESHOLD = 0.1;

async function listWithRetry(args: {
  accessToken: string;
  query: string;
  maxResults: number;
  fetch?: typeof fetch;
  refreshOnce: () => Promise<string>;
}): Promise<string[]> {
  try {
    return await listMessageIds({
      accessToken: args.accessToken,
      query: args.query,
      maxResults: args.maxResults,
      ...(args.fetch ? { fetch: args.fetch } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/^listMessageIds: 401/.test(msg)) throw e;
    const fresh = await args.refreshOnce();
    return await listMessageIds({
      accessToken: fresh,
      query: args.query,
      maxResults: args.maxResults,
      ...(args.fetch ? { fetch: args.fetch } : {}),
    });
  }
}

export async function pollGmail(
  storage: Storage,
  opts: PollGmailOptions = {},
): Promise<PollGmailResult> {
  const now = opts.now ?? new Date();
  const result: PollGmailResult = {
    scanned: 0,
    processed: 0,
    ingested: 0,
    skippedDedup: 0,
    skippedLowSignal: 0,
    errors: [],
  };

  const throttleOpts: { now: Date; systemSensors?: { loadAvg1?: number; memoryRssMB?: number } } = { now };
  if (opts.systemSensors !== undefined) {
    throttleOpts.systemSensors = opts.systemSensors;
  }
  const t = preflight(PROCESS_NAME, throttleOpts);
  if (!t.proceed) {
    result.reason = `throttle:${t.reason}`;
    return result;
  }

  try {
    const secret = opts.secret ?? (await loadGmailSecret());
    const threshold =
      opts.signalThreshold ?? secret.signal_threshold ?? DEFAULT_THRESHOLD;
    const max = opts.maxMessages ?? DEFAULT_MAX;
    const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS;
    const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
    const indexFn = opts.indexFn ?? indexDocument;

    let { accessToken } = await refreshAccessToken(secret, {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      now,
    });
    const refreshOnce = async (): Promise<string> => {
      _resetTokenCacheForTesting();
      const r = await refreshAccessToken(secret, {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        now,
      });
      accessToken = r.accessToken;
      return r.accessToken;
    };

    const ids = await listWithRetry({
      accessToken,
      query: `newer_than:${Math.max(1, Math.round(sinceHours / 24))}d`,
      maxResults: max,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      refreshOnce,
    });
    result.scanned = ids.length;
    if (ids.length === 0) return result;

    const unseen = await filterUnseenIds(storage.engine(), RECIPE_ID, ids);
    result.skippedDedup = ids.length - unseen.length;
    if (unseen.length === 0) return result;

    const newlyProcessed: string[] = [];
    for (const id of unseen) {
      let raw: GmailMessage;
      try {
        raw = await getMessage({
          accessToken,
          id,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/^getMessage\([^)]+\): 401/.test(msg)) {
          accessToken = await refreshOnce();
          raw = await getMessage({
            accessToken,
            id,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          });
        } else {
          throw e;
        }
      }

      let extracted: ExtractedMessage;
      try {
        extracted = extractMessageContent(raw);
      } catch (e) {
        result.errors.push({ id, error: (e as Error).message });
        continue;
      }
      result.processed += 1;

      const signal = await classifySignal({
        ...(opts.bedrockClient ? { client: opts.bedrockClient } : {}),
        modelId,
        subject: extracted.subject,
        from: extracted.from,
        bodyExcerpt: extracted.body,
      });
      if (signal.score < threshold) {
        result.skippedLowSignal += 1;
        newlyProcessed.push(id);
        continue;
      }

      if (!opts.dryRun) {
        const text = buildMessageMarkdown(extracted, signal);
        const indexOpts: IndexFileOptions = {};
        if (opts.embeddingModel !== undefined) {
          indexOpts.embeddingModel = opts.embeddingModel;
        }
        try {
          await indexFn(
            storage,
            { sourcePath: gmailSourcePath(id), text, mtimeMs: now.getTime() },
            indexOpts,
          );
        } catch (e) {
          // Index failure (Bedrock embed transient, DB hiccup) — record
          // and continue. The message id stays out of newlyProcessed so
          // the next poll retries it.
          result.errors.push({ id, error: (e as Error).message });
          continue;
        }
      }
      result.ingested += 1;
      newlyProcessed.push(id);
    }

    if (!opts.dryRun && newlyProcessed.length > 0) {
      await appendDedupIds(
        storage.engine(),
        RECIPE_ID,
        newlyProcessed,
        DEDUP_MAX_IDS,
      );
    }
    return result;
  } finally {
    complete(PROCESS_NAME);
  }
}
