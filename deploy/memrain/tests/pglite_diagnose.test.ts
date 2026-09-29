/**
 * PGLite failures that say something.
 *
 * The engine adapter had no try/catch at all, so a refusal to open a data
 * directory reached the operator as whatever Emscripten threw — usually a bare
 * `Aborted()` with no cause, no path and no next step.
 *
 * The on-disk inspection is the half that matters: a diagnosis you can only get
 * by opening the thing that will not open is no diagnosis. It reads the
 * directory and nothing else — no driver, no writes, no repair.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPgliteError,
  inspectDataDir,
  describeDataDir,
} from "../src/core/engine/pglite-diagnose.ts";

describe("classifyPgliteError", () => {
  it("names the WASM heap exhaustion the sharded suite exists for", () => {
    const d = classifyPgliteError(new RangeError("Out of memory"));
    expect(d.cause).toBe("out-of-memory");
    expect(d.hint).toContain("test:sharded");
  });

  it("recognises an Emscripten abort", () => {
    expect(classifyPgliteError(new Error("Aborted(). Build with -sASSERTIONS")).cause).toBe(
      "wasm-abort",
    );
  });

  it("recognises missing and permission failures", () => {
    expect(classifyPgliteError(new Error("ENOENT: no such file")).cause).toBe("missing");
    expect(classifyPgliteError(new Error("EACCES: permission denied")).cause).toBe(
      "permission",
    );
  });

  it("never swallows the original message", () => {
    const d = classifyPgliteError(new Error("something entirely new"));
    expect(d.cause).toBe("unknown");
    expect(d.message).toBe("something entirely new");
  });
});

describe("inspectDataDir", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "memex-datadir-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("says so when the directory is not there", () => {
    const r = inspectDataDir(join(tmp, "nope"));
    expect(r.exists).toBe(false);
    expect(describeDataDir(r)).toContain("does not exist");
  });

  it("reads what the directory says about itself", () => {
    const dir = join(tmp, "db");
    mkdirSync(join(dir, "global"), { recursive: true });
    mkdirSync(join(dir, "pg_wal"), { recursive: true });
    writeFileSync(join(dir, "PG_VERSION"), "16\n");
    writeFileSync(join(dir, "global", "pg_control"), Buffer.alloc(8192));
    writeFileSync(join(dir, "pg_wal", "000000010000000000000001"), "");
    writeFileSync(join(dir, "pg_wal", "000000010000000000000002"), "");

    const r = inspectDataDir(dir);
    expect(r.exists).toBe(true);
    expect(r.pgVersion).toBe("16");
    expect(r.pgControlBytes).toBe(8192);
    expect(r.walSegments).toBe(2);
    expect(describeDataDir(r)).toContain("PG_VERSION 16");
  });

  it("calls out a lock file whose owner is gone", () => {
    const dir = join(tmp, "stale");
    mkdirSync(dir, { recursive: true });
    // PID 2^22 is above every real pid_max — nothing can be running there.
    writeFileSync(join(dir, "postmaster.pid"), "4194303\n/some/path\n");

    const r = inspectDataDir(dir);
    expect(r.postmasterPid).toBe(4194303);
    expect(r.postmasterAlive).toBe(false);
    expect(describeDataDir(r)).toContain("stale postmaster.pid");
  });

  it("recognises a live owner as live", () => {
    const dir = join(tmp, "live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "postmaster.pid"), `${process.pid}\n`);
    expect(inspectDataDir(dir).postmasterAlive).toBe(true);
  });
});

describe("messages that are actually readable", () => {
  it("does not render a thrown object as [object Object]", () => {
    // The whole point of this module is replacing an unreadable failure; a
    // fallback that produces one would defeat it.
    const d = classifyPgliteError({ status: 3, note: "wasm trap" });
    expect(d.message).not.toContain("[object Object]");
    expect(d.message).toContain("wasm trap");
  });

  it("prefers a message-shaped field when the thrown value has one", () => {
    expect(classifyPgliteError({ message: "Aborted()" }).cause).toBe("wasm-abort");
  });
});

describe("PGLite's sentinel postmaster.pid", () => {
  it("is not reported as a stale lock on a healthy directory", () => {
    // Verified against a real, cleanly-closed PGLite directory: the first line
    // is "-42". Treating it as an owner pid made every healthy directory look
    // locked by a dead process — a false positive in the exact line an
    // operator reads while something is broken.
    const dir = mkdtempSync(join(tmpdir(), "memex-sentinel-"));
    try {
      writeFileSync(join(dir, "postmaster.pid"), "-42\n/tmp/pglite/base\n5432\n");
      const r = inspectDataDir(dir);
      expect(r.postmasterPid).toBeNull();
      expect(r.postmasterAlive).toBeNull();
      expect(describeDataDir(r)).not.toContain("stale");
      expect(describeDataDir(r)).toContain("sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
