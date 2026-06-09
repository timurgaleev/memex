/**
 * /health endpoint — daemon liveness + DB stats + active engine kind.
 *
 * Reports the engine's `kind` (`pglite` or `postgres`) so monitoring
 * can tell at a glance which backend is in use after a cutover.
 */
import type { Storage } from "../core/storage.ts";
import packageJson from "../../package.json" with { type: "json" };
import { publicSafeErrorMessage } from "../core/public_redaction.ts";

export async function handleHealth(storage: Storage): Promise<Response> {
  try {
    const stats = await storage.stats();
    return Response.json({
      ok: true,
      db: storage.engine().kind,
      version: packageJson.version,
      stats,
    });
  } catch (e) {
    // /health is unauthenticated and internet-reachable — never echo the
    // raw exception (it would leak the DSN host / Postgres internals on a
    // DB outage). Log the detail server-side; return a generic message.
    return Response.json(
      {
        ok: false,
        error: publicSafeErrorMessage(e, true),
      },
      { status: 503 },
    );
  }
}
