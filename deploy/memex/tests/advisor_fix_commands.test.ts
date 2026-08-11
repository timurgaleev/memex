/**
 * Every fix_command an advisor finding emits has to name something that
 * exists.
 *
 * The finding that motivated this pointed at `memex doctor` for dead links —
 * doctor has no dead-link check, so following the advice printed ok:true while
 * the condition stayed. Another pointed at `memex orphans` for islanded pages,
 * which purges orphaned DB rows and has nothing to do with pages. A wrong
 * fix_command is worse than none: it reports success and the problem persists.
 *
 * What this guard catches: a command or tool that does not exist at all. What
 * it cannot catch: a real command that does not do the advertised thing — the
 * dead-link case was exactly that, since `doctor` is a real command. Intent
 * still needs a human reading the finding next to the command it names.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const collectors = readFileSync(join(root, "src/core/advisor/collectors.ts"), "utf8");
const cli = readFileSync(join(root, "src/cli.ts"), "utf8");
const operations = readFileSync(join(root, "src/mcp/operations.ts"), "utf8");

const cliCommands = new Set(
  [...cli.matchAll(/\n    case "([a-z0-9-]+)":/g)].map((m) => m[1]!),
);
const mcpTools = new Set(
  [...operations.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]!),
);

const fixCommands = [...collectors.matchAll(/fix_command:\s*"([^"]+)"/g)].map(
  (m) => m[1]!,
);

describe("advisor fix_command targets exist", () => {
  it("finds fix commands to check", () => {
    expect(fixCommands.length).toBeGreaterThan(0);
  });

  for (const cmd of fixCommands) {
    it(`"${cmd}" names something real`, () => {
      if (cmd.startsWith("memex (")) return; // prose instruction, not a command
      if (cmd.startsWith("memex ")) {
        expect(cliCommands.has(cmd.split(" ")[1]!)).toBe(true);
      } else {
        expect(mcpTools.has(cmd)).toBe(true);
      }
    });
  }
});
