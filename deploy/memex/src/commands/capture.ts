/**
 * `memex capture [<text...>] [--stdin] [--file P] [--slug S] [--type T]
 *                [--source ID] [--title T]`
 * — one-command thought capture: turn a note into a page
 * and mirror it into search in a single shot.
 *
 * Content source (exactly one): inline positional text, `--stdin`, or
 * `--file <path>`. The page lands via the same putPage + search-mirror path
 * the MCP `page_put` op uses, so everything downstream (facts fence, links,
 * cycle) treats it like any other page.
 *
 * Default slug: `capture/<YYYY-MM-DD>-<kebab-of-first-line>`; default type:
 * `note`. Idempotent per slug — recapturing the same slug updates the page.
 */
import { readFileSync } from "node:fs";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { putPage, getPage } from "../core/pages.ts";
import { indexPageIntoSearch } from "../core/page-index.ts";

export interface CaptureCmdOptions {
  /** Inline note text (positional). */
  text?: string;
  /** Read the note body from stdin. */
  stdin?: boolean;
  /** Read the note body from a file. */
  file?: string;
  slug?: string;
  type?: string;
  sourceId?: string;
  title?: string;
  json?: boolean;
  configPath?: string;
  /** Participant slugs/names for the `event:` frontmatter block. */
  who?: string[];
  /** One-clause summary for the `event:` block. */
  what?: string;
  /** Location for the `event:` block. */
  where?: string;
  /** Event kind (meeting|call|…) for the `event:` block. */
  kind?: string;
  /** Depth-page slug this event came from, for the `event:` block. */
  depth?: string;
  /** Test seam — stdin reader. */
  readStdin?: () => Promise<string>;
  /** Test seam — deterministic embedder for the search mirror (no Bedrock). */
  embedFn?: (text: string) => Promise<number[]>;
}

/** Kebab a free-text line into a slug segment (bounded, filesystem-safe). */
export function captureSlugSegment(line: string): string {
  const kebab = line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return kebab.length > 0 ? kebab : "note";
}

/** Slug prefix for a capture type: diary/event route into the Life-Chronicle
 *  namespace so eligibility, the search boost, and the read-fence recognise
 *  them; everything else keeps the `capture/` inbox prefix. */
export function capturePrefix(type: string | undefined): string {
  if (type === "diary") return "life/diary";
  if (type === "event") return "life/events";
  return "capture";
}

export function defaultCaptureSlug(
  body: string,
  date: Date = new Date(),
  prefix = "capture",
): string {
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "note";
  return `${prefix}/${date.toISOString().slice(0, 10)}-${captureSlugSegment(firstLine)}`;
}

/** Assemble the `event:` frontmatter block from the declared flags. Only keys
 *  the user supplied are set (declared keys win per-key on merge); returns null
 *  when no event flag was given. */
export function buildEventBlock(
  opts: Pick<CaptureCmdOptions, "who" | "what" | "where" | "kind" | "depth">,
): Record<string, unknown> | null {
  const event: Record<string, unknown> = {};
  if (opts.who && opts.who.length > 0) event.who = opts.who;
  if (opts.what) event.what = opts.what;
  if (opts.where) event.where = opts.where;
  if (opts.kind) event.kind = opts.kind;
  if (opts.depth) event.depth = opts.depth;
  return Object.keys(event).length > 0 ? event : null;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runCapture(opts: CaptureCmdOptions): Promise<number> {
  const sources = [opts.text?.trim(), opts.stdin ? "stdin" : undefined, opts.file].filter(
    (s) => s !== undefined && s !== "",
  );
  if (sources.length !== 1) {
    console.error(
      "memex capture: provide the note exactly one way — inline text, --stdin, or --file <path>",
    );
    return 1;
  }

  let body: string;
  if (opts.file) {
    body = readFileSync(opts.file, "utf-8");
  } else if (opts.stdin) {
    body = await (opts.readStdin ?? readAllStdin)();
  } else {
    body = opts.text!;
  }
  body = body.replace(/\r\n/g, "\n").trim();
  if (body.length === 0) {
    console.error("memex capture: the note body is empty");
    return 1;
  }

  const slug = opts.slug ?? defaultCaptureSlug(body, new Date(), capturePrefix(opts.type));
  const event = buildEventBlock(opts);
  const storage = new Storage(loadConfig(opts.configPath));
  await storage.init();
  try {
    const put = await putPage(storage, {
      slug,
      markdown_body: body,
      written_by: "capture-cli",
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
      ...(event ? { compiled_truth: { event } } : {}),
    });

    // Mirror into search (best-effort — the DB-canonical page is the source
    // of truth; the cycle's mirror phase self-heals a failed projection).
    let mirrored = false;
    try {
      const page = await getPage(storage, slug);
      if (page) {
        await indexPageIntoSearch(
          storage,
          {
            slug: page.slug,
            title: page.title,
            markdown_body: page.markdown_body,
            content_hash: page.content_hash,
            source_id: page.source_id,
            compiled_truth: page.compiled_truth,
          },
          opts.embedFn ? { embedFn: opts.embedFn } : {},
        );
        mirrored = true;
      }
    } catch (e) {
      console.error(
        `[capture] search mirror failed (page saved):`,
        e instanceof Error ? e.message : e,
      );
    }

    const out = {
      ok: true,
      slug,
      created: put.created,
      changed: put.changed,
      version_n: put.version_n,
      mirrored,
      bytes: body.length,
    };
    if (opts.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(
        `Captured ${slug} (${put.created ? "created" : put.changed ? "updated" : "unchanged"}, ${body.length} bytes${mirrored ? ", searchable" : ""})`,
      );
    }
    return 0;
  } finally {
    await storage.close();
  }
}
