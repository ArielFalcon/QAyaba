# AGENTS.md

## What this is

`qayaba` is an **app-agnostic, centralized AI-assisted E2E QA engine**. It watches team repos; when a commit is deployed to DEV, an AI agent (OpenCode and/or Codex) generates Playwright E2E tests for the blast radius, runs them against the live DEV site, and — when green + reviewer-approved — commits them into the app repo's `e2e/` folder via a PR with auto-merge. Failures open a GitHub Issue.

**Priority: stable, reliable, deterministic > features.** The hardest problem is trust — see [the value/trust risk](#the-valuetrust-risk).

## Commands

No build step — TypeScript runs directly via `tsx`.

```bash
npm install               # required once
npm test                  # node:test via tsx; 900+ tests, network/OpenCode/Codex/Playwright stubbed
npm run typecheck         # tsc --noEmit (strict, noUncheckedIndexedAccess)

# Run a single test file or filter by name:
node --import tsx --test src/server/webhook-routing.test.ts
node --import tsx --test --test-name-pattern="skip" src/server/webhook-routing.test.ts

# Manual QA run (same pipeline as webhook):
npm run qa -- --app portfolio --sha <sha>
npm run qa -- --app portfolio --sha <sha> --mode exhaustive
npm run qa -- --app portfolio --sha <sha> --mode manual --guidance "test the contact form"

npm run start             # webhook + queue service (src/index.ts)
```

`npm test` and `npm run typecheck` are the gate — keep them green.

### Docker

```bash
doppler run -- docker compose up --build   # prod: Doppler injects secrets
# or: cp .env.example .env (fill OPENCODE_API_KEY) then `docker compose up --build`
```

## Architecture

**Two long-lived services** sharing the `mirrors` volume (repo working copies):

| Service | What | Lives in |
|---|---|---|
| `orchestrator` | Deterministic infra: webhook, sequential queue, deploy gate, working copy, harness (validate + execute), publish/report. Node/TS via `tsx`. | `src/` |
| `agents` | Agentic engine: supervisor fronting both runtimes (OpenCode `opencode serve` + Codex `codex exec`) + MCPs (Serena for code nav, engram for memory). Writes `.spec.ts` into working copy. | `agents/` |

**Fundamental split**: deterministic infra (`src/`) is rigorously separated from the non-deterministic agent (`agents/`). Engine logic lives in `qa-engine/`. The shell talks to OpenCode via `src/integrations/opencode-client.ts` (thin SDK primitives).

### Run flow (`qa-engine/.../run-qa.use-case.ts` — read first)

`RunQaUseCase` is the only engine. Both the webhook (`src/index.ts`) and `npm run qa` funnel through `src/server/runner.ts` → `src/server/rewritten-engine-factory.ts`.

1. **Gate** — wait until DEV serves this SHA (`/version`). Skipped if `dev.versionUrl` absent.
2. **Working copy + classify** — clone/checkout SHA; extract diff + message; classify commit (Conventional Commits, cross-checked against diff). `skip` → returns `skipped` without spending a token.
3. **Setup** — bootstrap `config/e2e/` seed into repo's `e2e/` if missing, then `npm ci`.
4. **Generate** — agent session (OpenCode or Codex); derives objective from commit intent, writes/improves specs. **Agent-approved + zero specs → `skipped`** (valid no-op).
5. **Validate** — static gate: `tsc` + ESLint (`eslint-plugin-playwright`) + `playwright --list` + manifest. Fail → `invalid`.
6. **Health pre-flight** — DEV down → `infra-error`.
7. **Execute** — Playwright against DEV; classify `pass`/`fail`/`flaky`.
8. **Change-coverage** — measure whether the green run exercised the diff's changed lines (`signal` records; `enforce` can hold the PR). `unknown` never blocks.
9. **Decide** — green + reviewer-approved (+ coverage not blocking) → PR w/ auto-merge. Reviewer rejected, or `fail`/`invalid` → Issue. `flaky` → quarantine. Green with no `e2e/` changes → nothing.

**Verdicts**: `pass | fail | flaky | invalid | infra-error | skipped`.

### Run modes (`--mode`, default `diff`)

- **diff** — test blast radius of one commit. Only mode that runs `classifyCommit`.
- **complete** — analyze whole repo, generate tests for uncovered important flows.
- **exhaustive** — like complete but re-evaluates every existing test.
- **manual** — generation focused by `--guidance`.

### DI = testing strategy

Every side-effecting step is injected via hexagonal ports (`RunQaUseCaseDeps`, composition in `src/server/rewritten-engine-factory.ts`). Orchestration logic is unit-tested with stubs. Real integrations are the deliberately-uncovered boundaries.

### Agent layers (`agents/`)

Provider-agnostic runtime (`src/agent-runtime/`, `AgentProvider = "opencode" | "codex"`): each role
(primary / reviewer / chat) gets a provider + model, in `single` or `dual` mode. Below is the
**OpenCode runtime's** roster — Config: `agents/opencode.json`, single `OPENCODE_API_KEY` (opencode-go/ prefix):
- `qa-generator` (primary, `deepseek-v4-pro`) — writes tests, read/edit/bash
- `qa-reviewer` (subagent, `qwen3.7-max`) — read-only, emits JSON verdict

Prompt layers: `agents/AGENTS.md` (shared rules) → `agents/agent/*.md` (per-role) → `agents/skill/` (on-demand: `playwright-authoring`, `test-value-review`). Codex uses the provider-neutral mirror under `agent/` (`agent/roles/*.md`, `agent/skills/`).

## Invariants

- **Security boundary**: LLM agent is read-only on watched repos. Only the orchestrator does git writes. Never give the agent direct write to a watched repo.
- **App-specificity only in `config/`**; agents/models only in `agents/`; nothing app-specific in `src/`.
- **Sequential queue** — one run at a time. Never run concurrent QA against DEV.
- **Honor agent's no-op**: approved + zero specs is a valid `skipped`, never `invalid`.
- **Surface integration errors loudly** — never swallow OpenCode SDK / runner / git errors. Throw and log.
- **Sanitize data leaving the system** — diff → model, execution logs → Issue, both pass through `src/orchestrator/sanitizer.ts`.

## Conventions & gotchas

- **No build step.** `tsx` runs TS at runtime — install ALL deps in Docker (not `--omit=dev`).
- **Pin exact versions on the execution path.** Playwright pinned to `1.50.0` to match the base image (`playwright:v1.50.0-jammy`). Don't loosen it.
- **`.env` comments go on their own line.** `docker compose env_file` doesn't strip inline `#` — it becomes part of the value.
- **Secrets via Doppler at runtime**; nothing committed. `.env` is for local-without-Doppler only.
- **Tests use `node:test` + `node:assert/strict`**, colocated `*.test.ts`.
- **OpenAPI is authoring context, agent-resolved.** Agent locates and reads specs (Serena/glob). Optional `openapi:` glob hint in app config. Agent exercises backend through the UI, never by calling the API directly.
- **Long agent turns vs. undici.** `defaultOpencodeDeps` raises global `headersTimeout`/`bodyTimeout` above `OPENCODE_TIMEOUT_MS` so the `withTimeout` wrapper is the real deadline.
- **Serena needs a language server per watched-repo language.** `agents/Dockerfile` bakes in JDK, python3, TypeScript LS. Add runtime when onboarding a new language.

## The value/trust risk

The quality loop is circular: one LLM generates, another reviews, and the harness only checks that tests *run green*, not that they're *meaningful*. The system can drift into a large suite that never catches anything. The work that breaks this is **change-coverage gating** (does executing the test cover the diff-changed lines?) — **not more prompt tuning**. Keep this front of mind before expanding the agent or reviewer.

## Current state

Several apps are wired in `config/apps/` across the current **Java + JavaScript/TypeScript** scope — interchangeable test targets, never design inputs: `jhipster-store`, `petclinic` and `portfolio` run in **e2e** mode against live DEV in **shadow mode**; `qayaba` runs in **code** mode (`code: true`). The deploy gate is skipped wherever no `versionUrl` is configured. engram is enabled for persistent agent memory across runs.

The `src/` → `qa-engine/` migration is **complete**: new engine logic targets `qa-engine/`; `src/` is the declared shell (composition root, control plane, provider I/O, persistence). `qa-engine` never imports `src/` (`npm run arch:check`).

Controlled alpha demo: `portfolio`, `shadow: true`, `--mode manual`, narrow homepage guidance. Do not load untracked apps with `shadow: false`.

- Apps with a non-empty `services[]` auto-enable the read-only `qa-explorer` pass (still opt-in via `qa.explorer` when there are no services; skipped in code-mode).
- After classify (not on skip), the run fail-open reindexes the mirror via `CodeGraphPort.syncTo` only when `lastIndexedSha` in `data/index-status.json` differs from the run SHA.
- Boundary transport `http-backend` resolves BE→BE REST clients (RestTemplate / Feign / WebClient) against OpenAPI; see the commented example in `config/apps/example.yaml`. FE→BE stays `http`.

## Persistence

- **E2E suite** → git (app repo's `e2e/`). Versioned, reviewable.
- **engram memory** (`engram-data` volume) → the only non-regenerable data.
- **Serena index, working copies** → regenerable caches.
- **Onboarding a watched app**: `config/apps/<app>.yaml` + `.env` only. Copy `config/apps/example.yaml`.

## File map

| Path | Purpose |
|---|---|
| `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` | Full orchestration — read first |
| `src/server/rewritten-engine-factory.ts` | Composition root: AppConfig → engine |
| `src/index.ts` | Webhook service entry point |
| `src/cli.ts` | Manual trigger (`npm run qa`) |
| `src/types.ts` | Shared type contracts |
| `src/integrations/opencode-client.ts` | Thin HTTP/SDK boundary to `opencode serve` |
| `src/integrations/repo-mirror.ts` | Clone/checkout/copy working mirrors |
| `src/integrations/publish.ts` | PR + Issue publishing |
| `src/integrations/github.ts` | GitHub API |
| `src/orchestrator/sanitizer.ts` | Redact secrets from execution logs → Issue |
| `src/orchestrator/config-loader.ts` | Load `config/apps/<app>.yaml` with `${VAR}` expansion |
| `src/server/queue.ts` | Sequential job queue |
| `src/server/webhook.ts` | Webhook receiver |
| `config/apps/*.yaml` | Watched-app configurations |
| `config/e2e/` | Seed: Playwright config, shared fixtures, lint rules |
| `agents/opencode.json` | Agent + MCP definitions |
| `agents/agent/*.md` | Per-role agent prompts |
| `agents/skill/` | On-demand craft knowledge |
