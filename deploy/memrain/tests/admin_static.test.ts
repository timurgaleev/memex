/**
 * Admin SPA static serve (increment C). Serves the built admin/dist at /admin
 * with an index.html SPA fallback. Relies on the dist produced by
 * `cd admin && bun run build` (run in CI/local before this test).
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveAdminStatic } from "../src/http/admin-static.ts";

const distExists = existsSync(fileURLToPath(new URL("../admin/dist/index.html", import.meta.url)));

describe.if(distExists)("serveAdminStatic (dist built)", () => {
  it("serves index.html for /admin/ and the bare /admin", async () => {
    for (const p of ["/admin/", "/admin"]) {
      const r = await serveAdminStatic(new URL(`http://h${p}`));
      expect(r?.status).toBe(200);
      expect(r!.headers.get("Content-Type")).toContain("text/html");
      expect(await r!.text()).toContain("<div id=\"root\">");
    }
  });

  it("falls back to index.html for an unknown SPA route (client-side routing)", async () => {
    const r = await serveAdminStatic(new URL("http://h/admin/dashboard"));
    expect(r?.status).toBe(200);
    expect(r!.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves a real built asset with the right mime", async () => {
    // Discover a hashed asset from the built index.html.
    const index = await (await serveAdminStatic(new URL("http://h/admin/")))!.text();
    const m = index.match(/\/admin\/(assets\/[^"']+\.css)/);
    expect(m).not.toBeNull();
    const r = await serveAdminStatic(new URL(`http://h/admin/${m![1]}`));
    expect(r?.status).toBe(200);
    expect(r!.headers.get("Content-Type")).toContain("text/css");
  });

  it("blocks path traversal out of dist", async () => {
    const r = await serveAdminStatic(new URL("http://h/admin/assets/..%2f..%2f..%2fetc%2fpasswd"));
    // Either a 403 (traversal guard) or the SPA fallback — never the host file.
    if (r && r.status !== 403) {
      expect(r.headers.get("Content-Type")).toContain("text/html");
    } else {
      expect(r?.status).toBe(403);
    }
  });
});

describe.if(!distExists)("serveAdminStatic (dist NOT built)", () => {
  it("returns null when the dist is absent (caller 404s)", async () => {
    expect(await serveAdminStatic(new URL("http://h/admin/"))).toBeNull();
  });
});
