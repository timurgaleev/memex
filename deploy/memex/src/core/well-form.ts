/**
 * Sanitize values bound for a Postgres `::jsonb` cast.
 *
 * Two characters Postgres `jsonb` rejects regardless of how JSON.stringify
 * encodes them:
 *   - an UNPAIRED UTF-16 surrogate (a lone high/low half — e.g. left behind by
 *     slicing a string by raw UTF-16 index through a non-BMP char like an emoji,
 *     or by a truncated/mis-encoded source). ES2019 `JSON.stringify` escapes it
 *     to `\udXXX`, and Postgres rejects that lone-surrogate escape at the
 *     `::jsonb` cast — aborting the whole INSERT.
 *   - the NUL code point (U+0000), which `jsonb` also refuses.
 *
 * A single bad document (arbitrary ingested markdown frontmatter) would
 * otherwise wedge indexing. `wellFormForJsonb` replaces lone surrogates with
 * U+FFFD (the Unicode replacement char, via `String.prototype.toWellFormed`)
 * and drops NUL, leaving all valid text untouched. `wellFormJsonbValue`
 * deep-applies it to every string key/value of an object before serialization.
 *
 * Mirrors the reference's "well-form lone UTF-16 surrogates before jsonb" fix,
 * generalized to a reusable sanitizer + the NUL case.
 */

const REPLACEMENT = "�";
// U+0000, constructed (not a literal control char in source) so the file stays
// clean ASCII and the intent is unambiguous.
const NUL = String.fromCharCode(0);
// Lone high surrogate (not followed by a low) OR lone low surrogate (not
// preceded by a high). Fallback for runtimes without String.toWellFormed.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Sanitize a single string for a jsonb cast. */
export function wellFormForJsonb(s: string): string {
  const hasToWellFormed =
    typeof (s as unknown as { toWellFormed?: () => string }).toWellFormed ===
    "function";
  const wf = hasToWellFormed
    ? s.toWellFormed()
    : s.replace(LONE_SURROGATE, REPLACEMENT);
  // Postgres jsonb also rejects U+0000; drop it.
  return wf.includes(NUL) ? wf.split(NUL).join("") : wf;
}

/**
 * Deep-sanitize every string (object key or value) inside a JSON-serializable
 * value so the result is safe to `JSON.stringify` and cast to `jsonb`. Returns
 * a new value; never mutates the input.
 */
export function wellFormJsonbValue(v: unknown): unknown {
  if (typeof v === "string") return wellFormForJsonb(v);
  if (Array.isArray(v)) return v.map(wellFormJsonbValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[wellFormForJsonb(k)] = wellFormJsonbValue(val);
    }
    return out;
  }
  return v; // number | boolean | null | undefined | bigint | symbol → unchanged
}

/**
 * Coerce a frontmatter / doc-metadata value to a sanitized jsonb OBJECT.
 *
 * `documents.frontmatter` is metadata and must always be a JSON object. An
 * ingest path that hands over a string (a recipe passing raw content, a
 * mis-typed `extraFrontmatter`) or any other scalar/array would otherwise
 * serialize through the `::jsonb` cast as a SCALAR — e.g. a whole 12 MB file
 * body stored as `"...."` — bloating the row and yielding NULL for every
 * `frontmatter->'key'` read (the 2026-06 420 MB-frontmatter incident). Any
 * non-plain-object collapses to `{}`; a real object is deep-sanitized as usual.
 */
export function wellFormJsonbObject(v: unknown): Record<string, unknown> {
  const isPlainObject =
    v !== null && typeof v === "object" && !Array.isArray(v);
  return wellFormJsonbValue(isPlainObject ? v : {}) as Record<string, unknown>;
}
