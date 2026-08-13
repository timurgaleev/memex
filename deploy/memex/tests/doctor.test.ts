/**
 * Doctor smoke — runs against a fresh PGLite + a config in tmp dir, so
 * it never reaches Bedrock or the live brain. Captures stdout, parses
 * the JSON report, asserts the expected check shape.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, engineCheckDetail } from "../src/commands/doctor.ts";
import { KNOWN_CHECK_NAMES } from "../src/core/doctor-categories.ts";
import { VERSION } from "../src/version.ts";
import packageJson from "../package.json" with { type: "json" };

const tmp = mkdtempSync(join(tmpdir(), "memex-doctor-test-"));
const cfgDir = join(tmp, ".memex");
const dbPath = join(cfgDir, "brain.pglite");
const cfgPath = join(cfgDir, "config.json");

const originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: dbPath },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  // Unset any MEMEX_VAULT_PATH from the parent env so the vault check
  // stays in its "not configured" branch (we pass configPath explicitly
  // because os.homedir() caches at process start in Bun).
  originalEnv.MEMEX_VAULT_PATH = process.env.MEMEX_VAULT_PATH;
  delete process.env.MEMEX_VAULT_PATH;
});

afterAll(() => {
  // Restore env we mutated.
  if (originalEnv.MEMEX_VAULT_PATH !== undefined) {
    process.env.MEMEX_VAULT_PATH = originalEnv.MEMEX_VAULT_PATH;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("doctor", () => {
  it("reports ok on a freshly initialised pglite + no vault", async () => {
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    process.exitCode = 0;
    try {
      await runDoctor({ configPath: cfgPath });
    } finally {
      console.log = origLog;
    }

    const out = captured.join("\n");
    const parsed = JSON.parse(out) as {
      ok: boolean;
      version: string;
      checks: { name: string; ok: boolean; detail?: string; category: string }[];
      summary: {
        by_category: Record<string, { ok: number; fail: number }>;
        ranked_failures: { name: string; tier: string; downstream_of?: string }[];
      };
    };
    if (!parsed.ok) {
      // Surface which check failed when the assertion below fires.
      console.error("doctor failure detail:", JSON.stringify(parsed, null, 2));
    }
    expect(parsed.ok).toBe(true);
    // The BUILD stamp, not package.json — which is pinned at 0.1.0, so the
    // old `\d+.\d+.\d+` assertion passed on a constant that could never
    // change. Unstamped in a test process, the honest answer is "dev".
    expect(parsed.version).toBe(VERSION);
    expect(parsed.version).not.toBe(packageJson.version);
    const names = parsed.checks.map((c) => c.name).sort();
    expect(names).toEqual([
      "chronicle-projection-health",
      "chunker-version-lag",
      "code-grammars",
      "config",
      "contradiction-trend",
      "cycle-freshness",
      "duplicate-pages",
      "embedding-width",
      "eval-trend",
      "federation-health",
      "index-spread",
      "invalid-indexes",
      "links-extraction-lag",
      "oauth-client-health",
      "pglite",
      "queue-health",
      "schema-version",
      "source-health",
      "source-routing-health",
      "stale-locks",
      "stats",
      "vault",
    ]);
    // The eval-trend check is informational (ok) and reports the not-yet-run
    // state on a fresh brain where the probe has never appended a snapshot.
    const evalTrend = parsed.checks.find((c) => c.name === "eval-trend")!;
    expect(evalTrend.ok).toBe(true);
    expect(evalTrend.detail).toMatch(/has not run yet/);
    expect(process.exitCode).toBe(0);

    // Every check carries a category, and — the DRIFT GUARD — every name the
    // doctor actually emits is in the categorization single-source-of-truth
    // (so a future check added without categorizing it fails here).
    for (const c of parsed.checks) {
      expect(["brain", "ops", "meta"]).toContain(c.category);
      expect(KNOWN_CHECK_NAMES.has(c.name)).toBe(true);
    }
    // Healthy run → no ranked failures; category rollup present.
    expect(parsed.summary.ranked_failures).toEqual([]);
    expect(parsed.summary.by_category.brain).toBeDefined();
    expect(parsed.summary.by_category.ops.ok).toBeGreaterThan(0);
  });
});

describe("doctor engine check detail", () => {
  it("names the data dir on pglite and the engine kind otherwise", async () => {
    // `detail: config.database.path` read `path` off the config UNION. It only
    // exists on the pglite variant, so on the postgres brain that actually runs
    // in production the field serialised as undefined and vanished from the
    // report — the one check whose whole job is naming the engine said nothing
    // about it. The catch path a few lines below always narrowed correctly.
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      await runDoctor({ configPath: cfgPath });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(captured.join("\n")) as {
      checks: { name: string; detail?: string }[];
    };
    const engine = parsed.checks.find((c) => c.name === "pglite");
    expect(engine?.detail).toBe(dbPath);
  });

  // Driving runDoctor can only ever exercise the pglite side without a live
  // postgres — and the postgres side is where the bug was. Pin both variants
  // on the pure function instead, so the branch is observable at all.
  it("names the engine kind on a postgres config", () => {
    expect(engineCheckDetail({ type: "pglite", path: "/tmp/brain.pglite" })).toBe(
      "/tmp/brain.pglite",
    );
    expect(engineCheckDetail({ type: "postgres" })).toBe("engine=postgres");
    expect(
      engineCheckDetail({ type: "postgres", url: "postgres://host/db" }),
    ).toBe("engine=postgres");
  });
});
