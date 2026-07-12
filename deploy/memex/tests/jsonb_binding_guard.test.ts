/**
 * Guard: no JSON.stringify bound into a bare `$N::jsonb` position.
 *
 * Under postgres.js `unsafe(sql, params)` (the PostgresEngine path) a JS
 * STRING bound to a `$N::jsonb` param double-encodes — the text→jsonb cast
 * wraps the already-JSON string into a jsonb *string scalar*. PGLite parses
 * it silently, so the bug is invisible in unit tests and only bites on real
 * Postgres (it broke access_tokens.permissions live; fixed v1.80.1).
 *
 * Safe forms (NOT flagged):
 *   - `$N::text::jsonb` + JSON.stringify (binds as text; the cast parses it)
 *   - a raw JS object/array bound to `$N::jsonb` (driver-serialized jsonb)
 *   - SQL literals like `'{}'::jsonb` (no param)
 *   - a `jsonb-guard-ok` comment anywhere in the call span (explicit opt-out)
 *
 * Heuristic (precision over recall, a balanced-span scanner):
 * flag a query/exec/unsafe call whose balanced argument span contains a bare
 * positional `$N::jsonb` cast AND either a direct `JSON.stringify(` in the
 * span or an identifier the same file assigns from `JSON.stringify(...)`
 * (the pre-fix pages.ts `truthJson` shape). Whole-span correlation only —
 * no param-position tracking — so object bindings never false-positive.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "../src");

// executeRawDirect before executeRaw so the longer name wins; `query` covers
// memex's engine.query / tx.query call sites. Optional `<...>` handles
// generic type args, e.g. `query<{ id: string }>(`.
const CALL_RE = /\b(executeRawDirect|executeRaw|unsafe|query|exec)\s*(?:<[^>;]*>)?\s*\(/g;

/** Walk from the '(' at openIdx and return [start,end) of the balanced span,
 *  respecting strings, template literals, and comments. */
function findSpan(src: string, openIdx: number): [number, number] {
  let depth = 0;
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "line") { if (c === "\n") mode = "code"; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = "code"; i++; } continue; }
    if (mode === "sq") { if (c === "\\") { i++; continue; } if (c === "'") mode = "code"; continue; }
    if (mode === "dq") { if (c === "\\") { i++; continue; } if (c === '"') mode = "code"; continue; }
    if (mode === "tpl") { if (c === "\\") { i++; continue; } if (c === "`") mode = "code"; continue; }
    if (c === "/" && n === "/") { mode = "line"; i++; continue; }
    if (c === "/" && n === "*") { mode = "block"; i++; continue; }
    if (c === "'") { mode = "sq"; continue; }
    if (c === '"') { mode = "dq"; continue; }
    if (c === "`") { mode = "tpl"; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return [openIdx + 1, i]; }
  }
  return [openIdx + 1, src.length];
}

/** Blank out comments so a commented-out example doesn't trip the probe. */
function stripComments(s: string): string {
  return s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Identifiers this file assigns from JSON.stringify(...) — catches the
 *  bind-a-variable shape (`const truthJson = JSON.stringify(...)`). */
function stringifyIdentifiers(src: string): string[] {
  const ids = new Set<string>();
  const re = /\b([A-Za-z_$][\w$]*)\s*=\s*JSON\.stringify\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) ids.add(m[1]!);
  return [...ids];
}

/** First bare `$N::jsonb` in the span that is NOT `$N::text::jsonb`. */
function bareJsonbCast(span: string): string | null {
  const re = /\$\d+\s*::\s*jsonb\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(span))) {
    const pre = span.slice(Math.max(0, m.index - 12), m.index);
    if (/::\s*text\s*$/.test(pre)) continue; // $N::text::jsonb is the fix
    return m[0].replace(/\s+/g, "");
  }
  return null;
}

function scanFile(file: string, violations: string[]): void {
  const src = readFileSync(file, "utf8");
  const stringifyIds = stringifyIdentifiers(src);
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(src))) {
    const method = m[1];
    const openIdx = m.index + m[0].length - 1; // index of the '('
    const [s, e] = findSpan(src, openIdx);
    const span = src.slice(s, e);
    if (/jsonb-guard-ok/.test(span)) continue;
    const cast = bareJsonbCast(span);
    if (!cast) continue;
    const code = stripComments(span);
    const direct = /JSON\.stringify\s*\(/.test(code);
    const viaVar = stringifyIds.find((id) =>
      new RegExp(`\\b${id}\\b`).test(code),
    );
    if (!direct && !viaVar) continue; // object/array binding — safe
    const line = src.slice(0, s).split("\n").length;
    violations.push(
      `${file}:${line}  ${method}(...) binds ${
        direct ? "JSON.stringify(...)" : `'${viaVar}' (assigned from JSON.stringify)`
      } into ${cast} — use $N::text::jsonb, or bind a raw object`,
    );
  }
}

function walk(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir)) {
    if (ent === "node_modules") continue;
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
}

describe("jsonb binding guard", () => {
  it("no src file binds a JSON.stringify string into a bare $N::jsonb position", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) scanFile(f, violations);
    expect(violations).toEqual([]);
  });

  it("catches the pre-fix pages.ts shape (variable assigned from JSON.stringify)", () => {
    // Simulated revert of the v1.80.x fix: truthJson is a pre-stringified
    // string bound into a bare ::jsonb cast. The scanner must flag it.
    const reverted = [
      "const truthJson = JSON.stringify(safeTruth);",
      "await tx.query(",
      "  `INSERT INTO pages (slug, type, title, compiled_truth,",
      "                      markdown_body, content_hash, source_id)",
      "   VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,",
      "  [input.slug, type, title, truthJson, body, hashNew, sourceId],",
      ");",
    ].join("\n");
    const dir = join(
      process.env.TMPDIR ?? "/tmp",
      `jsonb-guard-fixture-${process.pid}`,
    );
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs") as
      typeof import("node:fs");
    mkdirSync(dir, { recursive: true });
    const fixture = join(dir, "reverted-pages.ts");
    writeFileSync(fixture, reverted);
    try {
      const violations: string[] = [];
      scanFile(fixture, violations);
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("$4::jsonb");
      expect(violations[0]).toContain("truthJson");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag the safe forms", () => {
    const safe = [
      // The fix: stringified param through a text::jsonb cast.
      "await tx.query(`UPDATE t SET v = $2::text::jsonb WHERE id = $1`, [id, JSON.stringify(x)]);",
      // Raw object binding — driver serializes correctly.
      "await engine.query(`INSERT INTO t (v) VALUES ($1::jsonb)`, [{ a: 1 }]);",
      // SQL literal, no param.
      "await engine.query(`UPDATE t SET v = COALESCE(v, '{}'::jsonb)`);",
    ].join("\n");
    const dir = join(
      process.env.TMPDIR ?? "/tmp",
      `jsonb-guard-safe-${process.pid}`,
    );
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs") as
      typeof import("node:fs");
    mkdirSync(dir, { recursive: true });
    const fixture = join(dir, "safe-forms.ts");
    writeFileSync(fixture, safe);
    try {
      const violations: string[] = [];
      scanFile(fixture, violations);
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
