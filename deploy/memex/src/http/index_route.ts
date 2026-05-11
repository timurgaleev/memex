/**
 * POST /index — index a document.
 *
 * Body shape:
 *   { path: string }
 *     OR
 *   { sourcePath: string, text: string }
 *
 * Returns: { ok, documentId, chunks, embeddings }
 */
import type { Storage } from "../core/storage.ts";
import { indexFile, indexDocument } from "../core/indexer.ts";

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
