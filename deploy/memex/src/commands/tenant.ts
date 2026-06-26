/**
 * `memex tenant <subcommand>` — provision tenant sources and JWT-subject grants.
 *
 * Subcommands:
 *   add <id> [--name D]
 *              register a tenant source (kind=other, path_prefix=tenant:<id>).
 *              Idempotent.
 *   grant <sub> --source <id> [--read <id1,id2,...>]
 *              upsert a source_grant row for the given JWT subject. Validates
 *              that source_id and every --read id exist before writing.
 *   list       JSON list of all source_grants.
 *   revoke <sub>
 *              delete the grant row for the given subject.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { registerSource } from "../core/sources.ts";
import {
  listGrants,
  upsertGrant,
  revokeGrant,
  validateGrantSourceIds,
} from "../core/tenant-grants.ts";

export type TenantSub = "add" | "grant" | "list" | "revoke";

export interface TenantCmdOptions {
  sub: TenantSub;
  /** For `add`: tenant source id. */
  id?: string;
  /** For `add`: optional display name stored as description. */
  name?: string;
  /** For `grant`/`revoke`: the JWT subject. */
  sub_jwt?: string;
  /** For `grant`: write source id. */
  source?: string;
  /** For `grant`: federated read ids (defaults to [source]). */
  read?: string[];
}

export async function runTenant(opts: TenantCmdOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const engine = storage.engine();
    switch (opts.sub) {
      case "add": {
        if (!opts.id) throw new Error("memex tenant add: <id> is required");
        const row = await registerSource(engine, {
          id: opts.id,
          kind: "other",
          pathPrefix: `tenant:${opts.id}`,
          description: opts.name ?? null,
        });
        console.log(JSON.stringify({ ok: true, source: row }, null, 2));
        return;
      }
      case "grant": {
        if (!opts.sub_jwt) throw new Error("memex tenant grant: <sub> is required");
        if (!opts.source) throw new Error("memex tenant grant: --source is required");
        const readIds = opts.read ?? [opts.source];
        const missing = await validateGrantSourceIds(engine, opts.source, readIds);
        if (missing.length > 0) {
          console.error(
            `memex tenant grant: unknown source id(s): ${missing.join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        const grant = await upsertGrant(engine, {
          sub: opts.sub_jwt,
          sourceId: opts.source,
          federatedRead: readIds,
        });
        console.log(JSON.stringify({ ok: true, grant }, null, 2));
        return;
      }
      case "list": {
        const grants = await listGrants(engine);
        console.log(
          JSON.stringify({ ok: true, count: grants.length, grants }, null, 2),
        );
        return;
      }
      case "revoke": {
        if (!opts.sub_jwt) throw new Error("memex tenant revoke: <sub> is required");
        const removed = await revokeGrant(engine, opts.sub_jwt);
        console.log(
          JSON.stringify({ ok: true, removed, sub: opts.sub_jwt }, null, 2),
        );
        return;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memex tenant: unknown subcommand '${_exhaustive}'`);
      }
    }
  } finally {
    await storage.close();
  }
}
