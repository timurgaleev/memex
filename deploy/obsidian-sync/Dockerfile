# obsidian-sync — wraps obsidian-headless@0.0.8 sync daemon
# Pinned to the validated release. Bump only after testing:
# the v0.x line is pre-1.0 and may break ob sync / ob login flag surface.
FROM node:22-alpine

# NOTE: alpine's `oath-toolkit` is a meta package — the `oathtool` binary
# lives in the `oath-toolkit-oathtool` sub-package. Installing only the
# meta gave us libs but no binary; obsidian-sync entrypoint then died on
# `oathtool: command not found` (exit 127).
RUN apk add --no-cache jq curl bash oath-toolkit oath-toolkit-oathtool

RUN npm install -g obsidian-headless@0.0.8

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
