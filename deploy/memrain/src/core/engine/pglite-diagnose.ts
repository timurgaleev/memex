/**
 * Turning "Aborted()." into something an operator can act on.
 *
 * PGLite is Postgres compiled to WebAssembly, and when it refuses to open a
 * data directory the failure arrives as whatever Emscripten threw — most often
 * a bare `Aborted()` with no cause, no path and no next step. The engine
 * adapter had no try/catch at all, so that string was the whole diagnosis.
 *
 * Two halves here, deliberately separate:
 *
 *   classifyPgliteError  reads the thrown error and names a likely cause.
 *   inspectDataDir       reads the directory itself — pure filesystem, no
 *                        driver, no mutation — so it still works precisely
 *                        when opening the database does not.
 *
 * The second half is the one that matters: a diagnosis you can only get by
 * opening the thing that will not open is no diagnosis. Nothing here writes,
 * repairs or deletes; it reports, and the operator decides.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type PgliteFailureCause =
  | "wasm-abort"
  | "out-of-memory"
  | "locked"
  | "missing"
  | "permission"
  | "unknown";

export interface PgliteDiagnosis {
  cause: PgliteFailureCause;
  /** The original message, never swallowed. */
  message: string;
  /** What to try next, in the operator's own commands. */
  hint: string;
}

/**
 * A readable message for anything that was thrown.
 *
 * `String(e)` on a plain object yields "[object Object]" — which is exactly the
 * unreadable failure this module exists to replace, so it cannot be the
 * fallback. PGLite throws non-Error values, and their fields are the diagnosis.
 */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e !== null && typeof e === "object") {
    const o = e as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "reason"]) {
      if (typeof o[key] === "string" && (o[key] as string).length > 0) {
        return o[key] as string;
      }
    }
    try {
      return JSON.stringify(e) ?? String(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

/** Name a likely cause from the error the driver threw. */
export function classifyPgliteError(e: unknown): PgliteDiagnosis {
  const message = messageOf(e);
  const m = message.toLowerCase();

  if (m.includes("out of memory") || m.includes("rangeerror")) {
    return {
      cause: "out-of-memory",
      message,
      hint:
        "The WASM heap ran out. Every PGLite instance reserves memory that is " +
        "never returned, so this usually means too many were opened in one " +
        "process — run the suite with `bun run test:sharded` rather than a " +
        "single `bun test`.",
    };
  }
  if (m.includes("eacces") || m.includes("permission denied")) {
    return {
      cause: "permission",
      message,
      hint: "The process cannot read or write the data directory — check its owner and mode.",
    };
  }
  if (m.includes("enoent") || m.includes("no such file")) {
    return {
      cause: "missing",
      message,
      hint: "The data directory is not there. `memex init --pglite` creates one.",
    };
  }
  if (/\block(?:ed|ing)?\b/.test(m) || m.includes("in use")) {
    return {
      cause: "locked",
      message,
      hint:
        "Another process appears to hold the directory. PGLite is " +
        "single-process by design; stop the other one and retry.",
    };
  }
  if (m.includes("abort") || m.includes("unreachable")) {
    return {
      cause: "wasm-abort",
      message,
      hint:
        "PGLite aborted while opening the directory, which usually means the " +
        "on-disk state is unreadable to it. Run `memex doctor` — it inspects " +
        "the directory without opening the database.",
    };
  }
  return {
    cause: "unknown",
    message,
    hint: "Run `memex doctor` for an on-disk look at the data directory.",
  };
}

export interface DataDirReport {
  path: string;
  exists: boolean;
  /** A stale lock file left by a process that is gone is a common cause. */
  postmasterPid: number | null;
  postmasterAlive: boolean | null;
  /** Postgres refuses a control file that is not its expected size. */
  pgControlBytes: number | null;
  /** The major version the directory was created by. */
  pgVersion: string | null;
  walSegments: number | null;
  /** Anything the inspection itself could not read. */
  notes: string[];
}

/** Is a PID a live process? `kill(pid, 0)` asks without signalling. */
function pidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive.
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    return null;
  }
}

/**
 * Read what the data directory says about itself. Pure filesystem: this is the
 * half that has to keep working when the database will not open.
 */
export function inspectDataDir(path: string): DataDirReport {
  const report: DataDirReport = {
    path,
    exists: false,
    postmasterPid: null,
    postmasterAlive: null,
    pgControlBytes: null,
    pgVersion: null,
    walSegments: null,
    notes: [],
  };
  try {
    statSync(path);
    report.exists = true;
  } catch (e) {
    // "Cannot read it" is not "it is not there" — reporting the second when
    // the first is true sends an operator looking for a missing directory.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.notes.push(`cannot stat ${path}: ${(e as Error).message}`);
    }
    return report;
  }

  try {
    const raw = readFileSync(join(path, "postmaster.pid"), "utf8");
    const first = Number.parseInt(raw.split("\n")[0] ?? "", 10);
    // PGLite writes a SENTINEL here, not a pid: a healthy, cleanly-closed
    // directory contains "-42". Reporting that as a stale lock would cry wolf
    // on every healthy directory — in the one output an operator reads during
    // an incident. And process.kill() with a negative argument signals a
    // process GROUP, so probing it would answer a question nobody asked.
    if (Number.isFinite(first) && first > 0) {
      report.postmasterPid = first;
      report.postmasterAlive = pidAlive(first);
    } else if (Number.isFinite(first)) {
      report.notes.push(
        `postmaster.pid holds ${first} (PGLite writes a sentinel, not an owner pid)`,
      );
    }
  } catch (e) {
    // Absent is the normal case, not a note worth making.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.notes.push(`postmaster.pid unreadable: ${(e as Error).message}`);
    }
  }

  try {
    report.pgControlBytes = statSync(join(path, "global", "pg_control")).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.notes.push(`pg_control unreadable: ${(e as Error).message}`);
    }
  }

  try {
    report.pgVersion = readFileSync(join(path, "PG_VERSION"), "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.notes.push(`PG_VERSION unreadable: ${(e as Error).message}`);
    }
  }

  try {
    report.walSegments = readdirSync(join(path, "pg_wal")).filter((f) =>
      /^[0-9A-F]{24}$/.test(f),
    ).length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.notes.push(`pg_wal unreadable: ${(e as Error).message}`);
    }
  }

  return report;
}

/** One human line summarising the report — what doctor prints. */
export function describeDataDir(r: DataDirReport): string {
  if (!r.exists) return `${r.path}: directory does not exist`;
  const parts: string[] = [];
  if (r.postmasterPid !== null) {
    parts.push(
      r.postmasterAlive === false
        ? `stale postmaster.pid (PID ${r.postmasterPid} is gone)`
        : `postmaster.pid present (PID ${r.postmasterPid}${
            r.postmasterAlive === true ? ", alive" : ""
          })`,
    );
  }
  parts.push(
    r.pgControlBytes === null
      ? "pg_control MISSING"
      : `pg_control ${r.pgControlBytes} bytes`,
  );
  parts.push(r.pgVersion === null ? "PG_VERSION missing" : `PG_VERSION ${r.pgVersion}`);
  if (r.walSegments !== null) parts.push(`${r.walSegments} WAL segment(s)`);
  parts.push(...r.notes);
  return `${r.path}: ${parts.join(", ")}`;
}
