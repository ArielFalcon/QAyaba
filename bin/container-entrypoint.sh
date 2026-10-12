#!/bin/sh
# Root-only boot steps of the orchestrator container, then the service itself.
#
# The execution sandbox runs agent-influenced code as the unprivileged `sandbox` uid. What keeps that uid away from the
# orchestrator's secrets is file permissions, and they have to be right BEFORE the first run, so they are set here, at
# every boot, rather than trusted to what a volume was created with:
#   /app/data    0700  run history, auth material (session, client certificate), suite store, learning state
#   /app/config  0750  app configs and the API token (config/.api_token, 0600). A rw bind mount: only the mode changes,
#                      never the owner, so a Linux host's own user keeps its access.
#   mirrors      0711 root; each mirror 0750 root:root. The run opens the one mirror it executes in to the sandbox group
#                      for its length (mirror-access.ts) and closes it again.
# /proc/1/environ is root-only (0400) and so unreadable once a child has dropped to the sandbox uid; the smoke test
# (`npm run sandbox:smoke`) checks it against the running container.
set -eu

APP="${QA_APP_ROOT:-/app}"
MIRRORS="${MIRROR_DIR:-$APP/.mirrors}"

harden() {
  mode="$1"; path="$2"
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    chmod "$mode" "$path" || echo "[qa] WARNING: could not chmod $mode $path; the sandbox uid may be able to read it" >&2
  fi
}

harden 0700 "$APP/data"
harden 0750 "$APP/config"
harden 0600 "$APP/config/.api_token"

mkdir -p "$MIRRORS" 2>/dev/null || true
if [ -d "$MIRRORS" ] && [ ! -L "$MIRRORS" ]; then
  chmod 0711 "$MIRRORS" || echo "[qa] WARNING: could not close $MIRRORS" >&2
  for mirror in "$MIRRORS"/*/; do
    mirror="${mirror%/}"
    if [ -d "$mirror" ] && [ ! -L "$mirror" ]; then
      chmod 0750 "$mirror" || echo "[qa] WARNING: could not close mirror $mirror" >&2
      if [ "$(id -u)" = "0" ]; then chown root:root "$mirror" || echo "[qa] WARNING: could not hand mirror $mirror to root" >&2; fi
    fi
  done
fi

# The per-run work directories live under /tmp/qa-exec: traversable, not listable.
EXEC_ROOT="${QA_EXEC_ROOT:-/tmp/qa-exec}"
mkdir -p "$EXEC_ROOT" && chmod 0711 "$EXEC_ROOT"

# Egress filter: creates the chain and self-tests it as the sandbox uid. Never stops the boot: QA_EGRESS_MODE decides, per
# run, whether an unavailable filter ends the run (enforce) or only says so (warn).
if [ -x "$APP/bin/egress-init.sh" ]; then
  "$APP/bin/egress-init.sh" || echo "[qa] egress filter is NOT active (see above); runs that execute agent code follow QA_EGRESS_MODE=${QA_EGRESS_MODE:-enforce}" >&2
fi

exec "$@"
