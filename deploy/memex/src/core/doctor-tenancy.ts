/**
 * doctor-tenancy.ts — tenancy / auth doctor checks (reference parity).
 *
 * The two subsystems where a silent misconfig equals a cross-tenant leak or a
 * dead tenant get their own checks:
 *
 *   - federation-health   : per-source embed coverage on a multi-source brain.
 *     One tenant's embedding can break to 0% invisibly inside the whole-brain
 *     average. Fails on the severe fingerprint (coverage < 50% with a large
 *     corpus); warns below 95%. The reference also gates on sync lag — memex
 *     has no federated sync puller (sources are ingest channels), so document
 *     age is not a failure signal and lag is deliberately omitted.
 *   - oauth-client-health : a confidential OAuth client (auth method other
 *     than 'none') with a NULL/empty secret hash authenticates nobody — or,
 *     worse, whatever the verify path falls back to. Fails on any such row.
 *   - source-routing-health : registered sources with zero documents (writes
 *     silently collapsed elsewhere) and documents with NULL source_id
 *     (invisible to every scoped reader — the migration-071 class). Warns.
 *
 * All three are read-only, cheap, and swallow their own errors into a WARN
 * detail so a probe failure never crashes the doctor.
 */
import type { Engine } from "./engine/interface.ts";
import { collectPerSourceHealth } from "./source-health.ts";

/** Same shape as the doctor's internal Check. */
export interface TenancyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Per-source embed-coverage health on a multi-source brain. Single-source
 * short-circuits to ok. Severe coverage collapse fails; partial coverage and
 * a failed-job burst warn (ok:true with a WARN detail, the doctor's warn
 * idiom).
 */
export async function checkFederationHealth(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "federation-health";
  try {
    const srcCount = await engine.query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM sources`,
    );
    if (toInt(srcCount.rows[0]?.n) <= 1) {
      return { name, ok: true, detail: "single-source brain (no federation to check)" };
    }
    // The NULL-source '(unclassified)' bucket is source-routing-health's
    // problem — a reindex hint keyed on it would be bogus.
    const rows = (await collectPerSourceHealth(engine)).filter(
      (m) => m.source_id !== "(unclassified)",
    );
    const fails: string[] = [];
    const warns: string[] = [];
    for (const m of rows) {
      const pct = m.embed_coverage_pct * 100;
      if (pct < 50 && m.embeddable_chunks > 1000) {
        fails.push(
          `${m.source_id}: ${pct.toFixed(1)}% embed coverage ` +
            `(${m.embedded_chunks}/${m.embeddable_chunks}) — run 'memex reindex --source ${m.source_id}'`,
        );
        continue;
      }
      if (pct < 95 && m.embeddable_chunks > 100) {
        warns.push(
          `${m.source_id}: ${pct.toFixed(1)}% embed coverage ` +
            `(${m.embedded_chunks}/${m.embeddable_chunks})`,
        );
      }
    }
    // Failed-job burst is brain-level (jobs carry no source_id).
    const failedR = await engine.query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM jobs
        WHERE status = 'failed'
          AND (finished_at IS NULL OR finished_at >= NOW() - INTERVAL '24 hours')`,
    );
    const failed24h = toInt(failedR.rows[0]?.n);
    if (failed24h >= 3) {
      warns.push(`${failed24h} job failure(s) in 24h — check 'memex jobs list --status failed'`);
    }
    if (fails.length > 0) {
      return { name, ok: false, detail: `${fails.length} federation failure(s): ${fails.join("; ")}` };
    }
    if (warns.length > 0) {
      return { name, ok: true, detail: `WARN ${warns.length} federation warning(s): ${warns.join("; ")}` };
    }
    return { name, ok: true, detail: `${rows.length} source(s) healthy` };
  } catch (e) {
    return { name, ok: true, detail: `WARN check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Confidential OAuth clients (token_endpoint_auth_method other than 'none')
 * MUST carry a secret hash. Public PKCE clients intentionally store NULL —
 * a NULL hash on a confidential row is the silent-misconfig fingerprint.
 */
export async function checkOauthClientHealth(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "oauth-client-health";
  try {
    const r = await engine.query<{
      client_id: string;
      method: string | null;
      hash: string | null;
    }>(
      `SELECT client_id,
              token_endpoint_auth_method AS method,
              client_secret_hash AS hash
         FROM oauth_clients
        WHERE deleted_at IS NULL`,
    );
    if (r.rows.length === 0) {
      return { name, ok: true, detail: "no OAuth clients registered" };
    }
    const broken = r.rows.filter(
      (row) => row.method !== "none" && (row.hash === null || row.hash === ""),
    );
    if (broken.length > 0) {
      const ids = broken.map((b) => b.client_id).slice(0, 5).join(", ");
      return {
        name,
        ok: false,
        detail:
          `${broken.length} confidential OAuth client(s) have a NULL/empty secret hash: ${ids}` +
          (broken.length > 5 ? ` (+${broken.length - 5} more)` : "") +
          " — revoke and re-register each with 'memex auth register-client'",
      };
    }
    return { name, ok: true, detail: `${r.rows.length} OAuth client(s); all auth shapes consistent` };
  } catch (e) {
    return { name, ok: true, detail: `WARN check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Source-routing sanity: every non-default source should own documents, and
 * no document should sit at NULL source_id (a scoped read filters
 * `source_id = ANY(...)` and NULL matches nothing — those rows are invisible
 * to every tenant). Warn-level: a just-registered source is legitimately
 * empty mid-import.
 */
export async function checkSourceRoutingHealth(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "source-routing-health";
  try {
    const perSource = await engine.query<{ id: string; n: number | string }>(
      `SELECT s.id, COUNT(d.id)::int AS n
         FROM sources s
         LEFT JOIN documents d ON d.source_id = s.id
        WHERE s.id <> 'default'
        GROUP BY s.id
        ORDER BY s.id`,
    );
    if (perSource.rows.length === 0) {
      return { name, ok: true, detail: "single-source brain (no routing to check)" };
    }
    const warns: string[] = [];
    const empty = perSource.rows.filter((r) => toInt(r.n) === 0).map((r) => r.id);
    if (empty.length > 0) {
      warns.push(
        `${empty.length} source(s) have zero documents: ${empty.join(", ")} — ` +
          "writes may have silently fallen to another source; verify the ingest path",
      );
    }
    const nullDocs = await engine.query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM documents WHERE source_id IS NULL`,
    );
    const orphaned = toInt(nullDocs.rows[0]?.n);
    if (orphaned > 0) {
      warns.push(
        `${orphaned} document(s) have NULL source_id — invisible to every scoped reader; ` +
          "backfill by ingest path (see migration 071)",
      );
    }
    if (warns.length > 0) {
      return { name, ok: true, detail: `WARN ${warns.join("; ")}` };
    }
    return {
      name,
      ok: true,
      detail: `${perSource.rows.length} non-default source(s); all populated, no NULL-source documents`,
    };
  } catch (e) {
    return { name, ok: true, detail: `WARN check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
