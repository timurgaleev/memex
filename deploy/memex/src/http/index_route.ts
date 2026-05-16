/**
 * POST /index — index a document.
 *
 * Body shape:
 *   { path: string }
 *     OR
 *   { sourcePath: string, text: string }
 *
 * Returns: { ok, documentId, chunks, embeddings }
 *
 * Path confinement (CRITICAL): `path` must resolve inside one of the
 * configured vault roots (MEMEX_VAULT_PATHS, default "/vault,/memory")
 * or the configured code roots (MEMEX_CODE_PATHS, default "/repo-source").
 * Without this gate, a request with MEMEX_PUBLIC_WRITE=1 could index
 * arbitrary host paths — /etc/passwd, /run/secrets/*, /home/bun/.aws/*
 * — and then read them back via /search.
 */
import type { Storage } from "../core/storage.ts";
import { indexFile, indexDocument } from "../core/indexer.ts";
import {
  isWithinAllowedRoot,
  PathGuardConfigError,
} from "../core/path_guard.ts";

interface IndexRequestByPath {
  path: string;
}
interface IndexRequestByText {
  sourcePath: string;
  text: string;
}
type IndexRequest = IndexRequestByPath | IndexRequestByText;

function isByPath(b: unknown): b is IndexRequestByPath {
  return (
    typeof b === "object" &&
    b !== null &&
    "path" in b &&
    typeof (b as IndexRequestByPath).path === "string"
  );
}
function isByText(b: unknown): b is IndexRequestByText {
  return (
    typeof b === "object" &&
    b !== null &&
    "sourcePath" in b &&
    "text" in b &&
    typeof (b as IndexRequestByText).sourcePath === "string" &&
    typeof (b as IndexRequestByText).text === "string"
  );
}

export async function handleIndex(
  storage: Storage,
  req: Request,
): Promise<Response> {
  let body: IndexRequest;
  try {
    body = (await req.json()) as IndexRequest;
  } catch {
    return Response.json(
      { ok: false, error: "request body must be valid JSON" },
      { status: 400 },
    );
  }

  try {
    let result;
    if (isByPath(body)) {
      let allowed: boolean;
      try {
        allowed = isWithinAllowedRoot(body.path);
      } catch (e) {
        if (e instanceof PathGuardConfigError) {
          return Response.json(
            { ok: false, error: e.message },
            { status: 503 },
          );
        }
        throw e;
      }
      if (!allowed) {
        return Response.json(
          {
            ok: false,
            error:
              "path is outside the configured MEMEX_VAULT_PATHS / " +
              "MEMEX_CODE_PATHS roots — refusing to index",
          },
          { status: 403 },
        );
      }
      result = await indexFile(storage, body.path);
    } else if (isByText(body)) {
      result = await indexDocument(storage, {
        sourcePath: body.sourcePath,
        text: body.text,
      });
    } else {
      return Response.json(
        {
          ok: false,
          error:
            "body must be { path } or { sourcePath, text }",
        },
        { status: 400 },
      );
    }
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
