/**
 * /health endpoint — daemon liveness + DB stats + active engine kind.
 *
 * Reports the engine's `kind` (`pglite` or `postgres`) so monitoring
 * can tell at a glance which backend is in use after a cutover.
 */
import type { Storage } from "../core/storage.ts";
import packageJson from "../../package.json" with { type: "json" };

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
    return Response.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }
}
