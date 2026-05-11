/**
 * Tests for the recipe_state KV wrapper. Backed by migration 013.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  getRecipeState,
  setRecipeState,
  appendDedupIds,
  filterUnseenIds,
} from "../src/core/recipe-state.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-recipe-state-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("recipe_state", () => {
  it("returns null for an unset key", async () => {
    expect(await getRecipeState(storage.engine(), "gmail", "cursor")).toBeNull();
  });

  it("round-trips a JSON value", async () => {
    await setRecipeState(storage.engine(), "gmail", "cursor", {
      lastPollAt: "2026-05-08T10:00:00Z",
    });
    const v = await getRecipeState<{ lastPollAt: string }>(
      storage.engine(),
      "gmail",
      "cursor",
    );
    expect(v?.lastPollAt).toBe("2026-05-08T10:00:00Z");
  });

  it("appends ids and trims to maxIds", async () => {
    for (let i = 0; i < 5; i++) {
      await appendDedupIds(storage.engine(), "gmail", [`id-${i}`], 3);
    }
    const v = await getRecipeState<{ ids: string[] }>(
      storage.engine(),
      "gmail",
      "processed",
    );
    expect(v?.ids).toEqual(["id-2", "id-3", "id-4"]);
  });

  it("filters seen ids", async () => {
    await appendDedupIds(storage.engine(), "gmail", ["a", "b"], 100);
    const unseen = await filterUnseenIds(
      storage.engine(),
      "gmail",
      ["a", "c", "b", "d"],
    );
    expect(unseen).toEqual(["c", "d"]);
  });
});
