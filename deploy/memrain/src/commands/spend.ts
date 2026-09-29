/**
 * `memex spend [--days N]` — where the LLM money went over the last N days
 * (default 7): by model, by feature, by spender, plus the calls the totals
 * cannot price.
 */
import { spendReport } from "../core/spend-report.ts";
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";

export async function runSpend(opts: { days?: number } = {}): Promise<void> {
  const storage = new Storage(loadConfig());
  await withStorage(storage, async () => {
    console.log(JSON.stringify(await spendReport(storage.engine(), opts), null, 2));
  });
}
