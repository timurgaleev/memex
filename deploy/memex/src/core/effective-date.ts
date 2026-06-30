/**
 * Deterministic content-date extraction for `documents.effective_date`.
 *
 * Tries, in order: frontmatter `date` / `event_date` / `published` (string or
 * number), then a `YYYY-MM-DD` prefix in the filename. Returns an ISO string
 * (UTC) or null when nothing parses. Pure, LLM-free, defensive — any malformed
 * value yields null, never a throw, so a bad frontmatter date can't break
 * ingest. The retrieval path falls back to `updated_at` via COALESCE when this
 * is null, so a null result is fully back-compatible.
 */

const FM_DATE_KEYS = ["date", "event_date", "published"] as const;
const FILENAME_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

/** Coerce an arbitrary frontmatter value to an ISO date string, or null. */
function toIso(value: unknown): string | null {
  if (value == null) return null;
  // Number → epoch seconds or ms. Threshold 1e11: epoch SECONDS for any real
  // year are ~1e9 (year 2000 ≈ 9.5e8), epoch MS are ~1e12 (year 2000 ≈ 9.5e11),
  // so 1e11 cleanly separates them and a pre-2001 ms value (≈8.8e11 for 1998)
  // is still correctly read as ms rather than multiplied into the far future.
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Resolve an effective (content) date from a document's frontmatter and path.
 * @returns ISO-8601 UTC string, or null when no date can be parsed.
 */
export function resolveEffectiveDate(
  frontmatter: Record<string, unknown> | null | undefined,
  sourcePath?: string | null,
): string | null {
  if (frontmatter) {
    for (const key of FM_DATE_KEYS) {
      const iso = toIso(frontmatter[key]);
      if (iso) return iso;
    }
  }
  if (typeof sourcePath === "string") {
    const m = sourcePath.match(FILENAME_DATE_RE);
    if (m) {
      const iso = toIso(`${m[1]}-${m[2]}-${m[3]}`);
      if (iso) return iso;
    }
  }
  return null;
}
