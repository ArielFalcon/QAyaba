# `orchestrator` container: the Node infrastructure (webhook, gate, working copy,
# E2E execution, reporting). The agentic generation runs in the separate
# `agents` container (see docker-compose.yml + agents/Dockerfile).
#
# Base = the official Playwright image (Node + browsers preinstalled): this is
# where the agent-generated E2E tests RUN, against DEV.
# NOTE: The PW v1.60.0-noble image ships Node 20; we replace it with Node 24 below
# so undici >=8.4.1 and better-sqlite3 12.10.1 (ABI v137 prebuilt) are both satisfied.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# --- Explicit Node 24 layer -----------------------------------------------
# The Playwright image ships Node 20, which is below undici 8.4.1's engine floor
# and below better-sqlite3 12.10.1's prebuilt ABI (v137 = Node 24). Install Node 24
# via NodeSource so the orchestrator process and npm ci both use it.
# better-sqlite3 12.10.1 ships a linux-x64 prebuilt for ABI v137 (Node 24) — no
# source compile needed on amd64. On arm64 (Apple-silicon dev, Graviton CI) there is
# no matching prebuilt, so npm install COMPILES it from source — build-essential and
# python3 are installed below (the same toolchain code-mode needs), so the build succeeds.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# iptables + util-linux's setpriv: the egress filter (bin/egress-init.sh) holds the sandbox uid's network to the
# origins a run declares, and proves it at boot by connecting as that uid. Needs CAP_NET_ADMIN (docker-compose.yml).
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
  && rm -rf /var/lib/apt/lists/*

# git: to clone/check out the working copies of the watched repos.
# Code-mode runtimes: the orchestrator runs the watched repo's own test suite
# (Python/pytest, Go, Rust/Cargo, Maven, Gradle) for code-mode apps. These run
# in the orchestrator process, NOT in the agents container — see code-runner.ts.
# noble (Ubuntu 24.04) package-name audit: python3/python3-pip/python3-venv/cargo/rustc/
# maven/gradle/build-essential are all present in noble under the same names.
# Go is NOT installed from apt (the noble `golang` package is 1.22 and would lag); we
# install the upstream tarball below.
# JDK (NOT just a JRE): the `maven`/`gradle` packages only pull a headless JRE, which has `java`
# but NOT `javac`. `mvn test-compile`/`mvn test` then fail with "No compiler is provided in this
# environment. Perhaps you are running on a JRE rather than a JDK?" — turning EVERY Java code-mode
# run into an inconclusive infra-error. `default-jdk-headless` puts `javac` on PATH (via
# update-alternatives) and `java-common` provides the arch-independent /usr/lib/jvm/default-java.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    default-jdk-headless \
    python3 python3-pip python3-venv \
    cargo rustc \
    maven \
    gradle \
  && rm -rf /var/lib/apt/lists/*
# Maven/Gradle and many JVM tools consult JAVA_HOME; point it at the arch-independent symlink
# java-common installs, so the same line works on amd64 and arm64.
ENV JAVA_HOME=/usr/lib/jvm/default-java

# --- Go upstream tarball install ------------------------------------------
# apt-get install golang on noble gives Go 1.22 (lagging); use the upstream tarball
# for a current release. go1.26.4 is the pinned target (latest 1.26.x stable, verified
# present on go.dev/dl). Update the version variable to bump Go.
# Arch-aware: derive the Debian arch (amd64/arm64) so the image builds on both x86_64 and
# arm64 hosts (Apple-silicon dev machines, Graviton CI) instead of hardcoding linux-amd64.
ENV GO_VERSION=1.26.4
RUN GOARCH="$(dpkg --print-architecture)" \
  && case "$GOARCH" in \
       amd64|arm64) : ;; \
       *) echo "unsupported arch for Go tarball: $GOARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://dl.google.com/go/go${GO_VERSION}.linux-${GOARCH}.tar.gz" \
  | tar -C /usr/local -xz \
  && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
  && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# Deterministic static-signal extractors (Stage 2). difft + ast-grep are arch-specific release binaries.
RUN pip3 install --no-cache-dir --break-system-packages lizard==1.23.0
# ast-grep publishes ONLY .zip Linux assets (no .tar.gz). The zip holds `sg` (a small launcher, ~440KB)
# and `ast-grep` (the real engine, ~46MB). `sg` is NOT standalone — it execs `ast-grep`, so BOTH must be
# extracted; with only `sg`, `sg --version` fails at runtime with `Os NotFound` (the build never runs sg,
# so this surfaces only at runtime). difft IS a .tar.gz (correct). Fail loud (no || true).
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) T=x86_64-unknown-linux-gnu ;; \
       arm64) T=aarch64-unknown-linux-gnu ;; \
       *) echo "unsupported arch for static-signal binaries: $ARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/Wilfred/difftastic/releases/download/0.69.0/difft-${T}.tar.gz" | tar -C /usr/local/bin -xz difft \
  && curl -fsSL -o /tmp/sg.zip "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-${T}.zip" \
  && unzip -j /tmp/sg.zip sg ast-grep -d /usr/local/bin \
  && rm /tmp/sg.zip

# codegraph v1.6.2, the code-graph engine (docs/adr/0002-code-graph-engine-codegraph.md). Each npm
# platform package is self-contained: `bin/codegraph` (a sh launcher) next to its own `node` and its
# `lib/`, so neither the npm shim nor an install step runs. Pinned per arch by the registry's sha512
# integrity, checked here against the downloaded bytes (fail loud on a mismatch); both packages carry an
# SLSA provenance attestation (`npm view @colbymchenry/codegraph-linux-<arch>@1.6.2 dist.attestations`),
# checked when the pin was set. The engine parses source from repos the system does not control, so it
# only ever runs through the execution launcher's `graph` profile (sandbox uid, no network); nothing
# here makes it reachable as root. When the pin moves: update both integrity values, re-run
# `npm run sandbox:smoke` in the new image, and re-record the adapter's fixtures.
RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) PKG=linux-x64; SRI=sha512-DJWizz1qHNr1MsbK6fz1mjVUQjeTH3T+L0D2BGaLkygWzBnNMG30MvLq1ae0m6cUV414U8aEow5Eb/kIORA8+w== ;; \
       arm64) PKG=linux-arm64; SRI=sha512-4sUICiYzHgC3brCKw4FDiY10jVQ79oIm2wwE978IOAXj36sDxji6d9l5SEvGyHyolgSXsLImLtagTsIEN2Pvnw== ;; \
       *) echo "unsupported arch for codegraph: $ARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/codegraph.tgz "https://registry.npmjs.org/@colbymchenry/codegraph-${PKG}/-/codegraph-${PKG}-1.6.2.tgz" \
  && WANT="$(printf '%s' "${SRI#sha512-}" | base64 -d | od -An -tx1 | tr -d ' \n')" \
  && GOT="$(sha512sum /tmp/codegraph.tgz | cut -d' ' -f1)" \
  && if [ "$WANT" != "$GOT" ]; then echo "codegraph ${PKG} integrity mismatch" >&2; exit 1; fi \
  && mkdir -p /opt/codegraph \
  && tar -C /opt/codegraph --strip-components=1 --no-same-owner -xzf /tmp/codegraph.tgz \
  && rm /tmp/codegraph.tgz \
  && chmod -R a+rX,go-w /opt/codegraph \
  && ln -s /opt/codegraph/bin/codegraph /usr/local/bin/codegraph

# Unprivileged user for executing UNTRUSTED code: the agent-written Playwright specs, the e2e project's
# own tsc/eslint/install, a login script, and the watched repo's own install/test/coverage. The
# orchestrator runs as root and DROPS to this user for every one of those spawns (the execution
# launcher, qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts), so untrusted code
# cannot read the root-owned API token (data/.api_token), the auth material under /app/data, the app
# configs, or another watched repo under /app/.mirrors (bin/container-entrypoint.sh closes them at every
# boot and then proves it as this uid), tamper with the orchestrator's files (/app/src, node_modules),
# or write the mirror it runs in.
# The user owns a writable home for toolchain caches (~/.m2, ~/.gradle, ~/.cache, ~/.cargo). NOBLE drift: Ubuntu 24.04 ships a default `ubuntu` user at uid 1000,
# which pushed the Playwright image's `pwuser` to uid 1001 (it was 1000 on jammy). So `sandbox` uses
# uid 1002 (the next free id) — docker-compose sets CODE_SANDBOX_UID=1002 so code-runner.ts matches.
RUN useradd --create-home --uid 1002 --shell /usr/sbin/nologin sandbox

WORKDIR /app

COPY package.json package-lock.json* ./
# Install ALL deps (not --omit=dev): the service runs TypeScript directly via
# `tsx` at runtime (no build step), and tsx is a devDependency.
RUN npm install

COPY . .

# The app configs live behind a directory only root may enter: compose bind-mounts the host's config folder at
# /app/.host/config, and /app/config is a link to it. A host bind mount can sit on a filesystem that does not enforce
# permissions (Docker Desktop's file sharing hands every uid what it asks for); the lookup of /app/.host/config is
# checked by /app/.host, which is on this image's own filesystem, so the sandbox uid cannot reach the configs on any host.
RUN mkdir -p /app/.host && mv /app/config /app/.host/config && ln -s .host/config /app/config && chmod 0700 /app/.host

# The e2e tooling (Playwright runner + eslint + tsc) is NOT installed here: it
# lives in each repo's `e2e/`, and the orchestrator runs `npm ci` there per run
# (qa/setup.ts). The image already ships the Playwright browsers.

# Inside the container the process listens on every interface, or a published port (`docker run
# -p`, compose `ports:`) could not reach it; what is exposed beyond the container is decided by the
# publish address (-p / BIND_ADDR). A bare `npm run start` outside the image stays on loopback.
ENV LISTEN_HOST=0.0.0.0

# Root-only boot steps first (file permissions the sandbox uid depends on, the egress filter), then the
# service: webhook + sequential queue.
RUN chmod +x /app/bin/container-entrypoint.sh /app/bin/egress-init.sh
ENTRYPOINT ["/app/bin/container-entrypoint.sh"]
CMD ["npm", "run", "start"]
