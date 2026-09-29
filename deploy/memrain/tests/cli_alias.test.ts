/**
 * The pre-rename `memex` command name: it still runs the CLI and only adds one
 * deprecation line on stderr; `memrain` prints nothing extra.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasDeprecationLine, invokedAs } from "../src/cli-alias.ts";

const root = join(import.meta.dir, "..");
const BUN = "/usr/local/bin/bun";

describe("invokedAs", () => {
  it("reads the script name from argv[1]", () => {
    expect(invokedAs([BUN, "/usr/local/bin/memex"])).toBe("memex");
    expect(invokedAs([BUN, "/usr/local/bin/memrain"])).toBe("memrain");
    expect(invokedAs([BUN, "/app/src/cli.ts"])).toBe("memrain");
    expect(invokedAs([BUN])).toBe("memrain");
  });

  it("falls back to the shell's $_ when argv[1] is the resolved symlink target", () => {
    expect(invokedAs([BUN, "/app/src/cli.ts"], { _: "/home/u/.bun/bin/memex" })).toBe("memex");
    expect(invokedAs([BUN, "/app/src/cli.ts"], { _: "/home/u/.bun/bin/memrain" })).toBe("memrain");
    expect(invokedAs([BUN, "/app/src/cli.ts"], { _: BUN })).toBe("memrain");
  });

  it("matches the whole name, not a prefix", () => {
    expect(invokedAs([BUN, "/x/memex-tool"])).toBe("memrain");
    expect(invokedAs([BUN, "/x/memex.ts"])).toBe("memex");
  });
});

describe("aliasDeprecationLine", () => {
  it("is one line for the legacy name and null otherwise", () => {
    const line = aliasDeprecationLine([BUN, "/usr/local/bin/memex"]);
    expect(line).toContain("'memex' command is deprecated");
    expect(line).toContain("memrain");
    expect(line).not.toContain("\n");
    expect(aliasDeprecationLine([BUN, "/usr/local/bin/memrain"])).toBeNull();
  });
});

describe("the CLI started under each name", () => {
  function run(dollarUnderscore: string): { code: number; out: string; err: string } {
    const home = mkdtempSync(join(tmpdir(), "cli-alias-"));
    try {
      const p = Bun.spawnSync(["bun", "src/cli.ts", "--version"], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", HOME: home, MEMRAIN_VERSION: "x", _: dollarUnderscore },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: p.exitCode,
        out: new TextDecoder().decode(p.stdout),
        err: new TextDecoder().decode(p.stderr),
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("memex runs the command and warns once, without failing", () => {
    const r = run("/usr/local/bin/memex");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("memrain x");
    expect(r.err.trim().split("\n")).toEqual([aliasDeprecationLine([BUN, "memex"])!]);
  });

  it("memrain prints no deprecation line", () => {
    const r = run("/usr/local/bin/memrain");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("memrain x");
    expect(r.err).toBe("");
  });
});
