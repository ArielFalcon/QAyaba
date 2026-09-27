#!/usr/bin/env bash
# QAyaba slim — operator entry point (macOS bash 3.2 compatible; needs only docker).
#
#   ./slim/qayaba.sh preflight              probe what the network allows (host + a container)
#   ./slim/qayaba.sh export-ca              export the macOS System keychain CAs to slim/certs/
#   ./slim/qayaba.sh build                  build the image (all downloads happen here)
#   ./slim/qayaba.sh up | down | ps | logs [service]
#   ./slim/qayaba.sh check                  verify the running image is complete and offline-ready
#   ./slim/qayaba.sh onboard <app> <repo> [service-repo ...]
#                                           clone + index every repo and propose the stitcher boundaries
#   ./slim/qayaba.sh onboard-status <app>   | onboard-confirm <app>
#   ./slim/qayaba.sh run <app> <sha> [mode] [--guidance "..."]
#                                           one QA run (mode: diff | context | complete | exhaustive | manual)
#   ./slim/qayaba.sh tui                    terminal console (in a container)
#   ./slim/qayaba.sh tui-install            copy the native macOS console binary to slim/bin/qayaba
#   ./slim/qayaba.sh exports [app]          list exported publications (patch + MR/Issue bodies)
set -euo pipefail

SLIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SLIM_DIR/.." && pwd)"
COMPOSE=(docker compose -f "$SLIM_DIR/compose.yml" --project-directory "$SLIM_DIR")

die() { echo "qayaba: $*" >&2; exit 1; }

env_value() {
  # env_value KEY [DEFAULT] — reads KEY from slim/.env without sourcing it (values may hold
  # characters a shell would expand); DEFAULT when absent or empty.
  local v=""
  [ -f "$SLIM_DIR/.env" ] && v="$(grep -E "^$1=" "$SLIM_DIR/.env" | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${v:-${2:-}}"
}

api_token() {
  local t
  t="$(env_value QA_API_TOKEN)"
  if [ -z "$t" ] && [ -f "$ROOT_DIR/config/.api_token" ]; then t="$(cat "$ROOT_DIR/config/.api_token")"; fi
  [ -n "$t" ] || die "no API token yet (start the stack once: it is generated into config/.api_token)"
  printf '%s' "$t"
}

api() {
  # api METHOD PATH [JSON] — calls the orchestrator API from inside its container (loopback only).
  local method="$1" path="$2" body="${3:-}"
  local token
  token="$(api_token)"
  if [ -n "$body" ]; then
    "${COMPOSE[@]}" exec -T orchestrator curl -sS -X "$method" -H "Authorization: Bearer $token" \
      -H 'content-type: application/json' --data "$body" "http://localhost:8080$path"
  else
    "${COMPOSE[@]}" exec -T orchestrator curl -sS -X "$method" -H "Authorization: Bearer $token" "http://localhost:8080$path"
  fi
  echo
}

json_array() {
  # json_array a b c → ["a","b","c"]
  local out="" item
  for item in "$@"; do out="$out${out:+,}\"$item\""; done
  printf '[%s]' "$out"
}

preflight() {
  local mirror gitlab dev
  mirror="$(env_value NPM_REGISTRY)"; gitlab="$(env_value GIT_REMOTE_BASE)"; dev="${DEV_URL:-}"
  echo "== Docker"
  docker version --format 'client {{.Client.Version}} · server {{.Server.Version}} ({{.Server.Arch}})' || die "docker is not running"
  docker compose version
  echo "== Docker CLI proxy settings (~/.docker/config.json)"
  grep -A6 '"proxies"' "$HOME/.docker/config.json" 2>/dev/null || echo "none"
  echo "== From inside a container (000 = blocked or unresolvable)"
  docker run --rm -e "HOSTS=${mirror:-} ${gitlab:-} ${dev:-} https://opencode.ai https://github.com https://pypi.org https://registry.npmjs.org https://download.eclipse.org https://repo.maven.apache.org" \
    "$(env_value NODE_IMAGE node:24-bookworm)" sh -c '
      env | grep -i "_proxy=" | sed "s/=.*/=(set)/" || echo "no proxy variables"
      for u in $HOSTS; do printf "%-55s " "$u"; curl -sS -o /dev/null -m 10 -w "%{http_code}\n" "$u" 2>/dev/null || echo 000; done
      echo "== TLS issuer seen for registry.npmjs.org (a corporate issuer means TLS inspection → run export-ca)"
      echo | openssl s_client -connect registry.npmjs.org:443 -servername registry.npmjs.org 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "unreachable"'
}

export_ca() {
  command -v security >/dev/null || die "export-ca runs on macOS (the 'security' tool reads the keychain)"
  mkdir -p "$SLIM_DIR/certs"
  security find-certificate -a -p /Library/Keychains/System.keychain > "$SLIM_DIR/certs/corporate-ca.crt"
  echo "wrote $(grep -c 'BEGIN CERTIFICATE' "$SLIM_DIR/certs/corporate-ca.crt") certificate(s) to slim/certs/corporate-ca.crt"
}

check() {
  "${COMPOSE[@]}" exec -T agents sh -c '
    set -e
    echo "opencode $(opencode --version)"
    serena --version
    test -x /usr/local/bin/engram && echo "engram present"
    playwright-mcp --version 2>/dev/null || echo "playwright-mcp present"
    /usr/local/bin/pw-chromium --version
    test -x "$HOME/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin/typescript-language-server" && echo "serena: TypeScript LS provisioned"
    test -f /opt/jdtls/lombok.jar && echo "serena: Java LS (upstream JDTLS) provisioned"
    grep -q "pw-chromium" /root/.config/opencode/opencode.json && echo "opencode: playwright MCP pinned to the image Chromium"'
  "${COMPOSE[@]}" exec -T orchestrator sh -c '
    set -e
    codebase-memory-mcp --version 2>/dev/null || echo "codebase-memory-mcp present"
    node -e "require(\"better-sqlite3\"); console.log(\"better-sqlite3 ok\")"
    npm config get registry'
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  preflight) preflight ;;
  export-ca) export_ca ;;
  build)
    [ -f "$SLIM_DIR/.env" ] || die "copy slim/.env.example to slim/.env first"
    "${COMPOSE[@]}" build "$@" ;;
  up) "${COMPOSE[@]}" up -d "$@" && "${COMPOSE[@]}" ps ;;
  down) "${COMPOSE[@]}" down "$@" ;;
  ps) "${COMPOSE[@]}" ps ;;
  logs) "${COMPOSE[@]}" logs -f --tail 200 "$@" ;;
  check) check ;;
  onboard)
    [ $# -ge 2 ] || die "usage: onboard <app> <repo> [service-repo ...]"
    app="$1"; repo="$2"; shift 2
    api POST "/api/apps/$app/boundaries/propose" "{\"repo\":\"$repo\",\"services\":$(json_array "$@")}" ;;
  onboard-status) api GET "/api/apps/${1:?app}/boundaries/propose/status" ;;
  onboard-confirm) api POST "/api/apps/${1:?app}/boundaries/confirm" '{"confirm":true}' ;;
  run)
    [ $# -ge 2 ] || die "usage: run <app> <sha> [mode] [--guidance \"...\"]"
    app="$1"; sha="$2"; shift 2; mode="diff"
    if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then mode="$1"; shift; fi
    "${COMPOSE[@]}" exec orchestrator npm run qa -- --app "$app" --sha "$sha" --mode "$mode" "$@" ;;
  tui) "${COMPOSE[@]}" run --rm tui ;;
  tui-install)
    arch="$(uname -m)"; [ "$arch" = "arm64" ] || arch="amd64"
    mkdir -p "$SLIM_DIR/bin"
    cid="$(docker create "qayaba-slim:$(env_value QAYABA_SLIM_TAG local)")"
    docker cp "$cid:/opt/qayaba/tui/qayaba-darwin-$arch" "$SLIM_DIR/bin/qayaba" && docker rm "$cid" >/dev/null
    chmod +x "$SLIM_DIR/bin/qayaba"
    echo "installed slim/bin/qayaba — run it with: QA_HOST=localhost:$(env_value QAYABA_PORT 8080) QAYABA_ROOT=$ROOT_DIR slim/bin/qayaba" ;;
  exports) ls -1t "$SLIM_DIR/exports/${1:-}" 2>/dev/null || echo "no exports yet" ;;
  help|*) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
