#!/usr/bin/env bash
# QAyaba slim — operator entry point (macOS bash 3.2 compatible; needs only docker).
#
#   ./slim/qayaba.sh preflight              probe what the network allows (host + a container) and whether
#                                           the LLM gateway declared in the override is reachable (fails
#                                           when no gateway is declared)
#   ./slim/qayaba.sh export-ca              export the macOS System keychain CAs to slim/certs/
#   ./slim/qayaba.sh build                  build the image (all downloads happen here)
#   ./slim/qayaba.sh up | down | ps | logs [service]
#   ./slim/qayaba.sh check                  verify the running image is complete and offline-ready, and that the
#                                           console port is loopback-only and reachable from the compose network
#   ./slim/qayaba.sh onboard <app> <repo> [service-repo ...]
#                                           clone + index every repo and propose the stitcher boundaries
#   ./slim/qayaba.sh onboard-status <app>   | onboard-confirm <app>
#   ./slim/qayaba.sh run <app> <sha|branch> [mode] [--guidance "..."]
#                                           enqueue one e2e run on the server's sequential queue
#                                           (mode: diff | context | complete | exhaustive | manual)
#   ./slim/qayaba.sh tui                    terminal console (runs in a container; nothing runs on the host)
#   ./slim/qayaba.sh console [--print]      web console: copies the local API token to the clipboard (pbcopy),
#                                           prints the console URL and opens it (open); the token is printed
#                                           only with --print
#   ./slim/qayaba.sh exports [app]          list exported publications (patch + MR/Issue bodies)
#   ./slim/qayaba.sh sbom [args]            software bill of materials of the built image (docker scout sbom, or
#                                           docker sbom); without either, see slim/INVENTORIO.md
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
  local gateway_rc=0
  probe_gateway || gateway_rc=$?
  return "$gateway_rc"
}

probe_gateway() {
  # The gateway the override declares, probed from a container that sees what the running services
  # see: the built image's CAs (slim/certs) and the same proxy bypass list. The probe sends no credentials.
  local override="$SLIM_DIR/opencode.override.json" no_proxy_list
  echo "== LLM gateway from inside a container (any HTTP status = reachable; no credentials are sent)"
  if [ ! -f "$override" ]; then
    echo "no LLM gateway is declared: create slim/opencode.override.json (start from slim/opencode.override.example.json); the image does not build without it"
    return 1
  fi
  no_proxy_list="agents,orchestrator,localhost,127.0.0.1,$(env_value EXTRA_NO_PROXY)"
  docker run --rm -e "NO_PROXY=$no_proxy_list" -e "no_proxy=$no_proxy_list" \
    -v "$SLIM_DIR/probe-gateway.sh:/probe-gateway.sh:ro" -v "$override:/override.json:ro" -v "$SLIM_DIR/certs:/certs:ro" \
    "$(env_value NODE_IMAGE node:24-bookworm)" sh -c '
      if ls /certs/*.crt >/dev/null 2>&1; then
        mkdir -p /usr/local/share/ca-certificates/corp && cp /certs/*.crt /usr/local/share/ca-certificates/corp/ && update-ca-certificates >/dev/null 2>&1
      fi
      exec sh /probe-gateway.sh /override.json'
}

console_login() {
  # The web console signs in with the local API token: it is put on the clipboard, never printed
  # unless asked for, and never passed on a command line.
  local print_token=0 token url
  case "${1:-}" in
    "") ;;
    --print) print_token=1 ;;
    *) die "usage: console [--print]" ;;
  esac
  token="$(api_token)"
  url="http://localhost:$(env_value QAYABA_PORT 8080)/app"
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$token" | pbcopy
    echo "the API token is on the clipboard: paste it at the console's sign-in prompt"
  elif [ "$print_token" -eq 0 ]; then
    echo "no clipboard tool found: run './slim/qayaba.sh console --print' to display the token (it is also in config/.api_token)"
  fi
  if [ "$print_token" -eq 1 ]; then echo "token: $token"; fi
  echo "console: $url"
  if command -v open >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 || true; fi
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
    node -e "const Database = require(\"better-sqlite3\"); new Database(\":memory:\").close(); console.log(\"better-sqlite3 ok\")"
    npm config get registry'
  check_console_port
  check_compose_network
}

check_console_port() {
  # The console, API and webhook must be published on the host's loopback interface only.
  local published
  published="$("${COMPOSE[@]}" port orchestrator 8080 2>/dev/null || true)"
  [ -n "$published" ] || die "the console port is not published (is the orchestrator up? ./slim/qayaba.sh ps)"
  case "$published" in
    127.0.0.1:*|"[::1]:"*) echo "console port published on loopback only: $published" ;;
    *) die "the console port is published on every interface ($published); it must be 127.0.0.1 only (see ports: in slim/compose.yml)" ;;
  esac
}

check_compose_network() {
  # Run as the tui service itself, so it uses the service's own environment (QA_HOST, proxy variables)
  # and DNS exactly as the terminal console does.
  "${COMPOSE[@]}" run --rm --no-deps -T tui sh -c \
    'curl -fsS -m 10 -o /dev/null -w "orchestrator answers on http://$QA_HOST/api/health (HTTP %{http_code})\n" "http://$QA_HOST/api/health"' \
    || die "the tui service cannot reach the orchestrator on orchestrator:8080: check that the orchestrator is healthy (./slim/qayaba.sh ps), that it listens on every interface (LISTEN_HOST) and that no proxy intercepts the service name (EXTRA_NO_PROXY)"
}

sbom() {
  local image="qayaba-slim:$(env_value QAYABA_SLIM_TAG local)"
  docker image inspect "$image" >/dev/null 2>&1 || die "image $image not found: build it first (./slim/qayaba.sh build)"
  if docker scout version >/dev/null 2>&1; then
    docker scout sbom "$@" "$image"
  elif docker sbom --version >/dev/null 2>&1; then
    docker sbom "$@" "$image"
  else
    echo "no SBOM generator available (neither 'docker scout' nor the 'docker sbom' plugin)."
    echo "the components of the image, with versions and origin, are listed in slim/INVENTORIO.md"
  fi
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
    [ $# -ge 2 ] || die "usage: run <app> <sha|branch> [mode] [--guidance \"...\"]"
    app="$1"; ref="$2"; shift 2; mode="diff"; guidance=""
    if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then mode="$1"; shift; fi
    if [ "${1:-}" = "--guidance" ]; then guidance="${2:-}"; fi
    # Enqueued through the API (the server's single sequential queue), so it never overlaps another
    # run and shows live in the TUI and the web console. The JSON is built inside the container.
    "${COMPOSE[@]}" exec -T -e RUN_APP="$app" -e RUN_REF="$ref" -e RUN_MODE="$mode" -e RUN_GUIDANCE="$guidance" \
      -e QA_TOKEN="$(api_token)" orchestrator node -e '
        const b = { app: process.env.RUN_APP, target: "e2e", mode: process.env.RUN_MODE };
        const ref = process.env.RUN_REF;
        if (/^[0-9a-f]{7,40}$/i.test(ref)) b.sha = ref; else b.ref = ref;
        if (process.env.RUN_GUIDANCE) b.guidance = process.env.RUN_GUIDANCE;
        fetch("http://localhost:8080/api/runs", {
          method: "POST",
          headers: { authorization: "Bearer " + process.env.QA_TOKEN, "content-type": "application/json" },
          body: JSON.stringify(b),
        }).then(async (res) => { console.log(res.status, await res.text()); process.exit(res.ok ? 0 : 1); });' ;;
  tui) "${COMPOSE[@]}" run --rm tui ;;
  console) console_login "$@" ;;
  sbom) sbom "$@" ;;
  exports) ls -1t "$SLIM_DIR/exports/${1:-}" 2>/dev/null || echo "no exports yet" ;;
  help|*) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" ;;
esac
