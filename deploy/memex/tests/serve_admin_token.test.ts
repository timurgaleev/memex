/**
 * Guard: the generated admin bootstrap token never reaches a non-TTY stderr.
 *
 * Under docker/systemd stderr IS the log collector, so echoing the ephemeral
 * admin credential there persists a live server secret in plaintext log
 * storage. The only headless path is the operator supplying their own token
 * via MEMEX_ADMIN_BOOTSTRAP — an "print it anyway" override would be reached
 * for by exactly the deployments the TTY gate exists to protect.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldPrintAdminToken } from "../src/commands/serve.ts";

const SERVE_SRC = resolve(import.meta.dir, "../src/commands/serve.ts");

describe("shouldPrintAdminToken", () => {
  it("echoes a generated token on an interactive terminal", () => {
    expect(shouldPrintAdminToken({ fromEnv: false, isTty: true })).toBe(true);
  });

  it("withholds a generated token when stderr is a log sink", () => {
    expect(shouldPrintAdminToken({ fromEnv: false, isTty: false })).toBe(false);
  });

  it("never echoes an operator-supplied token", () => {
    expect(shouldPrintAdminToken({ fromEnv: true, isTty: true })).toBe(false);
    expect(shouldPrintAdminToken({ fromEnv: true, isTty: false })).toBe(false);
  });

  it("honours no force-print escape hatch", () => {
    // An earlier revision took a `forcePrint` flag that won over the TTY gate.
    // Passing the retired shape must not resurrect the log-sink leak.
    const legacy = { fromEnv: false, isTty: false, forcePrint: true } as unknown as
      Parameters<typeof shouldPrintAdminToken>[0];
    expect(shouldPrintAdminToken(legacy)).toBe(false);
  });

  it("reads no env override for the token print", () => {
    const src = readFileSync(SERVE_SRC, "utf8");
    expect(src).not.toMatch(/MEMEX_PRINT_ADMIN_TOKEN/);
  });
});
