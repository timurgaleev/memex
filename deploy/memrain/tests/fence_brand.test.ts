/**
 * Brand-aware fence detection: `memex:` fences written by earlier releases and
 * `memrain:` fences both parse, project, strip and edit the same way; a page
 * keeps whichever marker it already carries; a page carrying both brands of
 * one kind is refused everywhere (never projected, never wiped, never edited).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { indexDocument } from "../src/core/indexer.ts";
import {
  fenceBounds,
  fenceMarkers,
  hasFenceMarker,
  FENCE_BRANDS,
  type FenceBrand,
  type FenceKind,
} from "../src/core/fence-shared.ts";
import {
  parseFactsFence,
  renderFactsFence,
  stripFactsFence,
  FACTS_FENCE_BEGIN,
  LEGACY_FACTS_FENCE_BEGIN,
  type ParsedFact,
} from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import {
  parseTakesFence,
  renderTakesFence,
  stripTakesFence,
  supersedeRow,
  upsertTakeRow,
  TAKES_FENCE_BEGIN,
  LEGACY_TAKES_FENCE_BEGIN,
} from "../src/core/synthesis/takes-fence.ts";
import { syncTakesFromFence } from "../src/core/synthesis/takes-canon.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  delete process.env.MEMRAIN_FACTS_FENCE;
  tmp = mkdtempSync(join(tmpdir(), "memrain-fence-brand-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const FACTS: ParsedFact[] = [
  { rowNum: 1, claim: "Founded Acme", confidence: 1, active: true },
  { rowNum: 2, claim: "Lives in Lisbon", confidence: 0.9, active: true },
  { rowNum: 3, claim: "Moved to Berlin", confidence: 0.8, active: false },
];

function factsBody(brand: FenceBrand, facts: ParsedFact[] = FACTS): string {
  return `# Alice\n\nProse.\n\n## Facts\n${renderFactsFence(facts, brand)}\n`;
}

const TAKE_ROWS = [
  "| 1 | Strong founder | take | world | 0.8 | 2026-01 | notes |",
  "| 2 | Will ship in Q3 | bet | world | 0.6 | 2026-02 | notes |",
];

function takesBody(brand: FenceBrand, rows: string[] = TAKE_ROWS): string {
  const { begin, end } = fenceMarkers("takes", brand);
  return [
    "# Page",
    "",
    "## Takes",
    "",
    begin,
    "| # | claim | kind | who | weight | since | source |",
    "|---|-------|------|-----|--------|-------|--------|",
    ...rows,
    end,
    "",
  ].join("\n");
}

function markerCount(body: string, marker: string): number {
  return body.split(marker).length - 1;
}

async function factRows(slug: string) {
  const r = await storage.engine().query<{
    id: number;
    fact: string;
    row_num: number | null;
    source_markdown_slug: string | null;
    embedding: string | null;
  }>(
    `SELECT id, fact, row_num, source_markdown_slug, embedding::text AS embedding
       FROM entity_facts WHERE entity_slug = $1 ORDER BY row_num NULLS FIRST, id`,
    [slug],
  );
  return r.rows;
}

async function putAndReconcile(slug: string, body: string) {
  const r = await putPage(storage, { slug, type: "person", markdown_body: body });
  return reconcileFactsForPage(storage, slug, r.content_hash);
}

async function activeTakes(slug: string) {
  const r = await storage.engine().query<{ row_num: number; active: boolean }>(
    `SELECT row_num, active FROM synth_takes WHERE source_ref = $1 AND row_num IS NOT NULL ORDER BY row_num`,
    [slug],
  );
  return r.rows;
}

describe("fence-shared brand helpers", () => {
  it("builds the markers of every kind and brand", () => {
    expect(fenceMarkers("facts", "memex")).toEqual({
      begin: "<!--- memex:facts:begin -->",
      end: "<!--- memex:facts:end -->",
    });
    expect(fenceMarkers("takes", "memrain")).toEqual({
      begin: "<!--- memrain:takes:begin -->",
      end: "<!--- memrain:takes:end -->",
    });
    expect(FACTS_FENCE_BEGIN).toBe(fenceMarkers("facts", "memrain").begin);
    expect(LEGACY_FACTS_FENCE_BEGIN).toBe(fenceMarkers("facts", "memex").begin);
    expect(TAKES_FENCE_BEGIN).toBe(fenceMarkers("takes", "memrain").begin);
    expect(LEGACY_TAKES_FENCE_BEGIN).toBe(fenceMarkers("takes", "memex").begin);
  });

  it("picks the brand from the begin marker, per kind", () => {
    for (const kind of ["facts", "takes"] as FenceKind[]) {
      expect(fenceBounds("no fence here", kind)).toBeNull();
      for (const brand of FENCE_BRANDS) {
        const body = `x\n${fenceMarkers(kind, brand).begin}\n|a|\n${fenceMarkers(kind, brand).end}\n`;
        expect(fenceBounds(body, kind)).toEqual({ brand, ...fenceMarkers(kind, brand) });
        expect(hasFenceMarker(body, kind)).toBe(true);
      }
      const both = `${fenceMarkers(kind, "memex").begin}\n${fenceMarkers(kind, "memrain").begin}`;
      expect(fenceBounds(both, kind)).toEqual({ brand: "both" });
      expect(hasFenceMarker(both, kind)).toBe(true);
    }
    // Kinds do not bleed into each other.
    expect(fenceBounds(factsBody("memex"), "takes")).toBeNull();
    expect(fenceBounds(takesBody("memex"), "facts")).toBeNull();
  });
});

describe("gate/parse symmetry", () => {
  it("every gate agrees with its parser for both brands, none, and a bare marker token", () => {
    const cases: Array<{ body: string; fence: boolean }> = [
      { body: "# Plain page\n", fence: false },
      // The brand token without the full HTML comment is not a fence: neither
      // the gate nor the parser may treat it as one.
      { body: "mentions memex:takes:begin and memex:facts:begin inline\n", fence: false },
      { body: factsBody("memex") + takesBody("memex"), fence: true },
      { body: factsBody("memrain") + takesBody("memrain"), fence: true },
    ];
    for (const { body, fence } of cases) {
      expect(hasFenceMarker(body, "facts")).toBe(fence);
      expect(hasFenceMarker(body, "takes")).toBe(fence);
      expect(parseFactsFence(body).length > 0).toBe(fence);
      expect(parseTakesFence(body).takes.length > 0).toBe(fence);
      expect(stripFactsFence(body) !== body).toBe(fence);
      expect(stripTakesFence(body) !== body).toBe(fence);
    }
  });
});

describe("facts fence", () => {
  it("parses a legacy and a new fence to the same rows", () => {
    expect(parseFactsFence(factsBody("memex"))).toEqual(parseFactsFence(factsBody("memrain")));
    expect(parseFactsFence(factsBody("memex"))).toHaveLength(3);
  });

  it("renders new markers by default and the requested brand otherwise", () => {
    expect(renderFactsFence(FACTS).startsWith("<!--- memrain:facts:begin -->\n")).toBe(true);
    expect(renderFactsFence(FACTS).endsWith("\n<!--- memrain:facts:end -->")).toBe(true);
    expect(renderFactsFence(FACTS, "memex").startsWith("<!--- memex:facts:begin -->\n")).toBe(true);
  });

  it("refuses a body with both brands: no rows plus a warning", () => {
    const warnings: string[] = [];
    expect(parseFactsFence(factsBody("memex") + factsBody("memrain"), warnings)).toEqual([]);
    expect(warnings.some((w) => w.startsWith("FACTS_FENCE_MIXED"))).toBe(true);
  });

  it("strips every brand present", () => {
    const body = `${factsBody("memex")}\nmiddle prose\n${factsBody("memrain")}`;
    const stripped = stripFactsFence(body);
    expect(stripped).toContain("middle prose");
    expect(stripped).not.toContain(":facts:");
    expect(stripped).not.toContain("Founded Acme");
  });
});

describe("facts reconcile across brands", () => {
  it("projects a legacy fence to the same (row_num, fact) set as a new one", async () => {
    await putAndReconcile("people/legacy-a", factsBody("memex"));
    await putAndReconcile("people/new-a", factsBody("memrain"));
    const legacy = (await factRows("people/legacy-a")).map((f) => [f.row_num, f.fact]);
    const fresh = (await factRows("people/new-a")).map((f) => [f.row_num, f.fact]);
    expect(legacy).toEqual([[1, "Founded Acme"], [2, "Lives in Lisbon"]]);
    expect(fresh).toEqual(legacy);
  });

  it("re-putting a legacy fence keeps the row set and leaves non-fence facts untouched", async () => {
    const slug = "people/legacy-b";
    await addFact(storage, { entity_slug: slug, fact: "explicit fact" });
    const vec = `[${Array.from({ length: 1024 }, (_, i) => (i % 7) / 10).join(",")}]`;
    await storage.engine().query(
      `UPDATE entity_facts SET embedding = $1::vector WHERE entity_slug = $2 AND source_markdown_slug IS NULL`,
      [vec, slug],
    );
    const explicitBefore = (await factRows(slug)).filter((f) => f.source_markdown_slug === null);
    expect(explicitBefore).toHaveLength(1);
    expect(explicitBefore[0]!.embedding).not.toBeNull();

    await putAndReconcile(slug, factsBody("memex"));
    await putAndReconcile(slug, `${factsBody("memex")}\nAn unrelated prose edit.\n`);
    const after = await factRows(slug);
    expect(after.filter((f) => f.source_markdown_slug === slug).map((f) => [f.row_num, f.fact])).toEqual([
      [1, "Founded Acme"],
      [2, "Lives in Lisbon"],
    ]);
    expect(after.filter((f) => f.source_markdown_slug === null)).toEqual(explicitBefore);
  });

  it("a malformed legacy fence does not wipe the prior projection", async () => {
    const slug = "people/legacy-c";
    await putAndReconcile(slug, factsBody("memex"));
    const before = await factRows(slug);
    expect(before).toHaveLength(2);
    // Begin marker present, end marker gone: nothing parses.
    const broken = factsBody("memex").replace("<!--- memex:facts:end -->", "");
    expect(await putAndReconcile(slug, broken)).toEqual({ removed: 0, added: 0 });
    expect(await factRows(slug)).toEqual(before);
  });

  it("a page with both brands is skipped and no row changes", async () => {
    const slug = "people/mixed-a";
    await putAndReconcile(slug, factsBody("memex"));
    const before = await factRows(slug);
    const mixed = `${factsBody("memex")}\n${factsBody("memrain", [
      { rowNum: 9, claim: "Other claim", confidence: 1, active: true },
    ])}`;
    expect(await putAndReconcile(slug, mixed)).toEqual({
      removed: 0,
      added: 0,
      skipped: "mixed_fence_brands",
    });
    expect(await factRows(slug)).toEqual(before);
  });
});

describe("takes fence edits keep the page's marker", () => {
  const row = { claim: "New take", kind: "take", holder: "world", weight: 0.7, active: true };

  it("renders new markers by default and the requested brand otherwise", () => {
    const takes = parseTakesFence(takesBody("memex")).takes;
    const out = renderTakesFence(takes);
    expect(out.startsWith("<!--- memrain:takes:begin -->")).toBe(true);
    expect(out.endsWith("<!--- memrain:takes:end -->")).toBe(true);
    expect(renderTakesFence(takes, "memex").startsWith("<!--- memex:takes:begin -->")).toBe(true);
  });

  it("appends to a legacy fence: exactly one fence, still memex", () => {
    const { body, rowNum } = upsertTakeRow(takesBody("memex"), row);
    expect(rowNum).toBe(3);
    expect(markerCount(body, "<!--- memex:takes:begin -->")).toBe(1);
    expect(markerCount(body, "<!--- memex:takes:end -->")).toBe(1);
    expect(body).not.toContain("memrain:takes");
    expect(parseTakesFence(body).takes.map((t) => t.rowNum)).toEqual([1, 2, 3]);
  });

  it("appends to a new fence: exactly one fence, still memrain", () => {
    const { body } = upsertTakeRow(takesBody("memrain"), row);
    expect(markerCount(body, TAKES_FENCE_BEGIN)).toBe(1);
    expect(body).not.toContain("memex:takes");
  });

  it("creates a memrain: fence on a page without one", () => {
    const { body } = upsertTakeRow("# Page\n\nprose\n", row);
    expect(markerCount(body, "<!--- memrain:takes:begin -->")).toBe(1);
    expect(markerCount(body, "<!--- memrain:takes:end -->")).toBe(1);
    expect(body).not.toContain("memex:takes");
    expect(parseTakesFence(body).takes).toHaveLength(1);
  });

  it("supersedes a row on a legacy page and keeps the marker", () => {
    const { body, newRowNum } = supersedeRow(takesBody("memex"), 1, {
      claim: "Revised",
      kind: "take",
      holder: "world",
      weight: 0.5,
    });
    expect(newRowNum).toBe(3);
    expect(markerCount(body, "<!--- memex:takes:begin -->")).toBe(1);
    expect(body).not.toContain("memrain:takes");
    const takes = parseTakesFence(body).takes;
    expect(takes.find((t) => t.rowNum === 1)?.active).toBe(false);
    expect(takes.find((t) => t.rowNum === 3)?.claim).toBe("Revised");
  });

  it("refuses to parse, append or supersede on a page with both brands", () => {
    const mixed = takesBody("memex") + takesBody("memrain");
    const parsed = parseTakesFence(mixed);
    expect(parsed.takes).toEqual([]);
    expect(parsed.warnings.some((w) => w.startsWith("TAKES_FENCE_MIXED"))).toBe(true);
    expect(() => upsertTakeRow(mixed, row)).toThrow(/both memrain: and memex:/);
    expect(() =>
      supersedeRow(mixed, 1, { claim: "x", kind: "take", holder: "world", weight: 0.5 }),
    ).toThrow(/both memrain: and memex:/);
  });

  it("strips both brands", () => {
    const stripped = stripTakesFence(`${takesBody("memex")}\nmiddle\n${takesBody("memrain")}`);
    expect(stripped).toContain("middle");
    expect(stripped).not.toContain(":takes:");
    expect(stripped).not.toContain("Strong founder");
  });
});

describe("indexer strip", () => {
  it("keeps fences of both brands out of search chunks", async () => {
    const body = [
      "# Bob",
      "",
      "Bob runs the data platform team.",
      "",
      factsBody("memex", [{ rowNum: 1, claim: "LEGACY_FACT_SECRET", confidence: 1, active: true }]),
      takesBody("memrain", ["| 1 | NEW_TAKE_SECRET | take | world | 0.8 | 2026-01 | notes |"]),
    ].join("\n");
    await indexDocument(
      storage,
      { sourcePath: "/bob.md", text: body },
      { embedFn: (t: string) => Promise.resolve(deterministicEmbed(t)), inferFrontmatter: false },
    );
    const r = await storage.engine().query<{ content: string }>(
      `SELECT c.content FROM chunks c JOIN documents d ON c.document_id = d.id WHERE d.source_path = '/bob.md'`,
    );
    const chunks = r.rows.map((x) => x.content).join("\n");
    expect(chunks).toContain("data platform team");
    expect(chunks).not.toContain("LEGACY_FACT_SECRET");
    expect(chunks).not.toContain("NEW_TAKE_SECRET");
    expect(chunks).not.toContain(":facts:");
    expect(chunks).not.toContain(":takes:");
  });
});

describe("takes canon sync through page_put", () => {
  async function put(slug: string, body: string): Promise<void> {
    const r = await dispatchTool(storage, {
      name: "page_put",
      arguments: { slug, type: "note", markdown_body: body },
    });
    expect(r.isError ?? false).toBe(false);
  }

  it("a put on a legacy takes page syncs its takes", async () => {
    await put("notes/legacy-takes", takesBody("memex"));
    expect(await activeTakes("notes/legacy-takes")).toEqual([
      { row_num: 1, active: true },
      { row_num: 2, active: true },
    ]);
  });

  it("a put on a new takes page syncs its takes", async () => {
    await put("notes/new-takes", takesBody("memrain"));
    expect(await activeTakes("notes/new-takes")).toHaveLength(2);
  });

  it("a put on a mixed takes page leaves synth_takes.active unchanged", async () => {
    const slug = "notes/mixed-takes";
    await put(slug, takesBody("memex"));
    const before = await activeTakes(slug);
    expect(before.every((t) => t.active)).toBe(true);
    await put(slug, takesBody("memex") + takesBody("memrain", ["| 7 | Other | take | world | 0.5 | 2026-03 | n |"]));
    expect(await activeTakes(slug)).toEqual(before);
  });

  it("syncTakesFromFence on a mixed body upserts nothing and deactivates nothing", async () => {
    const slug = "notes/mixed-direct";
    await syncTakesFromFence(storage.engine(), slug, takesBody("memrain"));
    const before = await activeTakes(slug);
    const r = await syncTakesFromFence(
      storage.engine(),
      slug,
      takesBody("memrain") + takesBody("memex"),
    );
    expect(r.rowsUpserted).toBe(0);
    expect(r.rowsDeactivated).toBe(0);
    expect(r.warnings.some((w) => w.startsWith("TAKES_FENCE_MIXED"))).toBe(true);
    expect(await activeTakes(slug)).toEqual(before);
  });
});
