/**
 * import-chat-history script — vendor chat-export JSON → conversation pages.
 * Covers: flat messages array + keyed mapping, YAML quoting of colon-in-title
 * frontmatter, timestamp-less message carry-forward, unparseable-conversation
 * skips, and the --dry-run CLI path writing nothing.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertChatExport } from "../scripts/import-chat-history.ts";
import { parseConversation } from "../src/core/conversation-parser.ts";

// 1710501000s = 2024-03-15T11:10:00Z; 1711958700s = 2024-04-01T08:05:00Z.
const FIXTURE = [
  {
    title: "Deploy: postmortem",
    create_time: 1710501000,
    messages: [
      { author: "alice", text: "we broke prod", timestamp: 1710501000 },
      { sender: "bob", content: "rolled back" }, // no timestamp
      { author: "ghost" }, // no text — dropped
    ],
  },
  {
    name: "Second chat",
    created_at: "2024-04-01T08:05:00Z",
    mapping: {
      m2: {
        message: {
          author: { role: "assistant" },
          content: { parts: ["hi"] },
          create_time: 1711958760,
        },
      },
      m1: {
        message: {
          author: { role: "user" },
          content: { parts: ["hello there"] },
          create_time: 1711958700,
        },
      },
    },
  },
  { junk: true },
];

describe("convertChatExport", () => {
  const { converted, skipped } = convertChatExport(FIXTURE);

  it("converts parseable conversations and skips the rest with a reason", () => {
    expect(converted.length).toBe(2);
    expect(skipped).toEqual([{ index: 2, reason: "no messages found" }]);
  });

  it("quotes frontmatter values containing a colon, leaves plain ones bare", () => {
    const [first, second] = converted;
    expect(first!.markdown).toContain('title: "Deploy: postmortem"');
    expect(second!.markdown).toContain("title: Second chat");
    expect(second!.markdown).not.toContain('"Second chat"');
  });

  it("emits type/date frontmatter and bracket-time body lines", () => {
    const md = converted[0]!.markdown;
    expect(md.startsWith("---\ntype: conversation\n")).toBe(true);
    expect(md).toContain("date: 2024-03-15");
    expect(md).toContain("[11:10] alice: we broke prod");
    // Timestamp-less message inherits the previous message's time.
    expect(md).toContain("[11:10] bob: rolled back");
  });

  it("orders keyed-mapping messages by timestamp", () => {
    const md = converted[1]!.markdown;
    expect(md).toContain("date: 2024-04-01");
    const userAt = md.indexOf("[08:05] user: hello there");
    const assistantAt = md.indexOf("[08:06] assistant: hi");
    expect(userAt).toBeGreaterThan(-1);
    expect(assistantAt).toBeGreaterThan(userAt);
  });

  it("produces bodies the conversation parser reads back", () => {
    const body = converted[0]!.markdown.split("---\n")[2]!;
    const msgs = parseConversation(body, { dateContext: "2024-03-15" });
    expect(msgs.map((m) => m.speaker)).toEqual(["alice", "bob"]);
    expect(msgs[0]!.timestamp).toBe("2024-03-15T11:10:00Z");
  });

  it("reports an unusable root instead of throwing", () => {
    const res = convertChatExport({ nope: 1 });
    expect(res.converted).toEqual([]);
    expect(res.skipped[0]!.reason).toContain("no conversation array");
  });
});

describe("CLI", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "memex-chat-import-"));
    writeFileSync(join(tmp, "export.json"), JSON.stringify(FIXTURE));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const SCRIPT = join(import.meta.dir, "..", "scripts", "import-chat-history.ts");

  it("--dry-run prints the summary and writes nothing", () => {
    const out = join(tmp, "dry-out");
    const proc = Bun.spawnSync(["bun", SCRIPT, join(tmp, "export.json"), out, "--dry-run"]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("converted 2, skipped 1");
    expect(existsSync(out)).toBe(false);
  });

  it("writes one markdown file per conversation", () => {
    const out = join(tmp, "real-out");
    const proc = Bun.spawnSync(["bun", SCRIPT, join(tmp, "export.json"), out]);
    expect(proc.exitCode).toBe(0);
    const files = readdirSync(out).sort();
    expect(files).toEqual(["deploy-postmortem.md", "second-chat.md"]);
    expect(readFileSync(join(out, "deploy-postmortem.md"), "utf8")).toContain(
      'title: "Deploy: postmortem"',
    );
  });
});
