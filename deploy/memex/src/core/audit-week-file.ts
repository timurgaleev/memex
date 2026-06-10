/**
 * audit-week-file.ts — an ISO-week-rotated, best-effort JSONL append writer.
 *
 * Opt-in: nothing is written unless `MEMEX_AUDIT_DIR` is set. Each record is
 * one JSON line appended to `<dir>/audit-<ISO-week>.jsonl`, so the trail
 * rotates weekly and stays greppable. The writer is BEST-EFFORT: any failure
 * (unwritable dir, full disk) is swallowed — an audit trail must never break
 * the request it is recording.
 *
 * The caller is responsible for passing an already-redacted record (see
 * `mcp/param-redaction.ts` `summarizeMcpParams`): this module does no
 * redaction of its own.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The configured audit directory, or null when auditing is off. */
export function auditDir(): string | null {
  const d = process.env["MEMEX_AUDIT_DIR"];
  return d && d.length > 0 ? d : null;
}

/**
 * ISO-8601 week key for a date, `YYYY-Www` (weeks start Monday; week 1 is the
 * week containing the first Thursday of the year). Pure — the caller passes
 * the clock so it is deterministic in tests.
 */
export function isoWeekKey(d: Date): string {
  // Work in UTC on a date-only copy.
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  // Shift to the Thursday of this week (ISO weeks belong to their Thursday's year).
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  // Thursday of ISO week 1 is the one in the week of Jan 4th.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 +
    Math.round(
      (date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000),
    );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Absolute path of the audit file for a given week. */
export function auditFilePath(dir: string, now: Date): string {
  return join(dir, `audit-${isoWeekKey(now)}.jsonl`);
}

/**
 * Append one record as a JSON line to the current week's audit file. Creates
 * the directory if needed. Best-effort: returns true on success, false (never
 * throws) on any failure.
 */
export function appendAudit(
  dir: string,
  record: Record<string, unknown>,
  now: Date = new Date(),
): boolean {
  try {
    // Operator-private by default: the trail holds tool names / ingress /
    // timestamps (no values), but there is no reason to make it world-readable.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(auditFilePath(dir, now), JSON.stringify(record) + "\n", {
      mode: 0o600,
    });
    return true;
  } catch {
    return false; // an audit trail must never break the caller
  }
}
