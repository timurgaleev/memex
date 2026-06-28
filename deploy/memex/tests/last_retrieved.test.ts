/**
 * last_retrieved_at write-back — the producer the context-volunteer "used" stat
 * needs. Bumps on a page surface, throttles repeat surfaces (5 min), opts out
 * via MEMEX_TRACK_RETRIEVAL=0, and is best-effort (never throws).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { bumpLastRetrievedAt } from "../src/core/last-retrieved.ts";
import { registerSource } from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-lastret-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  delete process.env.MEMEX_TRACK_RETRIEVAL;
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMEX_TRACK_RETRIEVAL;
});

async function lastRetrieved(slug: string): Promise<string | null> {
  const r = await storage.engine().query<{ t: string | null }>(
    "SELECT last_retrieved_at::text AS t FROM pages WHERE slug = $1",
    [slug],
  );
  return r.rows[0]?.t ?? null;
}

describe("bumpLastRetrievedAt", () => {
  it("sets last_retrieved_at on a surfaced page (NULL → now)", async () => {
    await putPage(storage, { slug: "people/a", type: "person" });
    expect(await lastRetrieved("people/a")).toBeNull();

    await bumpLastRetrievedAt(storage.engine(), ["people/a"]);
    expect(await lastRetrieved("people/a")).not.toBeNull();
  });

  it("throttles a repeat surface within 5 minutes (value unchanged)", async () => {
    await putPage(storage, { slug: "people/a", type: "person" });
    await bumpLastRetrievedAt(storage.engine(), ["people/a"]);
    const first = await lastRetrieved("people/a");

    await bumpLastRetrievedAt(storage.engine(), ["people/a"]);
    expect(await lastRetrieved("people/a")).toBe(first); // throttle skipped the write
  });

  it("opts out when MEMEX_TRACK_RETRIEVAL=0", async () => {
    process.env.MEMEX_TRACK_RETRIEVAL = "0";
    await putPage(storage, { slug: "people/a", type: "person" });
    await bumpLastRetrievedAt(storage.engine(), ["people/a"]);
    expect(await lastRetrieved("people/a")).toBeNull();
  });

  it("scopes the stamp to the given source (mig-047 pre-emption)", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "s1", kind: "vault", pathPrefix: "/s1" });
    await registerSource(e, { id: "s2", kind: "vault", pathPrefix: "/s2" });
    await putPage(storage, { slug: "people/a", type: "person", source_id: "s1" });
    await putPage(storage, { slug: "people/b", type: "person", source_id: "s2" });

    await bumpLastRetrievedAt(e, ["people/a", "people/b"], "s1");
    expect(await lastRetrieved("people/a")).not.toBeNull(); // s1 stamped
    expect(await lastRetrieved("people/b")).toBeNull(); // s2 untouched
  });

  it("is a no-op on an empty slug list", async () => {
    await bumpLastRetrievedAt(storage.engine(), []);
    // no throw, nothing to assert beyond completion
  });

  it("never throws on a bad write (best-effort)", async () => {
    await storage.close(); // engine closed → the UPDATE fails internally
    await bumpLastRetrievedAt(storage.engine(), ["people/a"]);
    // reopen so afterEach close() doesn't double-fault
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
});
