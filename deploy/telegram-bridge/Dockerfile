# telegram-bridge — always-on two-way Telegram surface.
# Pure stdlib Python; the only extras are aws-cli (Bedrock invoke) and
# the existing gcal/ha helpers (used as subprocesses for command surfaces).
#
# Build context: deploy/ (so we can COPY both telegram-bridge/* and
# helpers/* from a single context). See docker-compose.yml for the
# build invocation.
FROM python:3.12-alpine

# Runtime deps:
# - bash + curl + jq + python3 — required by the gcal/ha helpers.
# - aws-cli — Bedrock invoke + Secrets Manager read via the EC2 IAM role.
# - py3-requests — the gcal helper imports `requests` via its shebang env.
RUN apk add --no-cache bash curl jq aws-cli py3-requests \
 && adduser -D -u 10001 -h /home/bridge bridge

WORKDIR /app

# Helper CLIs used by the bridge's command surface (/today, /weather,
# etc.). They fetch their own creds from Secrets Manager via the EC2
# IAM role, so the bridge just shells out.
COPY helpers/ /opt/memex/bin/

COPY telegram-bridge/main.py /app/main.py
COPY telegram-bridge/entrypoint.sh /app/entrypoint.sh

# State + helper-bin ownership pinned to the non-root user so the
# daemon does not need root to write `state.json` or exec the helpers.
RUN chmod +x /opt/memex/bin/* /app/entrypoint.sh /app/main.py \
 && mkdir -p /var/lib/memex-bridge /home/bridge/.aws \
 && chown -R bridge:bridge /var/lib/memex-bridge /home/bridge /app

ENV PYTHONUNBUFFERED=1 \
    AWS_REGION=eu-west-1 \
    SECRETS_PREFIX=memex \
    MEMEX_URL=http://memex:18790 \
    HOME=/home/bridge

# Healthcheck: a positive liveness signal. Daemon is healthy only if
# `main.py` is still in the process table. `start_period: 60s` in the
# compose service gives the entrypoint room to validate AWS access.
HEALTHCHECK --interval=60s --timeout=5s --retries=3 --start-period=60s \
  CMD pgrep -f /app/main.py >/dev/null || exit 1

USER bridge

ENTRYPOINT ["/app/entrypoint.sh"]
