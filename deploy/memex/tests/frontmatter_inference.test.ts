/**
 * frontmatter-inference phase — keyset-paginated so peak memory is O(batch),
 * mirroring the reference's one-doc-at-a-time iteration (the single-shot
 * full-corpus load SIGKILLed the live cycle at this phase). Verify it still
 * infers across the batch boundary and stays idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { frontmatterInferencePhase } from "../src/core/cycle/frontmatter-inference.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-fminfer-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  process.env.MEMEX_CYCLE_FM_BATCH = "2"; // force pagination across 3 docs
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_CYCLE_FM_BATCH;
});

async function fmOf(id: string): Promise<Record<string, unknown>> {
  const r = await storage.engine().query<{ f: Record<string, unknown> }>(
    "SELECT frontmatter AS f FROM documents WHERE id = $1",
    [id],
  );
  return r.rows[0]?.f ?? {};
}

describe("frontmatterInferencePhase (paginated)", () => {
  it("infers title/created/updated/tags for every doc across batch boundaries", async () => {
    for (const id of ["doc_a", "doc_b", "doc_c"]) {
      await writeDocumentTransaction(
        storage,
        { documentId: id, sourcePath: `/${id}.md`, title: `T-${id}`, frontmatter: {}, embeddingModel: "det" },
        [{ text: `body of ${id} #tag${id}`, entities: [] }],
      );
    }

    const r = await frontmatterInferencePhase(storage.engine());
    expect(r.scanned).toBe(3); // all three despite FM_BATCH=2
    expect(r.updated).toBe(3);

    for (const id of ["doc_a", "doc_b", "doc_c"]) {
      const fm = await fmOf(id);
      expect(fm["title"]).toBe(`T-${id}`);
      expect(fm["created"]).toBeTruthy();
      expect(fm["updated"]).toBeTruthy();
      expect(Array.isArray(fm["tags"])).toBe(true);
    }
  });

  it("is idempotent — a second run changes nothing", async () => {
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_x", sourcePath: "/x.md", title: "X", frontmatter: {}, embeddingModel: "det" },
      [{ text: "hello", entities: [] }],
    );
    await frontmatterInferencePhase(storage.engine());
    const r2 = await frontmatterInferencePhase(storage.engine());
    expect(r2.updated).toBe(0);
  });
});
