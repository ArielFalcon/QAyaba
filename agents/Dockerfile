# Agentic engine image: the OpenCode CLI + Serena (baked at build time) and the
# language runtimes its language servers need.
FROM node:24-bookworm

# - opencode: the agent CLI (npm global → PATH at /usr/local/bin).
# - uv: the Python toolchain used to install Serena at BUILD time (see below).
# - git: the agent/Serena read the working copy.
# - Language servers for Serena's blast-radius navigation, ONE PER watched-repo
#   language: openjdk (Java/Spring backend), python3 (Python), and the TypeScript
#   language server (Angular frontend — components/services are plain .ts). They are
#   baked into the image so Serena never downloads a server at run time (determinism;
#   without the TS server, blast radius on the Angular side degrades to reading whole
#   files, which is exactly what Serena exists to avoid).
# Serena is installed at BUILD time (not fetched via `uvx` on first use), so a run never
# depends on outbound GitHub/PyPI access and startup is deterministic and fast. Pin a
# release tag for reproducibility — bump it deliberately, never float on a moving ref.
ARG SERENA_VERSION=v1.5.3
# The agent CLIs are PINNED to exact versions (CLAUDE.md: pin exact versions on the
# execution path). A floating "latest" would let a silent upstream bump change agent
# behavior on the next rebuild. Bumping is a deliberate edit here + an image rebuild —
# confirm a new opencode-ai against `opencode models` before bumping.
ARG OPENCODE_VERSION=1.17.7
ARG PLAYWRIGHT_MCP_VERSION=0.0.76
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git openjdk-17-jdk-headless python3 \
   && rm -rf /var/lib/apt/lists/* \
   && curl -LsSf https://astral.sh/uv/install.sh | sh \
   && export PATH="/root/.local/bin:${PATH}" \
   && uv tool install --python 3.11 "git+https://github.com/oraios/serena@${SERENA_VERSION}" \
   && npm install -g "opencode-ai@${OPENCODE_VERSION}" typescript typescript-language-server \
   && npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
   && npx playwright install --with-deps chromium
# Serena (`uv tool install`) and uv both land in /root/.local/bin → on PATH at run time.
ENV PATH="/root/.local/bin:${PATH}"

# The run_spec tool (tool/run_spec.ts) imports @opencode-ai/plugin. The config directory is a read-only bind mount of ./agents
# (docker-compose.yml), whose node_modules is a host folder the repo does not ship, so the package is installed here:
# OpenCode resolves it by walking up from the tool file to /root/node_modules. The versions are those of package-lock.json.
COPY package.json package-lock.json /root/
RUN cd /root && npm ci --omit=dev

COPY agent-supervisor.mjs /usr/local/bin/agent-supervisor.mjs
RUN chmod +x /usr/local/bin/agent-supervisor.mjs

# KNOWN LIMITATION: this container currently runs as root. Switching to non-root
# requires re-homing /root/.local/share/opencode, /root/.cache/uv, /data, and the
# /app/.mirrors mount to a non-root user — a coordinated change across both
# Dockerfiles + docker-compose.yml. Tracked in the production hardening backlog.
ENTRYPOINT ["node", "/usr/local/bin/agent-supervisor.mjs"]
