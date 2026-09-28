/**
 * `memex transcripts ingest <path> [--format auto|chatgpt|claude-ai|codex|claude-code]
 *                           [--source ID] [--dry-run] [--json]`
 *
 * Imports a ChatGPT or Claude.ai data export, a Codex CLI rollout
 * (`~/.codex/sessions/**\/rollout-*.jsonl`) or a Claude Code session log
 * (`~/.claude/projects/<project>/<session>.jsonl`) straight into the brain as
 * split, redacted `conversation` pages (see src/core/transcripts/). `<path>`
 * may be a directory of session logs: every `.jsonl` under it (for `codex`,
 * every `rollout-*.jsonl`) is read as one session. `--dry-run` parses, redacts
 * and splits without opening the brain, so the cost of a backfill (sessions,
 * parts, bytes to embed) is visible before it is paid.
 *
 * Exits non-zero when the file is refused (binary, over the size cap, not
 * JSON), when the export shape was not recognised (format drift), or when a
 * session was refused for carrying a credential under the reject disposition.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { looksBinary } from "../core/binary-guard.ts";
import { loadConfig } from "../core/config.ts";
import type { EmbedFn } from "../core/indexer.ts";
import { SecretRejectedError } from "../core/secret-scan.ts";
import { Storage } from "../core/storage.ts";
import {
  checkTranscriptFileSize,
  parseTranscriptExport,
  parseTranscriptJsonl,
  type ParsedExport,
} from "../core/transcripts/detect.ts";
import {
  ingestSessions,
  prepareSession,
  type IngestTranscriptsResult,
} from "../core/transcripts/ingest.ts";
import {
  isTranscriptFormat,
  JSONL_TRANSCRIPT_FORMATS,
  TRANSCRIPT_FORMATS,
  type TranscriptDiagnostics,
  type TranscriptFormat,
  type TranscriptSession,
} from "../core/transcripts/types.ts";
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

/** Read and parse one file; a string is the refusal message. */
function readTranscriptFile(path: string, override: TranscriptFormat | undefined): ParsedExport | string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    return `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const tooBig = checkTranscriptFileSize(size);
  if (tooBig) return `${path}: ${tooBig}`;
  const raw = readFileSync(path);
  if (looksBinary(raw)) return `${path} is a binary file, not a transcript; nothing was imported`;
  const text = raw.toString("utf-8");
  if (path.endsWith(".jsonl") || (override !== undefined && JSONL_TRANSCRIPT_FORMATS.has(override))) {
    return parseTranscriptJsonl(text, raw.length, override);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  return parseTranscriptExport(data, raw.length, override);
}

/** Session logs under a directory, in a stable order; symlinks are not followed. */
function sessionLogFiles(dir: string, override: TranscriptFormat | undefined): string[] {
  const match = override === "codex" ? (n: string) => n.startsWith("rollout-") && n.endsWith(".jsonl") : (n: string) => n.endsWith(".jsonl");
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && match(ent.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Every session log under `dir`, as one run. A log that yields no session
 * (a sub-agent-only or empty log) is listed as skipped; the run is drift only
 * when logs had content and not one session came out of any of them.
 */
function readTranscriptDir(dir: string, override: TranscriptFormat | undefined): ParsedExport | string {
  let files: string[];
  try {
    files = sessionLogFiles(dir, override);
  } catch (e) {
    return `cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const sessions: TranscriptSession[] = [];
  const formats = new Set<TranscriptFormat>();
  let malformed = 0;
  const diag: TranscriptDiagnostics = {
    format: override ?? null,
    detected_by: override ? "override" : "none",
    bytes: 0,
    items: 0,
    sessions: 0,
    skipped: [],
    skippedMessages: 0,
    format_drift: false,
    files: files.length,
  };
  for (const [index, path] of files.entries()) {
    const id = relative(dir, path);
    const r = readTranscriptFile(path, override);
    if (typeof r === "string") return r;
    const d = r.diagnostics;
    diag.bytes += d.bytes;
    diag.items += d.items;
    diag.skippedMessages += d.skippedMessages;
    malformed += d.malformed_lines ?? 0;
    if (d.format) formats.add(d.format);
    if (r.sessions.length === 0) {
      const reason = d.skipped[0]?.reason ?? (d.format === null ? "no known session log format" : "no sessions");
      diag.skipped.push({ index, id, reason });
    }
    sessions.push(...r.sessions);
  }
  if (!override && formats.size > 0) {
    diag.detected_by = "detection";
    diag.format = formats.size === 1 ? [...formats][0]! : null;
  }
  diag.sessions = sessions.length;
  diag.malformed_lines = malformed;
  diag.format_drift = sessions.length === 0 && diag.bytes > 0;
  return { sessions, diagnostics: diag };
}

export async function runTranscripts(opts: TranscriptsCmdOptions): Promise<number> {
  if (opts.sub !== "ingest") {
    console.error("memex transcripts: subcommand required (ingest <path>)");
    return 1;
  }
  if (!opts.file) return fail("ingest: <path> is required", opts.json);
  const formatArg = (opts.format ?? "auto").trim().toLowerCase();
  if (formatArg !== "auto" && !isTranscriptFormat(formatArg)) {
    return fail(`--format must be auto, ${TRANSCRIPT_FORMATS.join(", ")} (got ${JSON.stringify(opts.format)})`, opts.json);
  }
  const override: TranscriptFormat | undefined = formatArg === "auto" ? undefined : formatArg;

  let isDir: boolean;
  try {
    isDir = statSync(opts.file).isDirectory();
  } catch (e) {
    return fail(`cannot read ${opts.file}: ${e instanceof Error ? e.message : String(e)}`, opts.json);
  }
  const loaded = isDir ? readTranscriptDir(opts.file, override) : readTranscriptFile(opts.file, override);
  if (typeof loaded === "string") return fail(loaded, opts.json);
  const { sessions, diagnostics } = loaded;
  const file = basename(opts.file);
  const formatLabel = diagnostics.format ?? (sessions.length > 0 ? "mixed" : "empty");

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
        `${file} (${formatLabel}): ${p.sessions} sessions → ${p.parts} parts, ` +
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
      `${file} (${formatLabel}): ${result.sessions} sessions, ` +
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
