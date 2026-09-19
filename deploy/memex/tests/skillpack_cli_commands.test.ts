/**
 * CLI_COMMANDS is the table the skill pack lint checks `memex <cmd>` against;
 * cli.ts is what actually dispatches. Adding or removing a command in one
 * without the other fails here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_COMMANDS } from "../src/cli-commands.ts";

describe("CLI_COMMANDS", () => {
  it("lists exactly the commands cli.ts dispatches", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
    const start = src.indexOf("  switch (cmd) {\n");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n    default:", start);
    expect(end).toBeGreaterThan(start);

    const labels = new Set<string>();
    for (const line of src.slice(start, end).split("\n")) {
      // Top-level labels sit at four spaces; nested switches are deeper.
      if (!line.startsWith("    case \"")) continue;
      const close = line.indexOf("\"", 10);
      const label = line.slice(10, close);
      // `--help` / `-h` / `--version` are flag spellings of help and version.
      if (!label.startsWith("-")) labels.add(label);
    }

    expect([...labels].sort()).toEqual(Object.keys(CLI_COMMANDS).sort());
  });

  it("names a subcommand only once per command", () => {
    for (const [cmd, spec] of Object.entries(CLI_COMMANDS)) {
      expect({ cmd, subs: new Set(spec.subcommands).size }).toEqual({
        cmd,
        subs: spec.subcommands.length,
      });
    }
  });
});
