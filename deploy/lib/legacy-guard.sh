# shellcheck shell=bash
# Refusals for a host that still carries a pre-rename (memex) install.
# Sourced by deploy/deploy.sh and scripts/bootstrap.sh, never executed.
#
# Each guard prints what it found and the command that fixes it on stderr,
# and returns 1 when the caller must stop; 0 means nothing legacy is in the
# way. None of them changes anything on the host. Bash 3.2 compatible.
#
# Why they exist: the renamed release uses new service, path and lock names.
# A legacy container left running next to the new one, a second checkout, or
# a new empty data directory beside the old one would put two servers on one
# database, or start the brain on an empty directory.

legacy_guard_log() { printf '[legacy-guard] %s\n' "$*" >&2; }

# legacy_guard_container -> 1 when a container of the legacy `memex` compose
# service (or one named deploy-memex-1) is running.
legacy_guard_container() {
  local by_label by_name found
  # A failed query must not read as "nothing running".
  if ! by_label="$(docker ps --filter 'label=com.docker.compose.service=memex' --format '{{.Names}}')" \
     || ! by_name="$(docker ps --filter 'name=^deploy-memex-1$' --format '{{.Names}}')"; then
    legacy_guard_log "REFUSED: cannot list running containers (is docker up?)"
    return 1
  fi
  found="$(printf '%s\n%s\n' "$by_label" "$by_name" | sed '/^$/d' | sort -u)"
  [ -z "$found" ] && return 0
  legacy_guard_log "REFUSED: a pre-rename container is running: $(printf '%s' "$found" | tr '\n' ' ')"
  legacy_guard_log "  stop it first (the image is kept): docker stop deploy-memex-1 && docker rm deploy-memex-1"
  return 1
}

# legacy_guard_data_dir EFS_DATA -> 1 when EFS_DATA/memex holds a config.json
# but EFS_DATA/memrain does not exist yet.
legacy_guard_data_dir() {
  local data="$1"
  if [ -f "${data}/memex/config.json" ] && [ ! -e "${data}/memrain" ]; then
    legacy_guard_log "REFUSED: ${data}/memex/config.json exists but ${data}/memrain does not"
    legacy_guard_log "  move the data directory (same filesystem) before continuing: mv '${data}/memex' '${data}/memrain'"
    return 1
  fi
  return 0
}

# legacy_guard_repo REPO_DIR [LEGACY_REPO] -> 1 when the legacy checkout
# (default /opt/memex) exists and REPO_DIR does not: cloning a second
# checkout would start a second app on the same database.
legacy_guard_repo() {
  local repo="$1" legacy="${2:-/opt/memex}"
  [ "$repo" = "$legacy" ] && return 0
  if [ -d "${legacy}/.git" ] && [ ! -e "$repo" ]; then
    legacy_guard_log "REFUSED: ${legacy} is a checkout but ${repo} does not exist"
    legacy_guard_log "  move it instead of cloning a second one: mv '${legacy}' '${repo}'"
    return 1
  fi
  return 0
}

# legacy_guard_mount PROJECT [LEGACY_MOUNT] -> 1 when the legacy EFS mount
# point (default /mnt/memex-efs) is mounted while PROJECT is not `memex`.
legacy_guard_mount() {
  local project="$1" legacy="${2:-/mnt/memex-efs}"
  [ "$project" = "memex" ] && return 0
  if mount 2>/dev/null | grep -q " on ${legacy} "; then
    legacy_guard_log "REFUSED: ${legacy} is still mounted, but this install is '${project}'"
    legacy_guard_log "  unmount it and move the fstab entry to the new mount point first (see UPGRADING)"
    return 1
  fi
  return 0
}
