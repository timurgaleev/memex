/**
 * `memex <cmd> --help` must reach the COMMAND's own manual.
 *
 * Two things stood between the operator and it: the generic `--help` branch in
 * main() answered for every command, and argument validation ran first — so
 * `memex watch --help` printed the one-line usage table, and the WATCH_HELP
 * text (plus `eval chronicle`'s) was unreachable code. A half-typed command
 * line is exactly when the manual is wanted, so help must be answered before
 * the rest of the line is judged.
 *
 * These drive the real entrypoint (a spawned `bun src/cli.ts`) because the
 * defect was in the ORDER of main()'s steps, and nothing short of the whole
 * entrypoint can show the order.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { WATCH_HELP } from "../src/commands/watch.ts";

const root = join(import.meta.dir, "..");

function memex(...argv: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "src/cli.ts", ...argv], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

describe("per-command --help", () => {
  it("prints watch's own manual, not the command table", () => {
    const r = memex("watch", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toBe(WATCH_HELP);
    expect(r.out).not.toContain("Usage: memex <command>");
  });

  it("prints the chronicle eval's own manual", () => {
    const r = memex("eval", "chronicle", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: memex eval chronicle");
    expect(r.out).not.toContain("Usage: memex <command>");
  });

  it("answers BEFORE the rest of the line is validated", () => {
    // The same tail is a hard error on its own (next case), so help winning
    // here can only mean it short-circuits ahead of validation.
    const r = memex("watch", "--help", "--window-turns");
    expect(r.code).toBe(0);
    expect(r.out).toBe(WATCH_HELP);
  });

  it("still validates when help was not asked for", () => {
    const r = memex("watch", "--window-turns");
    expect(r.code).toBe(1);
    expect(r.err).toContain("memex watch: --window-turns requires a value");
  });

  it("falls back to the command table for commands with no manual", () => {
    const r = memex("reindex", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: memex <command>");
  });
});
