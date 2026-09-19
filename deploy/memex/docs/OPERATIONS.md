# memex — Operations

How to deploy, restart, observe, and recover.

## Deploy

```bash
# from your workstation:
git push origin main

# SSM into the EC2:
aws ssm start-session --target <your-instance-id> \
  --profile <your-profile> --region <your-region>

# inside the EC2 (only needed when using the SSH deploy-key mode;
# the default install clones via HTTPS):
export GIT_SSH_COMMAND="ssh -i /root/.ssh/<project>_deploy_key \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
cd /opt/<project> && git pull --ff-only
cd deploy && docker compose up -d --build memex
sleep 25
docker compose ps memex
docker compose logs --tail 25 memex
```

First boot pulls + builds; subsequent rebuilds are ~30 s warm.

## Health probes

```bash
# operational probe (the only HTTP route besides /mcp):
docker exec deploy-memex-1 wget -qO- http://127.0.0.1:18790/health
# → {"ok":true,"db":"postgres","version":"0.1.0",
#     "stats":{"documents":114,"chunks":244,"embeddings":244}}

# MCP smoke (proves tool dispatch over /mcp):
docker exec deploy-memex-1 sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"stats\"}}" \
    | wget -qO- --post-file=/dev/stdin --header=Content-Type:application/json http://127.0.0.1:18790/mcp
'

# self-diagnostics:
docker exec deploy-memex-1 bun run src/cli.ts doctor
# → 5/5 checks ok (config / engine / stats / index-spread / vault)

# vault-vs-index drift:
docker exec deploy-memex-1 bun run src/cli.ts integrity --vault /memory
```

## Local dev

```bash
cd deploy/memex
bun install
bun test               # 120 tests, ~140 s wall-clock
bun run src/cli.ts --help
```

To run against a fresh local PGLite (dev only — production uses RDS):

```bash
mkdir -p /tmp/memex-dev
HOME=/tmp/memex-dev bun run src/cli.ts init --pglite
HOME=/tmp/memex-dev bun run src/cli.ts serve --http --host 127.0.0.1 --port 18790
```

## Logs

```bash
docker compose logs --tail 50 memex
docker compose logs -f memex | grep -v healthcheck
```

Notable log lines to look for:
- `[memex] listening on http://0.0.0.0:18790 (MCP enabled)`
- `[code] boot sweep: scanned=N reindexed=M skipped=K parseErrors=0 errors=0`
- `[memex] starting cycle loop: every Ns, embed-stale at >Md`
- `[cycle] tick status=ok ...` (per-phase `status=ok|warn|FAIL`; `warn` =
  the phase completed but reported non-fatal issues, e.g. a transient embed
  error or a zero-chunk doc)

## Trigger a cycle manually

The cycle ticks automatically every `MEMEX_DREAM_INTERVAL_S` (6 h
default). To force a tick, restart the container — the first tick
fires after one full interval, OR drop interval and restart:

```bash
# one-shot via CLI (uses migrate-engine machinery; for actual cycle,
# the recipe runs in-daemon — restart memex to retrigger):
docker compose restart memex
```

For a one-shot manual run of any single phase, use the corresponding
operational command:

```bash
docker exec deploy-memex-1 bun run src/cli.ts extract
docker exec deploy-memex-1 bun run src/cli.ts orphans
docker exec deploy-memex-1 bun run src/cli.ts reconcile-links
```

## Eval harness

Quality regression check against `tests/eval/qrels.json`:

```bash
docker exec deploy-memex-1 bun run src/cli.ts eval
# computes recall@5 + MRR; exits 1 if mean recall@5 < 0.6
```

## Re-build the index from scratch

If something goes catastrophically wrong with the search index but
the underlying data (vault + memory) is intact:

```bash
# wipe the corpus tables in RDS
docker exec deploy-memex-1 bun -e "
  import postgres from 'postgres';
  const sql = postgres(process.env.MEMEX_POSTGRES_URL, { ssl: 'require' });
  await sql.unsafe('TRUNCATE entity_mentions, embeddings, chunks, entities, documents CASCADE').simple();
  console.log('truncated');
  await sql.end();
"

# trigger a full re-sweep
docker exec deploy-memex-1 bun run src/cli.ts reindex --all --vault /memory
```

Cost: re-embed of ~115 files ≈ a few cents (Titan v2, credit-eligible).
Time: ~5-10 min on t4g.medium.

## Re-build the index after RDS loss

Production storage is **RDS Postgres**. The index is fully derivable
from the source content under `/memory`, so an RDS wipe / restore is
recoverable in ~5-10 minutes:

```bash
# wipe the corpus tables in RDS (TRUNCATE cascades to embeddings + mentions)
docker exec deploy-memex-1 bun -e "
  import postgres from 'postgres';
  const sql = postgres(process.env.MEMEX_POSTGRES_URL, { ssl: 'require' });
  await sql.unsafe('TRUNCATE entity_mentions, embeddings, chunks, entities, documents CASCADE').simple();
  await sql.end();
"

# trigger a full re-sweep
docker exec deploy-memex-1 bun run src/cli.ts reindex --all --vault /memory
```

Cost: ~few cents (Titan v2 is credit-eligible). Time: ~5-10 min on
t4g.medium.

## Migrate to a fresh RDS in another account

Use `migrate-engine` to ferry data via a temporary local PGLite:

```bash
# 1) Old account: dump RDS into a local PGLite file
docker exec deploy-memex-1 bun run src/cli.ts \
  migrate-engine --from postgres --to pglite \
  --pglite-path /tmp/brain-snapshot.pglite

# 2) Copy the file off the EC2 (scp or via S3)

# 3) New account: provision RDS via terraform/rds.tf, then
docker exec -e MEMEX_POSTGRES_URL='<new-url>' deploy-memex-1 \
  bun run src/cli.ts migrate-engine --from pglite --to postgres \
  --pglite-path /tmp/brain-snapshot.pglite
```

The command applies migrations on the destination, then copies **every
public table** the two catalogs share, in foreign-key order. Generated
columns are skipped (the destination recomputes them), and columns are the
intersection of both sides. Values travel as text, and each batch runs with
`session_replication_role = replica`, so triggers and FK checks stay off and
no insert rewrites a copied row. The destination role therefore needs
superuser (`rds_superuser` on RDS); the run refuses up front otherwise.
Keyed tables upsert, so a re-run resumes an interrupted copy and makes rows
seeded by the destination's migrations equal to the source. Sequences are
advanced to the copied maximum. The source is only read.

Every table is then checked by row count and a content hash. The command
prints one JSON summary (`ok`, per-table `src`/`dst`/`srcHash`/`dstHash`/
`match`, `missing`, `failures`) on stdout and exits 1 on any mismatch,
missing table or failed table.

| Flag | Meaning |
|---|---|
| `--dry-run` | catalogs and row counts only, no writes |
| `--verify-only` | skip the copy; compare two existing databases |
| `--tables a,b` | restrict the copy and the check to these tables |
| `--to-pglite-path P` | destination path for a pglite→pglite copy (`--pglite-path` is the source) |

### Rollback rehearsal

Before a risky schema change, prove the way back on a scratch copy. The
live database is only read:

```bash
# Postgres -> PGLite (rehearsal copy), then check it again on its own
docker exec deploy-memex-1 bun run src/cli.ts migrate-engine \
  --from postgres --to pglite --pglite-path /tmp/rt-rehearsal.pglite
docker exec deploy-memex-1 bun run src/cli.ts migrate-engine --verify-only \
  --from postgres --to pglite --pglite-path /tmp/rt-rehearsal.pglite

# PGLite -> PGLite (a second hop that must match the first)
docker exec deploy-memex-1 bun run src/cli.ts migrate-engine \
  --from pglite --to pglite --pglite-path /tmp/rt-rehearsal.pglite \
  --to-pglite-path /tmp/rt-hop2.pglite

docker exec deploy-memex-1 rm -rf /tmp/rt-rehearsal.pglite /tmp/rt-hop2.pglite
```

A PGLite copy holds the whole brain in the process's WASM heap next to the
live server; watch free memory, and run it from a laptop through the SSM
tunnel if it is tight.

## Common failure modes

| Symptom | Cause / fix |
|---|---|
| `there is no unique or exclusion constraint matching the ON CONFLICT specification` | A migration / migrate-engine SQL uses `ON CONFLICT (col)` against a composite PK. Fix: `ON CONFLICT DO NOTHING` (bare). |
| `cannot find version 16.X for postgres` | RDS engine version pin in `terraform/rds.tf` not on this account. `aws rds describe-db-engine-versions --engine postgres` to pick a valid one. |
| Container restarting on boot | `docker compose logs memex --tail 50`. Likely: secret missing, RDS unreachable (SG egress 5432), or `MEMEX_POSTGRES_URL` not in env. |
| `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1` | Code is using inline `BEGIN`/`COMMIT` against postgres-js. Fix: route through `engine.transaction(fn)` instead. |
| Sweep OOM kills SSM agent | Instance too small. Production is t4g.medium; if you ever scale down, throttle via `MEMEX_SWEEP_DELAY_MS=200` and `MEMEX_SWEEP_MAX_FILES=200`. |

## Cost watch

| Item | Cost |
|---|---|
| t4g.medium on-demand | ~$13/mo |
| db.t4g.micro RDS Postgres + 20 GiB gp3 + 7-day backup | ~$15/mo |
| Bedrock Titan v2 embeddings | credit-eligible (≈ $0/mo for our volume) |
| Bedrock Claude Haiku (intent / expansion) | paid (per-query; heuristic cache skips most) |
| Cloudflare Tunnel | free (Zero Trust free tier) |
| Total stack | **~$28/mo** at light personal use |
