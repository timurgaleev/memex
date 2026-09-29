/**
 * The `since → until` range split must stay linear in cell length.
 *
 * `a` + a long space run + `b` is the adversarial shape for the old spelling,
 * `/^(.+?)\s*(?:→|->)\s*(.+)$/`: `.` accepts whitespace, so for every length of
 * the lazy left side the `\s*` re-walked the same run looking for an arrow that
 * is not there. Measured through `parseTakesFence` at 7.9 ms for a 4 K cell,
 * 32.0 ms for 8 K, 129.9 ms for 16 K and 520.6 ms for 32 K — squaring cleanly,
 * which extrapolates to about nine minutes on a 1 MB page. The input is a page
 * body someone writes, and nothing caps it on this path.
 *
 * The fix deletes the two `\s*`, which the runs on either side already subsume,
 * so the accepted language is unchanged and the whitespace they used to keep
 * out of the captures is removed by the `.trim()` the parser already applied.
 * The last case here pins that equivalence down.
 *
 * The ceiling is deliberately loose. Linear runs this in single-digit
 * milliseconds; quadratic needs minutes. A slow CI box cannot manufacture a
 * miss that large.
 */
import { describe, expect, it } from "bun:test";
import {
  parseTakesFence,
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from "../src/core/synthesis/takes-fence.ts";

const CEILING_MS = 15_000;

const withSinceCell = (cell: string): string =>
  [
    TAKES_FENCE_BEGIN,
    "| row_num | claim | kind | holder | weight | since | source |",
    "|---|---|---|---|---|---|---|",
    `| 1 | a claim | fact | world | 0.5 | ${cell} | s |`,
    TAKES_FENCE_END,
  ].join("\n");

describe("takes fence since-cell cost", () => {
  it("stays linear on a 1 MB whitespace run with no arrow", () => {
    const cell = `a${" ".repeat(1_000_000)}b`;
    const body = withSinceCell(cell);

    const started = performance.now();
    const { takes } = parseTakesFence(body);
    const elapsed = performance.now() - started;

    // No arrow anywhere: the whole cell stays as `since`, which is the
    // assertion that the split really was attempted and failed.
    expect(takes).toHaveLength(1);
    expect(takes[0]?.sinceDate).toBe(cell);
    expect(takes[0]?.untilDate).toBeUndefined();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("stays linear when the run ends on an arrow that closes nothing", () => {
    // The costlier half: every left-side length finds an arrow candidate at the
    // end of the run, and only then does the right side come up empty.
    const cell = `a${" ".repeat(500_000)}→`;

    const started = performance.now();
    const { takes } = parseTakesFence(withSinceCell(cell));
    const elapsed = performance.now() - started;

    expect(takes[0]?.sinceDate).toBe(cell);
    expect(takes[0]?.untilDate).toBeUndefined();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("still splits both range spellings and trims the sides", () => {
    const split = (cell: string) => {
      const t = parseTakesFence(withSinceCell(cell)).takes[0];
      return [t?.sinceDate, t?.untilDate];
    };
    expect(split("2022-01 → 2026-06")).toEqual(["2022-01", "2026-06"]);
    expect(split("2022-01 -> 2026-06")).toEqual(["2022-01", "2026-06"]);
    expect(split("2022-01→2026-06")).toEqual(["2022-01", "2026-06"]);
    expect(split("2022-01   →   2026-06")).toEqual(["2022-01", "2026-06"]);
    // Later arrows belong to the right-hand side, as before.
    expect(split("2022 → 2023 → 2024")).toEqual(["2022", "2023 → 2024"]);
    // A one-sided arrow is not a range — the cell is kept whole.
    expect(split("2022-01")).toEqual(["2022-01", undefined]);
    expect(split("2022-01 →")).toEqual(["2022-01 →", undefined]);
    expect(split("→ 2026-06")).toEqual(["→ 2026-06", undefined]);
  });
});
