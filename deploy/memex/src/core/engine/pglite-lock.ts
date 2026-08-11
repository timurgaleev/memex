/**
 * One process per PGLite data directory.
 *
 * PGLite is single-process by design — the engine module has said so in a
 * comment since it was written — but nothing enforced it. Two processes opening
 * the same directory corrupt it, and the WAL-repair work that would otherwise
 * follow is mitigation for a collision that can simply be refused.
 *
 * Getting a file lock right is mostly about the cases where it is WRONG:
 *
 *   - Two starters both find a stale lock and both clear it. Creating with the
 *     exclusive flag is atomic, but delete-then-create is not, so each writes
 *     its own lock and both believe they hold it. Every acquisition therefore
 *     READS THE LOCK BACK and keeps it only if it still carries its own token.
 *     The loser sees the winner's token and backs off.
 *   - A second handle in the SAME process. A pid check cannot tell that apart
 *     from a stale lock of our own, so it would silently steal the lock from
 *     the first handle — and the first handle's release would then delete the
 *     second's. A process-local registry refuses it outright: two PGLite
 *     instances on one directory corrupt it whether or not they share a pid.
 *   - Releasing someone else's lock. `release()` unlinks by path, and by then
 *     the file may belong to a process that took over after ours went stale.
 *     It verifies the token first.
 *   - The lock cannot be created at all. Failing OPEN there would leave the
 *     directory unguarded exactly when something is already unusual, so it
 *     fails closed and names the escape hatch instead.
 *
 * `MEMEX_PGLITE_NO_LOCK=1` skips the whole mechanism, for setups this rule
 * would wrongly refuse (a read-only mount, a filesystem without exclusive
 * create).
 */
import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname, basename, join } from "node:path";

export class PgliteLockedError extends Error {}

/** Lock paths this process currently holds, so it cannot fight itself. */
const heldInProcess = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists, owned by someone else. ESRCH: gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env["MEMEX_PGLITE_NO_LOCK"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Where the lock for a data directory lives, or null when there is nothing to
 * guard.
 *
 * BESIDE the directory, not inside it: PGLite initialises a fresh database only
 * into an empty directory, so a lock file placed within one turns every first
 * start into "this is not a PGLite directory" — the guard would break the case
 * it exists to protect.
 *
 * The path is resolved first. A relative `.` or a trailing slash would
 * otherwise produce a sibling name that lands inside the directory or in the
 * working directory, guarding something other than the database.
 */
function lockPathFor(dbPath: string): string | null {
  if (dbPath.length === 0) return null;
  if (dbPath.startsWith("memory://") || dbPath.startsWith("idb://")) return null;
  const abs = resolve(dbPath);
  const name = basename(abs);
  // A filesystem root has no basename to hang a sibling off.
  if (name.length === 0) return null;
  return join(dirname(abs), `${name}.memex-lock`);
}

export interface HeldLock {
  /** Give the directory back. Safe to call more than once. */
  release: () => void;
}

interface LockContents {
  pid: number | null;
  token: string | null;
}

function readLock(lockPath: string): LockContents {
  try {
    const [pidLine, tokenLine] = readFileSync(lockPath, "utf8").split("\n");
    const pid = Number.parseInt(pidLine ?? "", 10);
    return {
      pid: Number.isFinite(pid) ? pid : null,
      token: (tokenLine ?? "").trim() || null,
    };
  } catch {
    return { pid: null, token: null };
  }
}

/** Create the lock exclusively. Returns false when it already exists. */
function writeLock(lockPath: string, token: string, dbPath: string): boolean {
  let fd: number;
  try {
    // 'wx' fails when the file exists — the create IS the lock.
    fd = openSync(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    // Not a collision — we simply cannot place a lock here. Refusing to open
    // the database is the safe answer: an unguarded open is the corruption
    // this exists to prevent, and there is an explicit way to say "I know".
    throw new PgliteLockedError(
      `pglite: cannot create the lock for ${dbPath} at ${lockPath} ` +
        `(${(e as Error).message}). Refusing to open the directory unguarded — ` +
        `set MEMEX_PGLITE_NO_LOCK=1 if this environment cannot hold a lock.`,
    );
  }
  try {
    writeSync(fd, `${process.pid}\n${token}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function makeHandle(lockPath: string, token: string): HeldLock {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      heldInProcess.delete(lockPath);
      // Only ever delete OUR lock: by now the file may belong to a process
      // that took over after this one went stale.
      const cur = readLock(lockPath);
      if (cur.token !== null && cur.token !== token) return;
      try {
        unlinkSync(lockPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          process.stderr.write(
            `[pglite-lock] WARN: could not remove ${lockPath}: ${(e as Error).message}\n`,
          );
        }
      }
    },
  };
}

/**
 * Take the directory, or explain who has it.
 *
 * Throws {@link PgliteLockedError} when another live process holds it, when a
 * second handle in this process asks for the same directory, or when the lock
 * cannot be placed at all. A lock left by a dead process is taken over — that
 * is the difference between a guard and a trap.
 */
export function acquireDataDirLock(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): HeldLock {
  const noop: HeldLock = { release: () => {} };
  if (lockDisabled(env)) return noop;
  const lockPath = lockPathFor(dbPath);
  if (lockPath === null) return noop;

  if (heldInProcess.has(lockPath)) {
    throw new PgliteLockedError(
      `pglite: ${dbPath} is already open in this process. Two PGLite instances ` +
        `on one directory corrupt it — reuse the existing Storage instead of ` +
        `opening a second.`,
    );
  }

  const token = randomBytes(12).toString("hex");

  const claim = (): HeldLock | null => {
    if (!writeLock(lockPath, token, dbPath)) return null;
    // Read back: delete-then-create is not atomic, so two takers can each
    // create a lock and each believe they won. The one whose token survives
    // holds it; the other backs off.
    if (readLock(lockPath).token !== token) return null;
    heldInProcess.add(lockPath);
    return makeHandle(lockPath, token);
  };

  const first = claim();
  if (first !== null) return first;

  const holder = readLock(lockPath);
  if (holder.pid !== null && holder.pid > 0 && pidAlive(holder.pid)) {
    throw new PgliteLockedError(
      `pglite: ${dbPath} is open in another process (PID ${holder.pid}). ` +
        `PGLite is single-process — two writers corrupt the directory. Stop ` +
        `that process, or set MEMEX_PGLITE_NO_LOCK=1 if you are certain it is ` +
        `not writing.`,
    );
  }

  // Stale, or unreadable. Clear it and try once — never in a loop, because a
  // loop against a live contender is just a slower way to lose.
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PgliteLockedError(
        `pglite: ${dbPath} holds a stale lock at ${lockPath} that cannot be ` +
          `removed (${(e as Error).message}).`,
      );
    }
  }
  const second = claim();
  if (second !== null) return second;

  throw new PgliteLockedError(
    `pglite: ${dbPath} lock is contended — another process claimed it while ` +
      `this one was clearing a stale lock. Retry.`,
  );
}
