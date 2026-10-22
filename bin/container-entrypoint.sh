#!/bin/sh
# Root-only boot steps of the orchestrator container, then the service itself.
#
# The execution sandbox runs agent-influenced code as the unprivileged `sandbox` uid. What keeps that uid away from the
# orchestrator's secrets, code and config is file permissions, and they have to be right BEFORE the first run, so they are set
# here, at every boot, rather than trusted to what a volume was created with:
#   /app/data    0700  run history, the API token (data/.api_token, 0600), auth material (session, client certificate),
#                      suite store, learning state
#   /app/.host   0700  the parent of the host's config folder (/app/config is a link to .host/config). A host bind mount may
#                      sit on a filesystem that does not enforce permissions (Docker Desktop's file sharing grants every uid
#                      what it asks), but the lookup of a path is checked by the filesystem of each directory on the way, and
#                      this one is the image's own: the sandbox uid cannot reach the configs behind it on any host.
#   /app/config  0750  app configs. A rw bind mount: only the mode changes, never the owner, so a Linux host's own user keeps
#                      its access.
#   /app/.codebase-memory (CBM_CACHE_DIR)  0700  the code graph of every indexed repo: the structure of repos the sandbox uid
#                      must not read (the volume is root-owned, but a volume's root is created 0755)
#   mirrors      0711 root; each mirror 0750 root:root. The run opens the one mirror it executes in to the sandbox group
#                      for its length (mirror-access.ts) and closes it again.
# /proc/1/environ is root-only (0400) and so unreadable once a child has dropped to the sandbox uid.
#
# Then the modes are PROVEN, not assumed: src/server/file-boundary-check.ts tries, as the sandbox uid, to read the secrets,
# list the closed directories and write the app root, every mount under it and the orchestrator's code and config, and leaves
# `ok` or `breach: <what>` in QA_FILE_BOUNDARY_STATUS_FILE. A breach (or no status at all) makes the service refuse agent code
# under QA_EXEC_SANDBOX=required (E-SANDBOX) and /api/health report the sandbox degraded. The smoke test
# (`npm run sandbox:smoke`) checks the same boundary from inside a real run.
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
harden 0600 "$APP/data/.api_token"
harden 0700 "$APP/.host"
harden 0750 "$APP/.host/config"
harden 0750 "$APP/config"
# An earlier version kept the API token here; the service removes it at its start (its value is retired, not moved).
harden 0600 "$APP/config/.api_token"
# Every volume the orchestrator mounts: qa-data (/app/data, above), the mirrors (below), the code graph (here), and the bind-mounted
# config (above). The dev override's bind mounts (src, qa-engine, scripts, web, the package files) hold the orchestrator's own code,
# which is no secret, and are read-only: a read-only mount is refused by the kernel whatever the filesystem below it enforces.
harden 0700 "${CBM_CACHE_DIR:-$APP/.codebase-memory}"

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

# The TypeScript loader (tsx) caches its transforms in <tmp>/tsx-<euid> and runs what it finds there without validating it. The
# temporary directory is writable by the sandbox uid and survives a restart of the container, so what agent code planted in
# its own cache is removed before anything of ours starts. (The boot check's probing child runs no loader at all.)
SANDBOX_UID="${CODE_SANDBOX_UID:-1002}"
rm -rf "${TMPDIR:-/tmp}/tsx-$SANDBOX_UID"

# File boundary: proves, as the sandbox uid, that the modes above hold on this host's filesystems. A stale status from an earlier
# boot of the same container is removed first, so a check that does not run leaves no status, which the service never trusts.
FILE_BOUNDARY_STATUS="${QA_FILE_BOUNDARY_STATUS_FILE:-/run/qa-file-boundary.status}"
rm -f "$FILE_BOUNDARY_STATUS"
if [ -f "$APP/src/server/file-boundary-check.ts" ] && [ -x "$APP/node_modules/.bin/tsx" ]; then
  (cd "$APP" && QAYABA_ROOT="$APP" "$APP/node_modules/.bin/tsx" src/server/file-boundary-check.ts) \
    || echo "[qa] the file boundary does NOT hold (see above); runs that execute agent code follow QA_EXEC_SANDBOX=${QA_EXEC_SANDBOX:-required}" >&2
fi

# Egress filter: creates the chain and self-tests it as the sandbox uid. Never stops the boot: QA_EGRESS_MODE decides, per
# run, whether an unavailable filter ends the run (enforce) or only says so (warn).
if [ -x "$APP/bin/egress-init.sh" ]; then
  "$APP/bin/egress-init.sh" || echo "[qa] egress filter is NOT active (see above); runs that execute agent code follow QA_EGRESS_MODE=${QA_EGRESS_MODE:-enforce}" >&2
fi

exec "$@"
