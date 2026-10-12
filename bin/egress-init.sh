#!/bin/sh
# Boot step of the egress filter: closes the sandbox uid's network at the kernel and proves it did.
#
# What this script does, as root, before the service starts:
#   1. creates the QA_EGRESS chains (nat + filter for IPv4, filter for IPv6) already CLOSED, and the jumps to them from
#      OUTPUT for the sandbox uid (`-m owner --uid-owner`). From this moment the uid reaches nothing: the chain's only rule
#      is a reject. The service opens exactly what a run declares, later, by rewriting the chain in one atomic commit
#      (qa-engine/src/shared-infrastructure/egress/iptables-ruleset.ts).
#   2. self-tests, AS the sandbox uid: a connection to a public IPv4 address, to a public IPv6 address and to the API on
#      loopback must all be refused at once (a reject answers immediately; a hang means the rule is not what it should be).
#   3. writes `ok`, or `unavailable: <why>`, to the status file the service reads (QA_EGRESS_STATUS_FILE,
#      default /run/qa-egress.status). The service never trusts a missing file.
# It exits non-zero when the filter is not in place; the entrypoint then lets the service start anyway, because
# QA_EGRESS_MODE decides per run whether that ends the run (enforce, the default) or only says so (warn).
#
# Needs CAP_NET_ADMIN and a kernel with xt_owner. Docker Desktop's LinuxKit kernel is expected to have both but this is
# decided by the self-test, never assumed.
set -u

UID_SANDBOX="${CODE_SANDBOX_UID:-1002}"
GID_SANDBOX="${CODE_SANDBOX_GID:-$UID_SANDBOX}"
STATUS="${QA_EGRESS_STATUS_FILE:-/run/qa-egress.status}"
API_PORT="${PORT:-458}"
CHAIN=QA_EGRESS

say() { echo "[qa] egress-init: $*" >&2; }

unavailable() {
  mkdir -p "$(dirname "$STATUS")" 2>/dev/null
  echo "unavailable: $1" > "$STATUS" 2>/dev/null || true
  say "filter NOT active: $1"
  exit 1
}

command -v iptables >/dev/null 2>&1 || unavailable "iptables is not installed in this image"
command -v ip6tables >/dev/null 2>&1 || unavailable "ip6tables is not installed in this image"
command -v iptables-restore >/dev/null 2>&1 || unavailable "iptables-restore is not installed in this image"
command -v setpriv >/dev/null 2>&1 || unavailable "setpriv (util-linux) is not installed, so the self-test cannot run as the sandbox uid"
id "$UID_SANDBOX" >/dev/null 2>&1 || unavailable "no user with uid $UID_SANDBOX (the sandbox user)"

# A previous boot may have left rules behind (restart policy keeps the netns): start from the closed chain.
mkchain() { # <bin> <table> <final reject>
  bin="$1"; table="$2"; reject="$3"
  "$bin" -w -t "$table" -N "$CHAIN" 2>/dev/null || "$bin" -w -t "$table" -F "$CHAIN" || return 1
  if [ -n "$reject" ]; then "$bin" -w -t "$table" -A "$CHAIN" -j REJECT --reject-with "$reject" || return 1; fi
  "$bin" -w -t "$table" -C OUTPUT -m owner --uid-owner "$UID_SANDBOX" -j "$CHAIN" 2>/dev/null \
    || "$bin" -w -t "$table" -I OUTPUT 1 -m owner --uid-owner "$UID_SANDBOX" -j "$CHAIN" || return 1
}

mkchain iptables nat "" || unavailable "could not create the nat chain (CAP_NET_ADMIN or the nat table is missing)"
mkchain iptables filter icmp-port-unreachable || unavailable "could not create the filter chain or match the owner (CAP_NET_ADMIN or xt_owner is missing)"
mkchain ip6tables filter icmp6-port-unreachable || unavailable "could not create the IPv6 filter chain"

# Self-test, as the sandbox uid. exit 0 = refused at once, 1 = connected (the filter is open), 2 = no answer in time.
probe() { # <host> <port>
  setpriv --reuid="$UID_SANDBOX" --regid="$GID_SANDBOX" --clear-groups node -e '
    const net = require("node:net");
    const [host, port] = process.argv.slice(1);
    const s = net.connect({ host, port: Number(port) });
    const t = setTimeout(() => process.exit(2), 2500);
    s.on("connect", () => process.exit(1));
    s.on("error", () => { clearTimeout(t); process.exit(0); });
  ' "$1" "$2"
}

for target in "1.1.1.1 443" "2606:4700:4700::1111 443" "127.0.0.1 $API_PORT"; do
  # shellcheck disable=SC2086
  probe $target
  case $? in
    0) ;;
    1) unavailable "the sandbox uid CONNECTED to ${target} — the owner match is not filtering" ;;
    *) unavailable "the sandbox uid got no immediate refusal from ${target} — the chain is not rejecting as designed" ;;
  esac
done

mkdir -p "$(dirname "$STATUS")" 2>/dev/null
echo ok > "$STATUS" || unavailable "could not write $STATUS"
say "filter active for uid $UID_SANDBOX (closed until a run declares origins)"
