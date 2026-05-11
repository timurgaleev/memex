/**
 * `memex integrity [--vault P]` — vault-vs-index drift report.
 *
 * Walks the vault, queries the DB, and prints:
 *   - on_disk:    files present in vault but not in documents (missing index)
 *   - in_db_only: documents whose source_path no longer exists on disk
 *                 (likely a rename or delete the watcher missed)
 *   - stale:      on-disk mtime newer than last_indexed_mtime by > 60s
 *
 * Read-only — fixes nothing. 's eventual auto-heal would call
 * indexer.indexFile / DELETE based on this report; for now it's a
 * diagnostic that the user / agent acts on manually.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";

const DEFAULT_IGNORES = new Set([
  ".obsidian",
  ".trash",
  ".git",
  "memex",
  ".memex",
  "node_modules",
]);

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

interface DiskEntry {
  path: string;
  mtimeMs: number;
}

function* walkMd(root: string): Generator<DiskEntry> {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (DEFAULT_IGNORES.has(ent.name)) continue;
    const full = join(root, ent.name);
    if (ent.isDirectory()) yield* walkMd(full);
    else if (ent.isFile() && ent.name.endsWith(".md")) {
      try {
        yield { path: full, mtimeMs: Math.floor(statSync(full).mtimeMs) };
      } catch {
        // skip unreadable
      }
    }
  }
}

export interface IntegrityOptions {
  vault?: string;
  /** mtime tolerance (ms) before flagging a chunk as stale. Default 60_000. */
  staleToleranceMs?: number;
}

export async function runIntegrity(opts: IntegrityOptions): Promise<void> {
  const config = loadConfig();
  const vault =
    opts.vault ??
    process.env.MEMEX_VAULT_PATH ??
    config.storage.vault ??
    null;
  if (!vault) {
    throw new Error(
      "memex integrity: vault path is required (--vault PATH, $MEMEX_VAULT_PATH, or storage.vault in config.json)",
    );
  }
  if (!existsSync(vault)) {
    throw new Error(`memex integrity: vault path ${vault} does not exist`);
  }

  const tolerance = opts.staleToleranceMs ?? 60_000;
  const storage = new Storage(config);
  await storage.init();
  try {
    const dbRows = await storage
      .raw()
      .query<{
        id: string;
        source_path: string;
        last_indexed_mtime: number | null;
      }>(
        "SELECT id, source_path, last_indexed_mtime FROM documents",
      );
    const dbBySource = new Map(
      dbRows.rows.map((r) => [
        r.source_path,
        { id: r.id, last: r.last_indexed_mtime },
      ]),
    );

    const onDiskOnly: string[] = [];
    const stale: { path: string; onDisk: number; indexed: number }[] = [];
    const seenSources = new Set<string>();
    for (const ent of walkMd(vault)) {
      seenSources.add(ent.path);
      const row = dbBySource.get(ent.path);
      if (!row) {
        onDiskOnly.push(ent.path);
        continue;
      }
      if (row.last !== null && ent.mtimeMs - row.last > tolerance) {
        stale.push({
          path: ent.path,
          onDisk: ent.mtimeMs,
          indexed: row.last,
        });
      }
    }

    const inDbOnly: string[] = [];
    for (const [src] of dbBySource) {
      if (!seenSources.has(src)) inDbOnly.push(src);
    }

    const summary = {
      ok:
        onDiskOnly.length === 0 &&
        inDbOnly.length === 0 &&
        stale.length === 0,
      vault,
      documents_in_db: dbRows.rows.length,
      files_on_disk: seenSources.size,
      on_disk_not_in_db: onDiskOnly.length,
      in_db_not_on_disk: inDbOnly.length,
      stale: stale.length,
      details: {
        on_disk_only: onDiskOnly.slice(0, 20),
        in_db_only: inDbOnly.slice(0, 20),
        stale: stale.slice(0, 20),
      },
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await storage.close();
  }
}
