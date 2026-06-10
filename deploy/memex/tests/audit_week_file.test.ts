/**
 * ISO-week-rotated best-effort audit writer.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isoWeekKey,
  auditFilePath,
  appendAudit,
} from "../src/core/audit-week-file.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-audit-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("isoWeekKey", () => {
  it("formats as YYYY-Www", () => {
    expect(isoWeekKey(new Date("2026-06-10T00:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("puts Jan 4th in week 1 (ISO anchor)", () => {
    expect(isoWeekKey(new Date("2026-01-04T12:00:00Z"))).toBe("2026-W01");
  });

  it("is stable within a week and rotates across weeks", () => {
    const mon = new Date("2026-06-08T00:00:00Z"); // Monday
    const sun = new Date("2026-06-14T23:59:59Z"); // same ISO week
    const nextMon = new Date("2026-06-15T00:00:00Z"); // next week
    expect(isoWeekKey(mon)).toBe(isoWeekKey(sun));
    expect(isoWeekKey(nextMon)).not.toBe(isoWeekKey(mon));
  });
});

describe("appendAudit", () => {
  it("creates the dir and appends one JSON line per call into the week file", () => {
    const dir = join(tmp, "trail");
    const now = new Date("2026-06-10T00:00:00Z");
    expect(appendAudit(dir, { a: 1 }, now)).toBe(true);
    expect(appendAudit(dir, { a: 2 }, now)).toBe(true);
    const file = auditFilePath(dir, now);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ a: 2 });
  });

  it("is best-effort — returns false, never throws, on an unwritable dir", () => {
    // A file where a directory is expected makes mkdir/append fail (ENOTDIR).
    const blocker = join(tmp, "blocker");
    writeFileSync(blocker, "x");
    expect(appendAudit(join(blocker, "sub"), { a: 1 }, new Date())).toBe(false);
  });
});
