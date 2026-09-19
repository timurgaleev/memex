/**
 * Credentials pasted into the brain — an env dump, a config file, a transcript
 * that echoed a token — would otherwise be stored, chunked, embedded and served
 * to every grant that reads the source. This finds them by the prefixes their
 * issuers publish (plus memex's own token shapes and PEM private-key blocks)
 * before anything is written.
 *
 * Only named prefixes: a generic "high entropy" rule would also catch hashes,
 * UUIDs and ids, which the brain is full of. What is found is reported by kind
 * and a SHA-256 fingerprint — never by value — so an audit row can say what was
 * caught without re-storing it.
 *
 * Every pattern starts with a literal prefix and bounds its tail, so a scan is
 * linear in the text (tests/secret_scan.test.ts measures it).
 */
import { createHash } from "node:crypto";
import { OperationError } from "./operation-error.ts";
import type { Engine } from "./engine/interface.ts";
import { logIngest } from "./ingest-log.ts";

export interface SecretFinding {
  kind: string;
  /** First 12 hex of the SHA-256 of the secret. */
  fingerprint: string;
}

export interface SecretScanResult {
  text: string;
  findings: SecretFinding[];
}

const PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  // AKIA/ASIA only: AIDA, AROA and the rest are IAM unique ids, not secrets.
  { kind: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "aws-secret-key", regex: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s{0,8}[:=]\s{0,8}["']?[A-Za-z0-9/+]{40}/g },
  { kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "github-token", regex: /\bgithub_pat_\w{22,255}\b/g },
  { kind: "slack-token", regex: /\bxox[abeprs]-[A-Za-z0-9-]{10,200}/g },
  { kind: "slack-token", regex: /\bxapp-[A-Za-z0-9-]{10,200}/g },
  { kind: "gitlab-token", regex: /\bglpat-[\w-]{20,100}/g },
  { kind: "stripe-key", regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,200}/g },
  { kind: "openai-key", regex: /\bsk-(?:proj|svcacct|admin)-[\w-]{20,300}/g },
  { kind: "slack-webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,200}/g },
  { kind: "anthropic-key", regex: /\bsk-ant-[\w-]{20,300}/g },
  // memex's own: OAuth access/refresh tokens, enrollment codes, and PATs.
  // Client ids (`memex_cl_`) and enrollment ids (`memex_enr_`) are not secrets.
  { kind: "memex-token", regex: /\bmemex_(?:at|rt|en)_[\w-]{16,200}/g },
  { kind: "memex-pat", regex: /\bmemex_[0-9a-f]{64}\b/g },
];

const PEM_OPEN = "-----BEGIN ";
/** A key block is never larger; past this, an unclosed header is not a key. */
const PEM_MAX = 16_384;
/** Base64 body lines and `Name: value` armor headers of a key block. */
const PEM_BODY_LINE = /^(?:[a-z0-9+/=]{0,100}|[\w-]{1,40}: .{0,200})$/i;

export function fingerprintSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** Replace every PEM private-key block, header to footer, with `mark(block)`. */
function replacePemBlocks(text: string, mark: (block: string) => string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf(PEM_OPEN, from);
    if (open === -1) return out + text.slice(from);
    const headerEnd = text.indexOf("-----", open + PEM_OPEN.length);
    // RSA/EC/OPENSSH `PRIVATE KEY` and PGP `PRIVATE KEY BLOCK` headers.
    const header = headerEnd === -1 || headerEnd - open > 80 ? "" : text.slice(open, headerEnd);
    if (!header.includes("PRIVATE KEY")) {
      out += text.slice(from, open + PEM_OPEN.length);
      from = open + PEM_OPEN.length;
      continue;
    }
    const bodyStart = headerEnd + 5;
    const footer = text.indexOf("-----END ", bodyStart);
    const footerEnd = footer === -1 || footer - open > PEM_MAX ? -1 : text.indexOf("-----", footer + 9);
    const end = footerEnd !== -1 ? footerEnd + 5 : unterminatedBlockEnd(text, bodyStart);
    out += text.slice(from, open) + mark(text.slice(open, end));
    from = end;
  }
}

/**
 * Where an unclosed key block ends: after the base64 lines that follow its
 * header, never past PEM_MAX. A truncated key is still a key, but a note that
 * merely quotes the header line must not lose everything after it.
 */
function unterminatedBlockEnd(text: string, bodyStart: number): number {
  const limit = Math.min(text.length, bodyStart + PEM_MAX);
  // `pos` is where the current line starts, on its leading newline if any.
  let pos = bodyStart;
  while (pos < limit) {
    const start = text[pos] === "\n" ? pos + 1 : pos;
    const nl = text.indexOf("\n", start);
    const lineEnd = nl === -1 || nl > limit ? limit : nl;
    if (!PEM_BODY_LINE.test(text.slice(start, lineEnd).replace(/\r$/, ""))) return pos;
    pos = lineEnd;
  }
  return pos;
}

/** Find credentials in `text` and replace each with a marker naming its kind
 *  and fingerprint. `allow` holds fingerprints to leave in place. */
export function scanSecrets(text: string, allow: ReadonlySet<string> = new Set()): SecretScanResult {
  const findings: SecretFinding[] = [];
  const mark = (kind: string) => (value: string) => {
    const fingerprint = fingerprintSecret(value);
    if (allow.has(fingerprint)) return value;
    findings.push({ kind, fingerprint });
    return `[REDACTED:${kind}:${fingerprint}]`;
  };
  let out = text.includes(PEM_OPEN) ? replacePemBlocks(text, mark("private-key")) : text;
  for (const p of PATTERNS) out = out.replace(p.regex, mark(p.kind));
  return { text: out, findings };
}

export type SecretDisposition = "redact" | "flag" | "reject";

export function secretDisposition(): SecretDisposition {
  const v = (process.env.MEMEX_SECRET_SCAN_DISPOSITION ?? "").trim().toLowerCase();
  return v === "flag" || v === "reject" ? v : "redact";
}

function allowedFingerprints(): Set<string> {
  return new Set(
    (process.env.MEMEX_SECRET_SCAN_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{12}$/.test(s)),
  );
}

/**
 * Apply the configured disposition to text about to be stored:
 *   redact (default) — store the marked text;
 *   flag             — store it unchanged, but still report what was found;
 *   reject           — refuse the write.
 */
export function guardSecrets(text: string, where: string): SecretScanResult {
  const scanned = scanSecrets(text, allowedFingerprints());
  if (scanned.findings.length === 0) return { text, findings: [] };
  const disposition = secretDisposition();
  if (disposition === "reject") throw new SecretRejectedError(where, scanned.findings);
  return disposition === "flag" ? { text, findings: scanned.findings } : scanned;
}

/** A write refused under the reject disposition; carries what was found so the
 *  refusal can be audited like a redaction. */
export class SecretRejectedError extends OperationError {
  constructor(
    where: string,
    public readonly findings: SecretFinding[],
  ) {
    super(
      "invalid_params",
      `${where} contains what looks like a credential (${describeFindings(findings)}); the write was refused`,
      "Remove the credential, or allow its fingerprint in MEMEX_SECRET_SCAN_ALLOW if it is not one.",
    );
  }
}

/** Every string in a JSON value through `guardSecrets`, keys included. */
export function guardSecretsDeep(value: unknown, where: string, findings: SecretFinding[]): unknown {
  if (typeof value === "string") {
    const r = guardSecrets(value, where);
    findings.push(...r.findings);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => guardSecretsDeep(v, where, findings));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[guardSecretsDeep(k, where, findings) as string] = guardSecretsDeep(v, where, findings);
    }
    return out;
  }
  return value;
}

/**
 * Run a write's scans. A refusal is audited before it propagates, so a
 * rejected credential leaves the same trail a redacted one does.
 */
export async function guardWrite<T>(
  engine: Engine,
  ref: string,
  sourceId: string | null,
  scan: () => T,
): Promise<T> {
  try {
    return scan();
  } catch (e) {
    if (e instanceof SecretRejectedError) await auditRejection(engine, e, ref, sourceId);
    throw e;
  }
}

/**
 * Guard a write's free-text fields and audit what they carried. Each string
 * field comes back redacted (or unchanged under `flag`); a non-string passes
 * through for the caller's own validation.
 */
export async function guardFields<T extends Record<string, unknown>>(
  engine: Engine,
  ref: string,
  sourceId: string | null,
  where: string,
  fields: T,
): Promise<T> {
  const findings: SecretFinding[] = [];
  const out = await guardWrite(engine, ref, sourceId, () => {
    const guarded: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== "string") {
        guarded[k] = v;
        continue;
      }
      const r = guardSecrets(v, where);
      findings.push(...r.findings);
      guarded[k] = r.text;
    }
    return guarded as T;
  });
  await auditSecrets(engine, findings, ref, sourceId);
  return out;
}

export async function auditRejection(
  engine: Engine,
  e: SecretRejectedError,
  ref: string,
  sourceId: string | null,
): Promise<void> {
  await logIngest(engine, {
    source_type: "secret-rejected",
    source_ref: ref,
    summary: describeFindings(e.findings),
    ...(sourceId ? { source_id: sourceId } : {}),
  });
}

/** Record what a write carried, by kind and fingerprint — never the value. */
export async function auditSecrets(
  engine: Engine,
  findings: SecretFinding[],
  ref: string,
  sourceId: string | null,
): Promise<void> {
  if (findings.length === 0) return;
  await logIngest(engine, {
    source_type: secretDisposition() === "flag" ? "secret-flagged" : "secret-redacted",
    source_ref: ref,
    summary: describeFindings(findings),
    ...(sourceId ? { source_id: sourceId } : {}),
  });
}

/** `aws-access-key:1a2b3c4d5e6f, private-key:…` — for audit rows and errors. */
export function describeFindings(findings: SecretFinding[]): string {
  return findings.map((f) => `${f.kind}:${f.fingerprint}`).join(", ");
}
