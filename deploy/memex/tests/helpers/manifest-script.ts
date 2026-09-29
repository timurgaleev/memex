/**
 * Runs the shipped `scripts/sql/data-manifest.sql` on PGLite, which psql cannot
 * open. It does what `psql -X -A -t -q -f` does with the file: the text is cut at
 * each `\gexec` line, the statements before it run in order, and every cell the
 * last of them returns runs as a statement of its own. Rows print one per line,
 * cells joined by `|` and NULL as empty, so both engines give the same text.
 * Test-only: the file is the one definition, this only executes it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite, Results } from "@electric-sql/pglite";

export const MANIFEST_SQL = join(import.meta.dir, "../../scripts/sql/data-manifest.sql");

export async function runManifestScript(db: PGlite, file = MANIFEST_SQL): Promise<string> {
  const parts = readFileSync(file, "utf8").split(/^\\gexec[ \t]*$/m);
  const lines: string[] = [];
  const print = (results: Results[]) => {
    for (const r of results) {
      for (const row of r.rows as Record<string, unknown>[]) {
        lines.push(Object.values(row).map((v) => (v == null ? "" : String(v))).join("|"));
      }
    }
  };
  try {
    for (const [i, part] of parts.entries()) {
      const results = await db.exec(part);
      if (i === parts.length - 1) {
        print(results);
        continue;
      }
      const generator = results.pop();
      if (!generator) throw new Error(`manifest script: \\gexec #${i + 1} has no query before it`);
      print(results);
      for (const row of generator.rows as Record<string, unknown>[]) {
        for (const cell of Object.values(row)) if (cell != null) print(await db.exec(String(cell)));
      }
    }
  } catch (e) {
    await db.exec("ROLLBACK").catch(() => {});
    throw e;
  }
  return lines.map((l) => `${l}\n`).join("");
}
