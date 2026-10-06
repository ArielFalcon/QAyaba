# syntax=docker/dockerfile:1.7
#
# QAyaba slim — ONE hermetic image that runs as two services (orchestrator | agents).
#
# Every network acquisition happens in this build, from sources passed as build args (point them at
# the internal registry / Artifactory remotes); the running containers install nothing. Files that
# only exist on GitHub or eclipse.org are taken from slim/vendor/ when vendored by hand, otherwise
# downloaded from the configurable base URL — always verified against slim/vendor/SHA256SUMS.
#
# Build context: the repository root (slim/compose.yml sets it); ignore rules: slim/Dockerfile.dockerignore.

ARG PW_IMAGE=mcr.microsoft.com/playwright:v1.60.0-noble
ARG NODE_IMAGE=node:24-bookworm
ARG GO_IMAGE=golang:1.26-bookworm

# ── deps: orchestrator Node dependencies + effective OpenCode config ─────────────────────────────
# The full node image carries gcc/make/python3, so native modules compile here without downloads.
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY slim/certs/ /usr/local/share/ca-certificates/corp/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm config set --location=global registry "$NPM_REGISTRY" \
 && npm config set --location=global cafile /etc/ssl/certs/ca-certificates.crt
# better-sqlite3 is compiled against the local Node headers: no prebuilt binary from GitHub, no
# header tarball from nodejs.org.
ENV npm_config_build_from_source=true npm_config_nodedir=/usr/local
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY web/package.json ./web/package.json
RUN npm ci --no-audit --no-fund
COPY agents/opencode.json /tmp/qayaba/opencode.base.json
# The override is optional: the glob lets the COPY succeed when it is absent.
COPY slim/opencode-config.mjs slim/opencode.override.jso[n] /tmp/qayaba/
RUN node /tmp/qayaba/opencode-config.mjs /tmp/qayaba/opencode.base.json /tmp/qayaba/opencode.override.json > /tmp/qayaba/opencode.json

# ── tui: the terminal console (Linux build for the container, macOS builds for the host) ────────
FROM ${GO_IMAGE} AS tui
ARG GOPROXY=https://proxy.golang.org,direct
ARG GOSUMDB=sum.golang.org
COPY slim/certs/ /usr/local/share/ca-certificates/corp/
RUN update-ca-certificates
ENV CGO_ENABLED=0 GOPROXY=${GOPROXY} GOSUMDB=${GOSUMDB} GOFLAGS=-mod=readonly
WORKDIR /src
COPY client/go.mod client/go.sum ./
RUN go mod download
COPY client/ ./
RUN go build -trimpath -o /out/qayaba ./cmd/qayaba \
 && GOOS=darwin GOARCH=arm64 go build -trimpath -o /out/qayaba-darwin-arm64 ./cmd/qayaba \
 && GOOS=darwin GOARCH=amd64 go build -trimpath -o /out/qayaba-darwin-amd64 ./cmd/qayaba

# ── runtime image ─────────────────────────────────────────────────────────────────────────────────
# The Playwright base already ships Node 24, git and Chromium with its system libraries: the
# browser that runs the specs, the DOM capture and the agents' Playwright MCP is the same one.
FROM ${PW_IMAGE}
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Trust: corporate CA(s) that re-terminate TLS (slim/certs/*.crt), for every client in the image.
COPY slim/certs/ /usr/local/share/ca-certificates/corp/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt

# apt: optional internal mirrors. The base image's NodeSource list is dropped (Node is already
# installed; that host is rarely reachable from a restricted network).
ARG APT_MIRROR=
ARG APT_PORTS_MIRROR=
RUN rm -f /etc/apt/sources.list.d/nodesource.list \
 && if [ -n "$APT_MIRROR" ]; then sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#${APT_MIRROR%/}/#g" /etc/apt/sources.list.d/ubuntu.sources; fi \
 && if [ -n "$APT_PORTS_MIRROR" ]; then sed -i -E "s#https?://ports\.ubuntu\.com/ubuntu-ports/?#${APT_PORTS_MIRROR%/}/#g" /etc/apt/sources.list.d/ubuntu.sources; fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv openjdk-21-jdk-headless \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" /opt/java21

# npm: the internal mirror for every npm in the image. The GLOBAL npmrc is read whatever the user,
# HOME or filtered environment (the e2e install runs as the sandbox user with a scrubbed env).
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set --location=global registry "$NPM_REGISTRY" \
 && npm config set --location=global cafile /etc/ssl/certs/ca-certificates.crt

# Agent runtime and browser MCP, exact pins. The MCP drives the base image's Chromium.
ARG OPENCODE_VERSION=1.17.7
ARG PLAYWRIGHT_MCP_VERSION=0.0.76
RUN npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && ln -s "$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -1)" /usr/local/bin/pw-chromium \
 && /usr/local/bin/pw-chromium --version

# Binaries published only as GitHub releases: vendored or mirrored, checksum-verified.
ARG GITHUB_RELEASES_BASE=https://github.com
COPY slim/vendor/ /opt/vendor/
COPY --chmod=755 slim/fetch-artifact.sh /usr/local/bin/fetch-artifact
RUN fetch-artifact "codebase-memory-mcp-linux-${TARGETARCH}.tar.gz" \
      "${GITHUB_RELEASES_BASE}/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-${TARGETARCH}.tar.gz" /tmp/cbm.tar.gz \
 && tar -xzf /tmp/cbm.tar.gz -C /usr/local/bin codebase-memory-mcp \
 && fetch-artifact "engram_1.16.1_linux_${TARGETARCH}.tar.gz" \
      "${GITHUB_RELEASES_BASE}/Gentleman-Programming/engram/releases/download/v1.16.1/engram_1.16.1_linux_${TARGETARCH}.tar.gz" /tmp/engram.tar.gz \
 && tar -xzf /tmp/engram.tar.gz -C /usr/local/bin engram \
 && chmod +x /usr/local/bin/codebase-memory-mcp /usr/local/bin/engram \
 && rm -f /tmp/cbm.tar.gz /tmp/engram.tar.gz

# Serena (semantic code navigation for the agents) from the PyPI mirror.
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG SERENA_VERSION=1.5.3
RUN python3 -m venv /opt/serena \
 && /opt/serena/bin/pip install --no-cache-dir --index-url "$PIP_INDEX_URL" "serena-agent==${SERENA_VERSION}" \
 && ln -s /opt/serena/bin/serena /usr/local/bin/serena

# Java language server in Serena's upstream-JDTLS mode: an installed JDTLS + Lombok + the system JDK,
# so nothing is downloaded when the agent opens a .java file.
ARG JDTLS_FILE=jdt-language-server-1.58.0-202604151538.tar.gz
ARG JDTLS_BASE_URL=https://download.eclipse.org/jdtls/milestones/1.58.0
ARG LOMBOK_VERSION=1.18.38
ARG MAVEN_REPO=https://repo.maven.apache.org/maven2
RUN fetch-artifact "$JDTLS_FILE" "${JDTLS_BASE_URL}/${JDTLS_FILE}" /tmp/jdtls.tar.gz \
 && mkdir -p /opt/jdtls && tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls && rm /tmp/jdtls.tar.gz \
 && fetch-artifact "lombok-${LOMBOK_VERSION}.jar" \
      "${MAVEN_REPO%/}/org/projectlombok/lombok/${LOMBOK_VERSION}/lombok-${LOMBOK_VERSION}.jar" /opt/jdtls/lombok.jar

# Serena global config: upstream JDTLS, a heap that fits a 16 GB laptop, no dashboard/browser.
ARG JDTLS_XMX=1536m
RUN serena init >/dev/null && /opt/serena/bin/python - <<PY
import yaml, pathlib
path = pathlib.Path.home() / ".serena" / "serena_config.yml"
cfg = yaml.safe_load(path.read_text())
cfg["web_dashboard"] = False
cfg["web_dashboard_open_on_launch"] = False
cfg["ls_specific_settings"] = {"java": {
    "jdtls_path": "/opt/jdtls",
    "lombok_path": "/opt/jdtls/lombok.jar",
    "java_home": "/opt/java21",
    "jdtls_xmx": "${JDTLS_XMX}",
}}
path.write_text(yaml.safe_dump(cfg, sort_keys=False))
PY

# Warm-up: provision (TypeScript LS via the npm mirror) and smoke-test (Java) the language servers
# now, so the agents never install one at run time. The sample projects are discarded.
COPY slim/warmup/ /tmp/warmup/
RUN serena project index /tmp/warmup/ts --language typescript --log-level WARNING \
 && serena project index /tmp/warmup/java --language java --log-level WARNING \
 && test -x "$HOME/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin/typescript-language-server" \
 && rm -rf /tmp/warmup "$HOME/.serena/language_servers/static/EclipseJDTLS/workspaces"

# Orchestrator: the unprivileged user that runs untrusted code (the repo's install, the specs).
RUN useradd --create-home --uid 1002 --shell /usr/sbin/nologin sandbox

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Both roles read the SAME effective OpenCode config: the agents run it, the orchestrator sizes
# prompts and resolves role models from it.
COPY --from=deps /tmp/qayaba/opencode.json /app/agents/opencode.json
RUN mkdir -p /root/.config \
 && rm -rf /root/.config/opencode /root/.config/agent \
 && cp -r /app/agents /root/.config/opencode \
 && cp -r /app/agent /root/.config/agent \
 && test -f /root/.config/opencode/opencode.json \
 && cp /app/agents/agent-supervisor.mjs /usr/local/bin/agent-supervisor.mjs
COPY --from=tui /out/qayaba /usr/local/bin/qayaba
COPY --from=tui /out/qayaba-darwin-arm64 /out/qayaba-darwin-amd64 /opt/qayaba/tui/

# LISTEN_HOST: inside the container the control plane listens on every interface so the published
# port (slim/compose.yml binds it to 127.0.0.1 on the host) and the tui service can reach it.
ENV QAYABA_PROFILE=slim \
    LISTEN_HOST=0.0.0.0 \
    MIRROR_DIR=/app/.mirrors \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true

CMD ["npm", "run", "start"]
