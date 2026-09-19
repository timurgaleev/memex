/**
 * Write transcript sessions into the brain as `conversation` pages.
 *
 * Per session: every message and the title are scanned for credentials
 * before anything is rendered, so under the `reject` disposition a session
 * is refused whole rather than landing with some parts written. Parts go
 * through `putPage`, whose content-hash no-op makes a re-run of an unchanged
 * export write nothing; only parts that changed are mirrored into search.
 * Parts past the session's new end (it shrank) are soft-deleted and dropped
 * from search, within the same source only.
 */
import type { Storage } from "../storage.ts";
import type { EmbedFn } from "../indexer.ts";
import { deletePage, putPage } from "../pages.ts";
import { mirrorPage, removePageFromSearch } from "../page-index.ts";
import { logIngest } from "../ingest-log.ts";
import { OperationError } from "../operation-error.ts";
import {
  auditSecrets,
  guardSecrets,
  guardWrite,
  SecretRejectedError,
  type SecretFinding,
} from "../secret-scan.ts";
import { renderSession, sessionBaseSlug, type RenderedPart } from "./render.ts";
import type { TranscriptSession } from "./types.ts";

export const TRANSCRIPT_PAGE_TYPE = "conversation";
const WRITTEN_BY = "transcripts-ingest";
/** Slugs listed on the summary ingest_log row; the counts carry the rest. */
const LOG_SLUG_CAP = 500;

export interface PreparedSession {
  session: TranscriptSession;
  base: string;
  parts: RenderedPart[];
  findings: SecretFinding[];
}

/**
 * Redact (or, under `reject`, refuse) credentials across the whole session,
 * then render it. Pure: throws SecretRejectedError before any part exists.
 */
export function prepareSession(session: TranscriptSession): PreparedSession {
  const base = sessionBaseSlug(session);
  const where = `transcript '${base}'`;
  const findings: SecretFinding[] = [];
  const guard = (text: string): string => {
    const r = guardSecrets(text, where);
    findings.push(...r.findings);
    return r.text;
  };
  const clean: TranscriptSession = {
    ...session,
    title: session.title === null ? null : guard(session.title),
    messages: session.messages.map((m) => ({ ...m, text: guard(m.text) })),
  };
  return { session: clean, base, parts: renderSession(clean), findings };
}

export interface IngestTranscriptsOptions {
  /** Owning source for every part. Defaults to `default`. */
  sourceId?: string;
  /** Where the sessions came from, for the summary ingest_log row. */
  ref?: string;
  /** Test seam: deterministic embedder for the search mirror. */
  embedFn?: EmbedFn;
}

export interface IngestTranscriptsResult {
  sessions: number;
  sessions_rejected: number;
  parts_written: number;
  parts_unchanged: number;
  parts_deleted: number;
  /** Credentials found (redacted, or left in place under `flag`). */
  redactions: number;
  /** Parts whose search mirror failed; each also has a page-mirror-failed row. */
  mirror_failures: number;
  rejected: Array<{ id: string; reason: string }>;
}

async function staleParts(storage: Storage, base: string, sourceId: string, keep: number): Promise<string[]> {
  const prefix = `${base}-p`;
  const r = await storage.engine().query<{ slug: string }>(
    `SELECT slug FROM pages
      WHERE slug LIKE $1 AND source_id = $2 AND deleted_at IS NULL`,
    [`${prefix}%`, sourceId],
  );
  return r.rows
    .map((row) => row.slug)
    .filter((slug) => {
      const tail = slug.slice(prefix.length);
      return /^\d{1,6}$/.test(tail) && Number(tail) > keep;
    })
    .sort();
}

export async function ingestSessions(
  storage: Storage,
  sessions: readonly TranscriptSession[],
  opts: IngestTranscriptsOptions = {},
): Promise<IngestTranscriptsResult> {
  const sourceId = opts.sourceId ?? "default";
  const engine = storage.engine();
  // Checked up front: otherwise an unregistered source fails on the first
  // page insert, after the whole export was parsed and scanned.
  const known = await engine.query(`SELECT 1 FROM sources WHERE id = $1`, [sourceId]);
  if (known.rows.length === 0) {
    throw new OperationError(
      "invalid_params",
      `unknown source '${sourceId}'`,
      "Register it with `memex sources register`, or omit --source.",
    );
  }
  const result: IngestTranscriptsResult = {
    sessions: sessions.length,
    sessions_rejected: 0,
    parts_written: 0,
    parts_unchanged: 0,
    parts_deleted: 0,
    redactions: 0,
    mirror_failures: 0,
    rejected: [],
  };
  const touched: string[] = [];

  for (const session of sessions) {
    let prepared: PreparedSession;
    try {
      prepared = await guardWrite(engine, sessionBaseSlug(session), sourceId, () => prepareSession(session));
    } catch (e) {
      if (!(e instanceof SecretRejectedError)) throw e;
      result.sessions_rejected++;
      result.rejected.push({ id: session.id, reason: e.message });
      continue;
    }
    result.redactions += prepared.findings.length;

    let sessionChanged = false;
    for (const part of prepared.parts) {
      const put = await putPage(storage, {
        slug: part.slug,
        type: TRANSCRIPT_PAGE_TYPE,
        allowAdHocType: true,
        title: part.title,
        markdown_body: part.body,
        compiled_truth: part.truth,
        written_by: WRITTEN_BY,
        source_id: sourceId,
      });
      if (!put.changed && !put.created) {
        result.parts_unchanged++;
        continue;
      }
      sessionChanged = true;
      result.parts_written++;
      touched.push(part.slug);
      const ok = await mirrorPage(
        storage,
        {
          slug: part.slug,
          title: part.title,
          markdown_body: part.body,
          content_hash: put.content_hash,
          source_id: sourceId,
        },
        { remote: false, timingLabel: "transcripts_ingest", ...(opts.embedFn ? { embedFn: opts.embedFn } : {}) },
      );
      if (!ok) result.mirror_failures++;
    }

    for (const slug of await staleParts(storage, prepared.base, sourceId, prepared.parts.length)) {
      const del = await deletePage(storage, slug, WRITTEN_BY, sourceId);
      if (del.already_deleted) continue;
      await removePageFromSearch(storage, slug, sourceId);
      sessionChanged = true;
      result.parts_deleted++;
      touched.push(slug);
    }

    // Audited only when the session was written: an unchanged re-run leaves
    // no new rows at all.
    if (sessionChanged) await auditSecrets(engine, prepared.findings, prepared.base, sourceId);
  }

  if (touched.length > 0) {
    await logIngest(engine, {
      source_type: "transcripts",
      source_ref: opts.ref ?? null,
      pages_updated: touched.slice(0, LOG_SLUG_CAP),
      summary:
        `sessions ${result.sessions}, parts written ${result.parts_written}, ` +
        `unchanged ${result.parts_unchanged}, deleted ${result.parts_deleted}, ` +
        `rejected ${result.sessions_rejected}, redactions ${result.redactions}`,
      source_id: sourceId,
    });
  }
  return result;
}
