/**
 * Same-origin check for state-changing POSTs.
 *
 * A cross-origin auto-submitting form is a "simple request": no preflight, so
 * CORS does not stop it reaching the handler. Anything that acts on a POST body
 * and has a security consequence therefore has to check where the POST came
 * from. `Sec-Fetch-Site` carries it directly in every current browser, and
 * `Origin` is the fallback; a non-browser caller sends neither and is allowed
 * through, which is fine because the attack needs a browser to be useful.
 */
export function isSameOriginPost(req: Request, url: URL): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (origin !== null) {
    try {
      if (new URL(origin).host !== url.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
