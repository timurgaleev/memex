/**
 * Pull the JSON value out of a model's reply.
 *
 * Models wrap structured output in prose, in a ```json fence (sometimes never
 * closed), or after a `<thinking>` block. Every structured parser used to carry
 * its own copy of fence-regex-then-slice; this is that logic once, written with
 * `indexOf` and `slice` only, so it stays linear on any reply — several of the
 * regex versions it replaces measured quadratic on adversarial input.
 *
 * Returns the parsed value, or undefined when nothing parses. Shape checks stay
 * with the caller: this only finds the JSON.
 */

const FENCE = "```";

/** Drop every `<thinking>…</thinking>` block; an unclosed one runs to the end. */
function stripThinking(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("<thinking>", from);
    if (open === -1) return out + text.slice(from);
    out += text.slice(from, open);
    const close = text.indexOf("</thinking>", open);
    if (close === -1) return out;
    from = close + "</thinking>".length;
  }
}

/** The body of the first ``` fence (an optional `json` tag skipped); an
 *  unclosed fence runs to the end. Undefined when there is no fence. */
function fencedBody(text: string): string | undefined {
  const open = text.indexOf(FENCE);
  if (open === -1) return undefined;
  let start = open + FENCE.length;
  if (text.slice(start, start + 4).toLowerCase() === "json") start += 4;
  const close = text.indexOf(FENCE, start);
  return (close === -1 ? text.slice(start) : text.slice(start, close)).trim();
}

/** From the first opener: the rest of the text, then up to the last closer. */
function parseFrom(text: string, open: "{" | "["): unknown {
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    const end = text.lastIndexOf(open === "{" ? "}" : "]");
    if (end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * The first JSON object (`open` = "{") or array ("[") in a model reply: inside
 * its fence when it has one, else anywhere in the text.
 *
 * `strict` is for a gate that must fail closed: the reply is read as sent (no
 * thinking block dropped), and a fenced reply is read only inside its fence —
 * JSON placed after a fence of prose does not count.
 */
export function parseModelJson(raw: string, open: "{" | "[", opts: { strict?: boolean } = {}): unknown {
  const text = (opts.strict ? raw : stripThinking(raw)).trim();
  const fenced = fencedBody(text);
  if (fenced !== undefined) {
    const inFence = parseFrom(fenced, open);
    if (inFence !== undefined || opts.strict) return inFence;
  }
  return parseFrom(text, open);
}
