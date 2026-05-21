# openclaw — chat agent container (wraps npm openclaw@<pinned>)
FROM node:22-alpine

# Runtime deps:
# - python3/py3-requests/jq/curl/bash — used by ha/gcal helper scripts
# - aws-cli — helpers fetch creds from Secrets Manager via the EC2 IAM role
# - git — openclaw's plugin runtime spawns `git` when staging some npm
#   tarballs (those that ship as `git+https://…`). Without it, every
#   embedded-agent Telegram message died with `npm error code ENOENT,
#   syscall spawn git`.
RUN apk add --no-cache python3 py3-requests jq curl bash aws-cli git

WORKDIR /app

ARG OPENCLAW_VERSION=2026.4.29
RUN npm install -g openclaw@${OPENCLAW_VERSION}

COPY config.template.json /app/config.template.json
COPY entrypoint.sh /app/entrypoint.sh
COPY helpers/ /opt/memex/bin/

RUN chmod +x /app/entrypoint.sh /opt/memex/bin/*

ENV NODE_ENV=production \
    AWS_REGION=eu-west-1 \
    AWS_PROFILE=default \
    NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache \
    OPENCLAW_NO_RESPAWN=1 \
    PATH="/opt/memex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:18789/healthz || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
