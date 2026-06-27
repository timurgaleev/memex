/**
 * Link-extraction freshness watermark (migration 051) — stampLinksExtracted +
 * countStalePagesForExtraction. A page reads stale when never extracted, edited
 * since the last extract, or extracted under an older extractor version.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  stampLinksExtracted,
  countStalePagesForExtraction,
  LINK_EXTRACTOR_VERSION_TS,
} from "../src/core/links.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-linkwm-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("countStalePagesForExtraction", () => {
  it("a freshly-put page reads stale (NULL watermark) until stamped", async () => {
    await putPage(storage, { slug: "people/a", type: "person" });
    const e = storage.engine();
    expect(await countStalePagesForExtraction(e)).toBe(1); // NULL links_extracted_at

    await stampLinksExtracted(e, "people/a");
    expect(await countStalePagesForExtraction(e)).toBe(0); // stamped after updated_at
  });

  it("re-editing a stamped page makes it stale again (updated_at > watermark)", async () => {
    const e = storage.engine();
    await putPage(storage, { slug: "people/b", type: "person", markdown_body: "v1" });
    await stampLinksExtracted(e, "people/b");
    expect(await countStalePagesForExtraction(e)).toBe(0);

    // A content edit bumps updated_at past the watermark → stale.
    await putPage(storage, { slug: "people/b", type: "person", markdown_body: "v2 changed" });
    expect(await countStalePagesForExtraction(e)).toBe(1);
  });

  it("a future version watermark marks an already-stamped page stale", async () => {
    const e = storage.engine();
    await putPage(storage, { slug: "people/c", type: "person" });
    await stampLinksExtracted(e, "people/c");
    expect(await countStalePagesForExtraction(e, { versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    // Bump the extractor version into the future → the page's stamp predates it.
    expect(await countStalePagesForExtraction(e, { versionTs: "2099-01-01T00:00:00Z" })).toBe(1);
  });

  it("excludes soft-deleted pages", async () => {
    const e = storage.engine();
    await putPage(storage, { slug: "people/d", type: "person" });
    const { deletePage } = await import("../src/core/pages.ts");
    await deletePage(storage, "people/d");
    expect(await countStalePagesForExtraction(e)).toBe(0);
  });
});
