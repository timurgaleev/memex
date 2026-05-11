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

# NOTE: deliberately runs as root (no USER directive). The container
# mounts vault and chat-agent workspace/memory read-only; those files
# may be owned by mixed uids that don't match the alpine `bun` user
# (uid 1000). Running as root reads them without host-side chmod
# gymnastics. The container is on the internal docker network only —
# no public surface — so the slight blast-radius cost is bounded.
ENV NODE_ENV=production \
    AWS_REGION=eu-west-1 \
    AWS_PROFILE=default \
    MEMEX_HOST=0.0.0.0 \
    BRAIN_PORT=18790

EXPOSE 18790

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:18790/health | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
