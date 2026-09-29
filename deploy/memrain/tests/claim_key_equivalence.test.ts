/**
 * memrain_fact_claim_key (migration 120) returns what memex_fact_claim_key
 * (migration 112) returned before and after 120, and what the inline
 * expression returns, over a corpus of awkward claims, so every stored
 * fact_withdrawals.claim_key still matches. Runs on PGLite, and on Postgres
 * when MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { runMigrations } from "../src/core/migrate.ts";
import { ENGINES, seedLegacy, type Db } from "./helpers/migration-120.ts";

const CORPUS: Array<string | null> = [
  "Lives in Paris",
  "LIVES IN PARIS",
  "  lives\tin\n\nparis  ",
  "lives in paris",
  "東京に住んでいる",
  "likes 🍣 and 🎸",
  "café au lait",
  "   ",
  "",
  null,
  "x ".repeat(50_000),
];

async function keys(db: Db, fn: string): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const c of CORPUS) {
    const r = await db.engine.query<{ k: string | null }>(`SELECT ${fn}($1::text) AS k`, [c]);
    out.push(r.rows[0]!.k);
  }
  return out;
}

for (const { name, open } of ENGINES) {
  describe(`claim key equivalence (${name})`, () => {
    let db: Db;
    let pre: Array<string | null>;

    beforeAll(async () => {
      db = await open();
      await seedLegacy(db.engine);
      pre = await keys(db, "memex_fact_claim_key");
      await runMigrations(db.engine);
    });
    afterAll(async () => {
      await db.close();
    });

    it("old = new = the pre-120 value = the inline expression", async () => {
      const inline: Array<string | null> = [];
      for (const c of CORPUS) {
        const r = await db.engine.query<{ k: string | null }>(
          `SELECT md5(lower(btrim(regexp_replace($1::text, '\\s+', ' ', 'g')))) AS k`,
          [c],
        );
        inline.push(r.rows[0]!.k);
      }
      expect(await keys(db, "memex_fact_claim_key")).toEqual(pre);
      expect(await keys(db, "memrain_fact_claim_key")).toEqual(pre);
      expect(inline).toEqual(pre);
      expect(pre.at(-2)).toBeNull();
    });

    it("stored withdrawal keys still match under the new function", async () => {
      const r = await db.engine.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM fact_withdrawals w
          WHERE w.claim_key = memrain_fact_claim_key('owns a boat')`,
      );
      expect(r.rows[0]!.n).toBe(1);
    });

    it("grows linearly on whitespace-heavy input", async () => {
      const time = async (text: string) => {
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          await db.engine.query("SELECT memrain_fact_claim_key($1) AS k", [text]);
          best = Math.min(best, performance.now() - t0);
        }
        return best;
      };
      const unit = " a\t \n";
      await time(unit.repeat(1000));
      const small = await time(unit.repeat(10_000));
      const large = await time(unit.repeat(100_000));
      // 10x the input; a quadratic scan would be ~100x.
      expect(large / Math.max(small, 0.5)).toBeLessThan(35);
    });
  });
}
