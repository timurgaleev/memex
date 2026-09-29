/**
 * Build the pre-migrated PGLite directory the sharded test runner hands to
 * every test through MEMRAIN_TEST_PGLITE_TEMPLATE.
 *
 * Usage: bun scripts/build-test-template.ts <dir>
 *
 * A directory that already exists is reused as-is: the caller names it after a
 * hash of the migrations, so a changed migration gets a new directory. The
 * build lands in a sibling scratch directory and is renamed into place, so a
 * runner that races this one never copies a half-migrated cluster.
 */

import "../src/core/env-compat.ts";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Storage } from "../src/core/storage.ts";

const target = process.argv[2];
if (!target) {
  console.error("usage: bun scripts/build-test-template.ts <dir>");
  process.exit(2);
}

if (!existsSync(target)) {
  // The template must come from real migrations, not from an older template.
  delete process.env["MEMRAIN_TEST_PGLITE_TEMPLATE"];
  const scratch = mkdtempSync(join(dirname(target), `${basename(target)}.build-`));
  const dbPath = join(scratch, "db");
  const storage = new Storage({ dbPath });
  await storage.init();
  await storage.close();
  try {
    renameSync(dbPath, target);
  } catch (e) {
    // Another runner finished first; its copy is just as good.
    if (!existsSync(target)) throw e;
  }
  rmSync(scratch, { recursive: true, force: true });
}
console.log(target);
