#!/bin/sh
# Can the corporate LLM gateway be reached from a container?
#
#   probe-gateway.sh [override.json]      default: /override.json
#
# Reads options.baseURL of every provider the override declares and requests <baseURL>/models WITHOUT
# credentials. Any HTTP status (200, 401, 403, ...) proves that DNS, routing, the proxy and TLS all
# work, which is all that is checked here; only a transport error counts as unreachable, and the fix
# for it is printed. Runs inside a container (qayaba.sh preflight): needs sh, node and curl.
#
# Exit status: 0 when every declared gateway answered (or none is declared), 1 otherwise.
override="${1:-/override.json}"

if [ ! -f "$override" ]; then
  echo "no slim/opencode.override.json: the LLM gateway is not declared, nothing to probe"
  exit 0
fi

urls="$(node -e '
  const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const p of Object.values(o.provider ?? {})) {
    const u = p && p.options && p.options.baseURL;
    if (typeof u === "string" && u) console.log(u);
  }' "$override")" || { echo "cannot read the providers of $override"; exit 1; }

if [ -z "$urls" ]; then
  echo "the override declares no provider baseURL: nothing to probe"
  exit 0
fi

errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT
status=0
for base in $urls; do
  url="${base%/}/models"
  code="$(curl -sS -o /dev/null -m "${PROBE_TIMEOUT_SECONDS:-15}" -w '%{http_code}' "$url" 2>"$errors")" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "$url  reachable (HTTP $code)"
    continue
  fi
  status=1
  echo "$url  UNREACHABLE (curl exit $rc): $(tr '\n' ' ' < "$errors")"
  case "$rc" in
    5|6) echo "  fix: the name does not resolve from a container; containers use the host/VPN DNS, so connect the VPN and check Docker Desktop's DNS" ;;
    7|28|56) echo "  fix: refused, filtered or timed out; check the proxy in ~/.docker/config.json and, if the gateway is internal and must bypass it, add its domain to EXTRA_NO_PROXY in slim/.env" ;;
    35|51|58|60|77|83) echo "  fix: TLS verification failed; run ./slim/qayaba.sh export-ca (every certificate of the chain) and rebuild" ;;
    *) echo "  fix: unexpected curl error; see the message above and the troubleshooting table in slim/README.md" ;;
  esac
done
exit "$status"
