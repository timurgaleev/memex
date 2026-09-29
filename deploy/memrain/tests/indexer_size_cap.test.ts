/**
 * indexDocument content-size cap — the missing content-path half of the
 * the 5 MB ingest cap (it guards both the file path and the in-memory
 * content path; memex had only the file path). Stops a remote/page-mirror caller
 * shipping a >5 MB doc whose huge frontmatter would OOM the cycle.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

describe("indexDocument size cap", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-sizecap-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws on a document over the 5 MB cap", async () => {
    const huge = "---\ntranscript: " + "x".repeat(6 * 1024 * 1024) + "\n---\nbody";
    await expect(
      indexDocument(storage, { sourcePath: "/notes/huge.md", text: huge }, { embedFn: detEmbed }),
    ).rejects.toThrow(/exceeds the .* byte cap/);
  });

  it("indexes a normal-sized document", async () => {
    const r = await indexDocument(
      storage,
      { sourcePath: "/notes/ok.md", text: "# Title\n\nbody one\n\nbody two" },
      { embedFn: detEmbed },
    );
    expect(r.chunks).toBeGreaterThan(0);
  });
});
