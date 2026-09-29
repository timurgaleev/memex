/**
 * Same-origin check for state-changing POSTs.
 *
 * A cross-origin auto-submitting form is a "simple request": no preflight, so
 * CORS does not stop it reaching the handler. Anything that acts on a POST body
 * and has a security consequence therefore has to check where the POST came
 * from.
 *
 * `Origin` decides it. Browsers set it on every POST and page script cannot
 * forge it, so a match against the target host means the form was served by us.
 * `Sec-Fetch-Site` is only the fallback for a caller that sent no `Origin`:
 * it describes the whole navigation chain rather than the form's own origin, so
 * a same-origin form submitted inside a popup that some other site opened can
 * carry `cross-site` — as Claude's connector flow does. Reading it first turned
 * a legitimate OAuth submit into a refusal.
 *
 * A non-browser caller sends neither and is allowed through, which is fine
 * because the attack needs a browser to be useful. `Origin: null` (a sandboxed
 * frame, a redirect-originated POST) fails to parse and is refused.
 */
export function isSameOriginPost(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    try {
      const parsed = new URL(origin);
      // A browser sends a bare serialized origin. Anything carrying userinfo or
      // a path (`https://evil.example@brain.example/x`) parses to our host but
      // was never written by a browser, so refuse it rather than trust `host`.
      if (parsed.origin !== origin) return false;
      return parsed.host === url.host;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}
