/**
 * The PGLite data directory is guarded by two lock files during the rename:
 * the pre-rename `.memex-lock` and the current `.memrain-lock`.
 *
 * A pre-rename process that is still running knows only the old file. If new
 * code took only the new one, both would open the same directory and corrupt
 * it. So new code takes the legacy lock first, then the current one, and an
 * old binary still sees the directory as held.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  tmp = mkdtempSync(join(tmpdir(), "memrain-duallock-"));
  dir = join(tmp, "db");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const legacyLock = () => `${dir}.memex-lock`;
const currentLock = () => `${dir}.memrain-lock`;
const pidOf = (path: string) => readFileSync(path, "utf8").split("\n")[0];

/** What a pre-rename binary does: an exclusive create of the legacy file. */
function legacyOnlyAcquire(): boolean {
  try {
    closeSync(openSync(legacyLock(), "wx"));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

describe("dual PGLite data-dir lock", () => {
  it("takes both files, and release removes both", () => {
    const held = acquireDataDirLock(dir, {});
    expect(pidOf(legacyLock())).toBe(String(process.pid));
    expect(pidOf(currentLock())).toBe(String(process.pid));
    held.release();
    expect(existsSync(legacyLock())).toBe(false);
    expect(existsSync(currentLock())).toBe(false);
  });

  it("refuses when a live pre-rename process holds only the legacy lock", () => {
    writeFileSync(legacyLock(), "1\n"); // pid 1 always exists and is not ours
    expect(() => acquireDataDirLock(dir, {})).toThrow(PgliteLockedError);
    // Nothing was placed, and the other process's file is untouched.
    expect(existsSync(currentLock())).toBe(false);
    expect(pidOf(legacyLock())).toBe("1");
  });

  it("blocks a legacy-only acquirer while the new code holds the directory", () => {
    const held = acquireDataDirLock(dir, {});
    expect(legacyOnlyAcquire()).toBe(false);
    held.release();
    // Once released, the old binary can take it again.
    expect(legacyOnlyAcquire()).toBe(true);
  });

  it("gives the legacy lock back when the current one cannot be taken", () => {
    writeFileSync(currentLock(), "1\n"); // a live holder of the new file
    expect(() => acquireDataDirLock(dir, {})).toThrow(PgliteLockedError);
    expect(existsSync(legacyLock())).toBe(false);
    expect(pidOf(currentLock())).toBe("1");

    // And nothing is left registered in this process: once the holder is
    // gone, the directory can be taken.
    rmSync(currentLock());
    acquireDataDirLock(dir, {}).release();
  });

  it("gives the legacy lock back when the current one cannot even be placed", () => {
    // A directory where the current lock file should go makes 'wx' fail with
    // something other than EEXIST, which is the fail-closed path.
    mkdirSync(currentLock());
    expect(() => acquireDataDirLock(dir, {})).toThrow(PgliteLockedError);
    expect(existsSync(legacyLock())).toBe(false);
  });

  it("takes over a stale file on either side", () => {
    // Above every real pid_max, so nothing can be running there.
    writeFileSync(legacyLock(), "4194303\n");
    writeFileSync(currentLock(), "4194303\n");
    const held = acquireDataDirLock(dir, {});
    expect(pidOf(legacyLock())).toBe(String(process.pid));
    expect(pidOf(currentLock())).toBe(String(process.pid));
    held.release();
  });

  it("refuses a second handle in the same process", () => {
    const held = acquireDataDirLock(dir, {});
    expect(() => acquireDataDirLock(dir, {})).toThrow(/already open in this process/);
    // The refused attempt must not have released the first handle's files.
    expect(pidOf(legacyLock())).toBe(String(process.pid));
    expect(pidOf(currentLock())).toBe(String(process.pid));
    held.release();
  });

  it("leaves a file that is no longer ours on release", () => {
    const held = acquireDataDirLock(dir, {});
    writeFileSync(legacyLock(), "4194303\nsomeone-elses-token\n");
    held.release();
    expect(existsSync(currentLock())).toBe(false);
    expect(readFileSync(legacyLock(), "utf8")).toContain("someone-elses-token");
  });

  it("releases idempotently", () => {
    const held = acquireDataDirLock(dir, {});
    held.release();
    expect(() => held.release()).not.toThrow();
  });

  it("takes neither file when the lock is turned off", () => {
    const held = acquireDataDirLock(dir, { MEMRAIN_PGLITE_NO_LOCK: "1" });
    expect(existsSync(legacyLock())).toBe(false);
    expect(existsSync(currentLock())).toBe(false);
    held.release();
  });
});
