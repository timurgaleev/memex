/**
 * Unit tests for the shared path-confinement guard.
 *
 * Threat scenarios exercised:
 *   - lexical traversal (..)
 *   - symlink escape from inside an allowed root to outside
 *   - exact root match + path under root
 *   - dotfile / .env / .git/* deny-list
 *   - empty roots → PathGuardConfigError (fail-closed)
 *   - non-string / empty input
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWithinAllowedRoot,
  PathGuardConfigError,
} from "../src/core/path_guard.ts";

let tmp: string;
let vault: string;
let outside: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "path-guard-"));
  vault = join(tmp, "vault");
  outside = join(tmp, "outside");
  mkdirSync(vault, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(vault, "note.md"), "vault content");
  writeFileSync(join(outside, "secret.txt"), "secret content");
  process.env.MEMEX_VAULT_PATHS = vault;
  process.env.MEMEX_CODE_PATHS = "";
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_VAULT_PATHS;
  delete process.env.MEMEX_CODE_PATHS;
});

describe("isWithinAllowedRoot — happy path", () => {
  test("file directly under root is allowed", () => {
    expect(isWithinAllowedRoot(join(vault, "note.md"))).toBe(true);
  });

  test("the root itself is allowed", () => {
    expect(isWithinAllowedRoot(vault)).toBe(true);
  });

  test("nested path under root is allowed", () => {
    const sub = join(vault, "sub", "deep.md");
    mkdirSync(join(vault, "sub"));
    writeFileSync(sub, "x");
    expect(isWithinAllowedRoot(sub)).toBe(true);
  });
});

describe("isWithinAllowedRoot — rejection", () => {
  test("lexical traversal via .. is rejected", () => {
    expect(isWithinAllowedRoot(join(vault, "..", "outside", "secret.txt"))).toBe(false);
  });

  test("absolute path outside root is rejected", () => {
    expect(isWithinAllowedRoot(join(outside, "secret.txt"))).toBe(false);
  });

  test("symlink inside root pointing OUT of root is rejected", () => {
    const link = join(vault, "escape");
    symlinkSync(join(outside, "secret.txt"), link);
    expect(isWithinAllowedRoot(link)).toBe(false);
  });

  test("empty string is rejected", () => {
    expect(isWithinAllowedRoot("")).toBe(false);
  });

  test("non-string input is rejected", () => {
    // @ts-expect-error testing runtime check
    expect(isWithinAllowedRoot(null)).toBe(false);
    // @ts-expect-error testing runtime check
    expect(isWithinAllowedRoot(undefined)).toBe(false);
  });
});

describe("isWithinAllowedRoot — fail-closed on misconfig", () => {
  test("throws PathGuardConfigError when no roots are configured", () => {
    delete process.env.MEMEX_VAULT_PATHS;
    delete process.env.MEMEX_CODE_PATHS;
    expect(() => isWithinAllowedRoot(join(vault, "note.md"))).toThrow(
      PathGuardConfigError,
    );
  });

  test("throws when roots are configured but all are blank strings", () => {
    process.env.MEMEX_VAULT_PATHS = " , , ";
    expect(() => isWithinAllowedRoot(join(vault, "note.md"))).toThrow(
      PathGuardConfigError,
    );
  });
});

describe("isWithinAllowedRoot — dotfile deny-list", () => {
  test(".env at root is denied", () => {
    const dotenv = join(vault, ".env");
    writeFileSync(dotenv, "SECRET=x");
    expect(isWithinAllowedRoot(dotenv)).toBe(false);
  });

  test(".env.local is denied", () => {
    const dotenv = join(vault, ".env.local");
    writeFileSync(dotenv, "SECRET=x");
    expect(isWithinAllowedRoot(dotenv)).toBe(false);
  });

  test(".git/config is denied", () => {
    const gitDir = join(vault, ".git");
    mkdirSync(gitDir);
    const cfg = join(gitDir, "config");
    writeFileSync(cfg, "[core]");
    expect(isWithinAllowedRoot(cfg)).toBe(false);
  });

  test(".obsidian/workspace.json is denied", () => {
    const obsDir = join(vault, ".obsidian");
    mkdirSync(obsDir);
    const ws = join(obsDir, "workspace.json");
    writeFileSync(ws, "{}");
    expect(isWithinAllowedRoot(ws)).toBe(false);
  });

  test("ordinary nested file remains allowed", () => {
    const ok = join(vault, "notes", "2026-05-16.md");
    mkdirSync(join(vault, "notes"));
    writeFileSync(ok, "ok");
    expect(isWithinAllowedRoot(ok)).toBe(true);
  });
});
