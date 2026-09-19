/**
 * `memex transcripts ingest <export.json> [--format auto|chatgpt|claude-ai]
 *                           [--source ID] [--dry-run] [--json]`
 *
 * Imports a ChatGPT or Claude.ai data export straight into the brain as split,
 * redacted `conversation` pages (see src/core/transcripts/). `--dry-run`
 * parses, redacts and splits without opening the brain, so the cost of a
 * backfill (sessions, parts, bytes to embed) is visible before it is paid.
 *
 * Exits non-zero when the file is refused (binary, over the size cap, not
 * JSON), when the export shape was not recognised (format drift), or when a
 * session was refused for carrying a credential under the reject disposition.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { looksBinary } from "../core/binary-guard.ts";
import { loadConfig } from "../core/config.ts";
import type { EmbedFn } from "../core/indexer.ts";
import { SecretRejectedError } from "../core/secret-scan.ts";
import { Storage } from "../core/storage.ts";
import { checkTranscriptFileSize, parseTranscriptExport } from "../core/transcripts/detect.ts";
import {
  ingestSessions,
  prepareSession,
  type IngestTranscriptsResult,
} from "../core/transcripts/ingest.ts";
import { isTranscriptFormat, type TranscriptFormat } from "../core/transcripts/types.ts";
import { withStorage } from "./with-storage.ts";

export interface TranscriptsCmdOptions {
  sub: string | undefined;
  file?: string;
  /** `auto` (default) or a format name. */
  format?: string;
  sourceId?: string;
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
  /** Test seam — deterministic embedder for the search mirror (no Bedrock). */
  embedFn?: EmbedFn;
}

interface DryRunPreview {
  sessions: number;
  sessions_rejected: number;
  parts: number;
  bytes: number;
  redactions: number;
}

function preview(sessions: Parameters<typeof prepareSession>[0][]): DryRunPreview {
  const out: DryRunPreview = { sessions: sessions.length, sessions_rejected: 0, parts: 0, bytes: 0, redactions: 0 };
  for (const s of sessions) {
    try {
      const p = prepareSession(s);
      out.parts += p.parts.length;
      out.bytes += p.parts.reduce((n, part) => n + part.bytes, 0);
      out.redactions += p.findings.length;
    } catch (e) {
      if (!(e instanceof SecretRejectedError)) throw e;
      out.sessions_rejected++;
    }
  }
  return out;
}

function fail(msg: string, json: boolean | undefined): number {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`memex transcripts: ${msg}`);
  return 1;
}

export async function runTranscripts(opts: TranscriptsCmdOptions): Promise<number> {
  if (opts.sub !== "ingest") {
    console.error("memex transcripts: subcommand required (ingest <export.json>)");
    return 1;
  }
  if (!opts.file) return fail("ingest: <export.json> is required", opts.json);
  const formatArg = (opts.format ?? "auto").trim().toLowerCase();
  if (formatArg !== "auto" && !isTranscriptFormat(formatArg)) {
    return fail(`--format must be auto, chatgpt or claude-ai (got ${JSON.stringify(opts.format)})`, opts.json);
  }
  const override: TranscriptFormat | undefined = formatArg === "auto" ? undefined : formatArg;

  let size: number;
  try {
    size = statSync(opts.file).size;
  } catch (e) {
    return fail(`cannot read ${opts.file}: ${e instanceof Error ? e.message : String(e)}`, opts.json);
  }
  const tooBig = checkTranscriptFileSize(size);
  if (tooBig) return fail(tooBig, opts.json);
  const raw = readFileSync(opts.file);
  if (looksBinary(raw)) return fail(`${opts.file} is a binary file, not a JSON export; nothing was imported`, opts.json);
  let data: unknown;
  try {
    data = JSON.parse(raw.toString("utf-8"));
  } catch (e) {
    return fail(`${opts.file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, opts.json);
  }

  const { sessions, diagnostics } = parseTranscriptExport(data, raw.length, override);
  const file = basename(opts.file);

  if (diagnostics.format_drift) {
    const msg =
      diagnostics.format === null
        ? `${file}: no known export format recognised (${diagnostics.items} items); nothing was imported`
        : `${file}: read as ${diagnostics.format} but produced zero sessions from ${diagnostics.items} items; the export format may have changed`;
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg, diagnostics }, null, 2));
    else console.error(`memex transcripts: ${msg}`);
    return 1;
  }

  if (opts.dryRun) {
    const p = preview(sessions);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, dry_run: true, file, diagnostics, preview: p }, null, 2));
    } else {
      console.log(
        `${file} (${diagnostics.format ?? "empty"}): ${p.sessions} sessions → ${p.parts} parts, ` +
          `${p.bytes} bytes to embed, ${p.redactions} credentials to redact` +
          (p.sessions_rejected > 0 ? `, ${p.sessions_rejected} sessions would be refused` : "") +
          ` — dry-run, nothing written`,
      );
      printSkipped(diagnostics.skipped, diagnostics.skippedMessages);
    }
    return p.sessions_rejected > 0 ? 1 : 0;
  }

  const storage = new Storage(loadConfig(opts.configPath));
  const result: IngestTranscriptsResult = await withStorage(storage, () =>
    ingestSessions(storage, sessions, {
      ref: `${diagnostics.format ?? "unknown"}:${file}`,
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
    }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: result.sessions_rejected + result.sessions_failed === 0, dry_run: false, file, diagnostics, result }, null, 2));
  } else {
    console.log(
      `${file} (${diagnostics.format ?? "empty"}): ${result.sessions} sessions, ` +
        `${result.parts_written} parts written, ${result.parts_unchanged} unchanged, ` +
        `${result.parts_deleted} stale deleted, ${result.redactions} credentials redacted` +
        (result.mirror_failures > 0 ? `, ${result.mirror_failures} not yet searchable` : ""),
    );
    for (const r of result.rejected) console.log(`  refused ${r.id}: ${r.reason}`);
    for (const f of result.failed) console.log(`  failed ${f.id} (${f.code}): ${f.reason}`);
    printSkipped(diagnostics.skipped, diagnostics.skippedMessages);
  }
  return result.sessions_rejected + result.sessions_failed > 0 ? 1 : 0;
}

function printSkipped(skipped: ReadonlyArray<{ index: number; id?: string; reason: string }>, messages: number): void {
  for (const s of skipped) console.log(`  skipped [${s.index}]${s.id ? ` ${s.id}` : ""}: ${s.reason}`);
  if (messages > 0) console.log(`  ${messages} system, tool, hidden or empty messages left out`);
}
