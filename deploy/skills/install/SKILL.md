---
name: install
version: 1.0.0
description: |
  Deprecated pointer. Installation is handled by the setup skill; this entry
  exists only to route legacy "install" phrasing to it.
triggers:
  - "install"
mutating: false
---

# Install (Deprecated)

This skill has been replaced by the **setup** skill. See `skills/setup/SKILL.md`.

The setup skill provides:
- Server provisioning and connection checks
- Non-interactive first-run configuration
- Agent-instructions auto-injection (upgrade-safe)
- First index and health verification (`memex doctor`)
