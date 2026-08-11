/**
 * One process per PGLite data directory.
 *
 * The module has said "single-process, concurrent processes not supported"
 * since it was written, and nothing enforced it. Two writers corrupt the
 * directory — and the WAL repair that would follow is mitigation for a
 * collision that can simply be refused.
 *
 * The two halves that make this a guard rather than a trap: a LIVE holder is
 * refused, and a lock left by a DEAD process is taken over. Without the second
 * half, one crash locks the brain out permanently.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDataDirLock,
  PgliteLockedError,
} from "../src/core/engine/pglite-lock.ts";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memex-lock-"));
  dir = join(tmp, "db");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Beside the directory, not inside it: PGLite only initialises into an EMPTY
// directory, so a lock file within one would break every first start.
const lockFile = () => `${dir}.memex-lock`;
/** The lock carries `pid\ntoken`; ownership questions read the first line. */
const lockPid = () => readFileSync(lockFile(), "utf8").split("\n")[0];

describe("acquireDataDirLock", () => {
  it("writes the owner's pid and gives the directory back on release", () => {
    const held = acquireDataDirLock(dir, {});
    expect(existsSync(lockFile())).toBe(true);
    expect(lockPid()).toBe(String(process.pid));
    held.release();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("releases idempotently", () => {
    const held = acquireDataDirLock(dir, {});
    held.release();
    expect(() => held.release()).not.toThrow();
  });

  it("refuses a directory a LIVE process holds", () => {
    // A different live pid: this test process itself would read as "ours".
    writeFileSync(lockFile(), "1\n"); // pid 1 always exists
    expect(() => acquireDataDirLock(dir, {})).toThrow(PgliteLockedError);
  });

  it("takes over a lock left by a process that is gone", () => {
    // Above every real pid_max, so nothing can be running there.
    writeFileSync(lockFile(), "4194303\n");
    const held = acquireDataDirLock(dir, {});
    expect(lockPid()).toBe(String(process.pid));
    held.release();
  });

  it("treats an unreadable lock as stale rather than blocking forever", () => {
    writeFileSync(lockFile(), "not-a-pid\n");
    const held = acquireDataDirLock(dir, {});
    expect(lockPid()).toBe(String(process.pid));
    held.release();
  });

  it("can be turned off, because setups exist that it would wrongly refuse", () => {
    writeFileSync(lockFile(), "1\n");
    const held = acquireDataDirLock(dir, { MEMEX_PGLITE_NO_LOCK: "1" });
    expect(() => held.release()).not.toThrow();
    // The other process's lock is left exactly as it was.
    expect(lockPid()).toBe("1");
  });

  it("keeps the data directory itself untouched", () => {
    // The guard must not make the directory look non-empty to PGLite.
    const held = acquireDataDirLock(dir, {});
    expect(existsSync(join(dir, "memex.lock"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    held.release();
  });

  it("does not try to lock an in-memory handle", () => {
    const held = acquireDataDirLock("memory://x", {});
    expect(() => held.release()).not.toThrow();
  });
});

describe("the cases a file lock gets wrong", () => {
  it("refuses a second handle in the SAME process", () => {
    // A pid check cannot tell this from a stale lock of our own, so it would
    // silently steal the lock — and the first handle's release would then
    // delete the second's. Two PGLite instances on one directory corrupt it
    // whether or not they share a pid.
    const held = acquireDataDirLock(dir, {});
    expect(() => acquireDataDirLock(dir, {})).toThrow(/already open in this process/);
    held.release();
    // Released, so it can be taken again.
    acquireDataDirLock(dir, {}).release();
  });

  it("does not delete a lock that is no longer ours", () => {
    const held = acquireDataDirLock(dir, {});
    // Another process took over after ours went stale.
    writeFileSync(lockFile(), "4194303\nsomeone-elses-token\n");
    held.release();
    expect(existsSync(lockFile())).toBe(true);
    expect(readFileSync(lockFile(), "utf8")).toContain("someone-elses-token");
  });

  it("fails CLOSED when the lock cannot be placed at all", () => {
    // Failing open would leave the directory unguarded exactly when something
    // is already unusual — and there is an explicit way to say "I know".
    const unwritable = join(tmp, "nope", "deep", "db");
    expect(() => acquireDataDirLock(unwritable, {})).toThrow(
      /Refusing to open the directory unguarded/,
    );
    expect(() =>
      acquireDataDirLock(unwritable, { MEMEX_PGLITE_NO_LOCK: "1" }),
    ).not.toThrow();
  });

  it("puts the lock beside the real directory for awkward path shapes", () => {
    // A trailing slash or a relative path would otherwise produce a sibling
    // name that lands inside the directory, or in the working directory.
    const held = acquireDataDirLock(`${dir}/`, {});
    expect(existsSync(lockFile())).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    held.release();
  });
});
