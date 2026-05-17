# memex — Bun runtime, multi-stage build
# Base image: oven/bun:1.3.13-alpine (preferred).
# Fallback: oven/bun:1.3.13 (non-alpine) if the alpine tag is unavailable.
FROM oven/bun:1.3.13-alpine

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY templates/ ./templates/
# Tree-sitter grammar WASM blobs for the code chunkers. Vendored into
# the repo (deploy/memex/wasm/) so the container build doesn't depend
# on resolving them out of node_modules at runtime — keeps the boot
# path deterministic and bun build (future) traversal-free.
COPY wasm/ ./wasm/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Non-root: bun base image already provides uid 1000 (`bun`). Owning
# /app to bun lets the entrypoint write logs / cache files. The
# bind-mounted vault + workspace/memory paths are read-only and the
# bootstrap script `chown -R 1000:1000` the EFS vault/* + memex dir,
# so non-root reads work without per-file chmod gymnastics. Defence
# in depth: an RCE in the Bun process no longer lands as root, so a
# kernel bug or a host-mount oversight cannot escalate to the host
# AWS profile dir or IMDS without an additional privilege exploit.
RUN chown -R bun:bun /app

ENV NODE_ENV=production \
    AWS_REGION=eu-west-1 \
    AWS_PROFILE=default \
    MEMEX_HOST=0.0.0.0 \
    BRAIN_PORT=18790 \
    HOME=/home/bun

EXPOSE 18790

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:18790/health | grep -q '"ok":true' || exit 1

USER bun

ENTRYPOINT ["/app/entrypoint.sh"]
