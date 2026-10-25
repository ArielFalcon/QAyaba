# ADR-0002: the code graph engine is codegraph, run as an untrusted-source parser, and the graph serves the engine before the agent

- **Status:** Proposed — gated by the spike in `odd/tasks/codegraph-migration.md` (S1/T0)
- **Date:** 2026-10-25 (revised the same day after an architecture review; plan Log L16-L19)
- **Deciders:** qayaba maintainers
- **Supersedes:** the earlier engine choice for `service-links` and the structural signal (codebase-memory), which git history keeps. It keeps the grounding-telemetry measurement model of `docs/observability-design.md` and uses it for acceptance.
- **Related:** `odd/tasks/codegraph-migration.md` (the executable plan), `qa-engine/src/shared-kernel/ports/code-graph.port.ts`, `qa-engine/src/shared-infrastructure/code-graph/`, `qa-engine/src/contexts/service-topology/`, `qa-engine/src/contexts/generation/domain/route-ranking.ts`, `qa-engine/src/contexts/qa-run-orchestration/infrastructure/adapters/code-graph-tools-port.adapter.ts`, `docs/agent-reference.md`, `docs/execution-sandbox.md`

## 1. Context

qayaba has one code graph and three consumers. Only two of those consumers ever did anything.

1. **The structural signal, on every run with the signal on.** It calls `impactedSymbols`, `callersOf` and `coChangeCoupling` (`structural-signal-port.adapter.ts:19,28,37`) and renders the result into the `static-signal` prompt section.
   - The deterministic extractors it once sat beside (lizard, difftastic, tree-sitter) were deleted in `9bef64c6`. The structural signal is now the graph alone.
2. **The second tier of the cross-repo impact** (`resolve-cross-repo-impact.use-case.ts:63`), which marks the service links a backend change reaches.
3. **The lead's tool.** `qa-generator`, outside a delegation, has three read-only actions (`search_graph`, `trace_path`, `get_code_snippet`), proxied by the orchestrator to the `codebase-memory-mcp` CLI. It was wired, granted and never called.

Onboarding also builds the first index (`src/index.ts:580-623`).

Two facts about the current seam matter as much as the engine:

- **The graph CLI runs as a "trusted binary": as root, with the container's full network** (`sandboxed-binary-runner.ts:30`, `.dependency-cruiser.cjs:77`, `Dockerfile:110`). The egress filter matches only the sandbox uid, so it does not apply. The process parses source from repos the system does not control.
- **Change pages already exist.** `route-ranking.ts` links a page when a changed file is one of the map's implementation or source files for that page, or when a changed contract reaches it through the map's `feBe`. That result, `changeRoutes`, drives four things:
  - DOM capture;
  - the lead's plan;
  - the lead review's unvisited/unproven pages (`9520f272`);
  - the route-coverage graders.

  What it cannot do is link a page to a backend change that does not touch the contract, or to a change in a file the map does not name.

The owner reports that no agent has ever used the tool, in qayaba or in a personal OpenCode harness. This ADR records what was measured, decides the engine, and moves the boundary of what the graph is *for*.

**Decision summary**

1. **Replace the engine**: `codebase-memory-mcp` → `codegraph` (MIT, v1.6.2). The replacement is gated by a spike with kill criteria (§3.6).
2. **Run the engine as what it is, a parser of untrusted source.**
   - **Where it runs:** a dedicated launcher profile, with the sandbox uid, no network and an allowlisted environment.
   - **What it reads:** an exported workspace built from the tracked files at the run's SHA, never the mirror.
   - **Where the store lives:** a root-owned cache, published before any agent-influenced code runs.

   This changes the seam's execution model. It does not change its API.
3. **Keep the seam's API**: `CodeGraphPort`, `/internal/codegraph`, the tool registry, `QA_TOOLS_TOKEN`, redaction by value and the per-run caps.
4. **The graph serves the engine first**:
   - a re-backed structural signal;
   - a tier 2 that also matches hand-written controllers and changed handlers;
   - change pages extended by graph reachability for **any** app — the owner's "esta pagina llega a esta accion".
5. **The lead gets one action and one deterministic dossier**: `explore`, plus the engine's read-equivalent answer for the change inside `static-signal`. Adoption is judged on outcomes, not on calls.
6. **Do not** let the engine's conveniences in:
   - `affected` is not change-coverage;
   - the watcher is not the index lifecycle;
   - the MCP server does not enter the agents container;
   - a repo's own engine config is never read.

## 2. What was measured

All measurements were taken against this repository and the live stack. The codegraph measurements come from a scratch install under a temporary directory (v1.6.2, installed from the signed release bundle), removed afterwards. Engine facts marked *source* were read from the v1.6.2 source on GitHub.

### 2.1 Adoption is zero, and it is not a wiring fault

`data/qayaba.db`, 300 `agent_turns`, 5 479 tool calls:

| tool family | calls |
|---|---|
| `read` | 2 273 |
| `grep` | 894 |
| `glob` | 525 |
| `edit` | 170 |
| `authbrowser_*` | ~296 |
| `write` | 112 |
| `run_spec` | 95 |
| `serena_*` | 17 |
| **`codegraph_*`** | **0** |

The last e2e run (`run-75f5390`) recorded `structuralSignal: "signal"`. Inside the orchestrator, the store held `app-.mirrors-joomeco__name-webapp` with 9 433 nodes written during that run. The tools were composed, granted to `qa-generator`, and never called.

### 2.2 The mechanism: the steering was never in the context

MCP `initialize` handshake and `tools/list`, both servers, same client:

| | codebase-memory-mcp | codegraph |
|---|---|---|
| `initialize.instructions` | **0 bytes** | 6 718 bytes, imperative |
| tools listed | 14 | **1** |
| tool schema bytes | 12 039 | 1 788 |

codegraph's instructions say, in the model's own reading context:

- *"PRIMARY TOOL — call FIRST for almost any question OR before an edit"*
- *"Read-equivalent — treat the shown source as already Read; do NOT re-open those files"*
- *"running your own grep + read loop repeats work codegraph already did"*

`codebase-memory-mcp` sends nothing. Its only steer in qayaba was `agents/AGENTS.md`, which ranks the graph first. Two lines later it says *"for text, templates and selectors use grep and read"* (repeated in `agents/tool/codegraph.ts:11-13`), while the prompt already supplies a precomputed architecture map. The graph was competing with `read`, the single most-used tool, with no argument.

### 2.3 The answer shape, measured on the same repo and the same question

| | codebase-memory-mcp | codegraph |
|---|---|---|
| calls to answer "how does X resolve Y" | 3 | **1** |
| bytes | 5 422 | 25 157 |
| source included | one symbol body (995 B) | verbatim, line-numbered, 6 files |
| covering test files named | no | yes |
| identifier noise in the agent's answer | absolute repo path inside every `qualified_name` | repo-relative `filePath`, short `qualifiedName` |
| `--json` on the flagship command | n/a (MCP) | **no** — `explore` and `node` are text in 1.6.2 (the README says otherwise) |

The engine port itself never reads `qualified_name`. It already returns repo-relative `file_path` and bare symbol names. The identifier noise is a cost of the agent's answers, not of the engine's joins.

### 2.4 Cost to index

| repo | files | nodes / edges | time | store |
|---|---|---|---|---|
| ai-pipeline (TS) | 1 426 | 29 190 / 104 930 | 7.1 s | 127 MB |
| ms-name-restaurants (Java) | 328 | 4 779 / 7 369 | 963 ms | 14 MB |

These are full first-index times. The cached re-sync cost, the workspace-export cost and the per-spawn cost are measured by the spike (§3.6). Java and TypeScript/JavaScript are the declared scope, and both have full support.

### 2.5 What the stitcher actually does (and does not do)

The working assumption, that the stitcher was built on the codebase-memory graph, is false (`resolver-factory.ts:10-14`):

| transport | resolver | source |
|---|---|---|
| `http` (FE→BE) | `OpenApiHttpResolver` | one OpenAPI YAML per service, plus the front files the app's `profile.frontFiles` names |
| `http-backend` (BE→BE) | `HttpBackendResolver` | OpenAPI + call patterns |
| `event` | `EventResolver` | event files + pattern catalog |

None of them receives the graph client; all three read mirrors through `RepoReader`.

**How the FE→BE resolver finds call sites:**

- The app config decides only the file suffix (name-webapp declares `*.api.ts`).
- The call shape comes from a built-in catalog with a single kind, `<receiver>.(get|post|put|patch|delete)(` (`call-site-catalog.ts:21-41`).
- The URL must carry a `{service}` token.

So links exist only for multi-repo apps that declare `services` + `boundaries` with that call shape. Today that is one app.

**Value.** 18 resolved links: 15 at confidence 1.00 and 3 at 0.60, where 0.60 means a URL placeholder matched a path parameter. Plus **6 contract-drift warnings** naming endpoints the frontend calls that the backend contract does not declare. It costs 4 842 B of a 45 221 B prompt (10.7 %).

**Coverage is thin:**

- **3** cross-repo runs in the entire history, and all three failed (`infra-error`, `invalid`, `invalid`).
- `event` and `http-backend` are implemented, but **no app declares them**.

### 2.6 Two engine claims that do not survive contact

- **`affected` is not change-coverage.** With `--filter "e2e/*"` on an app-source change it returns **empty**, because Playwright specs do not import app source. From a hub module it maps one leaf change to ~50 test files (2 at `-d 1`). It returns test files only (*source*). It is a unit-test selection helper, not a coverage gate.
- **Framework routes do not cover OpenAPI-codegen Spring.** On `ms-name-restaurants` the engine emitted **0 route nodes**: the `@GetMapping` annotations live in the generated `*Api` interface.
  - The context map remains the source of page names and flows.
  - The operationId remains the backend join key for codegen interfaces.

### 2.7 Engine facts that shape the integration (*source*, v1.6.2)

- **Store location.** The store is always `<projectRoot>/.codegraph/codegraph.db` (`src/directory.ts`). `CODEGRAPH_DIR` only renames the folder: no `/`, no `..`, no absolute path. There is no `--db` and no home switch. `index` writes to the project root: the folder, `codegraph.lock`, and the `-wal`/`-shm` files.
- **The repo can steer the engine.**
  - It reads a root `codegraph.json` (`include`, `exclude`, `includeIgnored`, `extensions`; `src/project-config.ts`).
  - It treats a repo-shipped `.codegraph/codegraph.db` as an initialized index.
  - So a repo could hide changed files and produce a silent "no impact".
- **Network.** Telemetry is **on** by default (`TELEMETRY.md`). It is off only with `DO_NOT_TRACK=1` or `CODEGRAPH_TELEMETRY=0`. The update check is off with `CODEGRAPH_NO_UPDATE_CHECK=1`. `upgrade` and `install` are network commands, and `serve` and `daemon` start servers.
- **Structured output.**
  - With JSON: `callers`, `callees`, `impact` (one symbol, depth 1-10, one radius per definition), `files`, `query`, `affected` (tests only) and `status`.
  - Text only: `explore` and `node`.
  - No command maps a file set to its dependent symbols as JSON.
- **First index and sync.**
  - A first index runs with `journal_mode=MEMORY`, `synchronous=OFF` (crash-unsafe).
  - `sync` hashes contents after a size/mtime pre-check, and treats git only as a source of candidates.
  - A concurrent writer gets `LockUnavailableError`.
- **Routes.** The README names route discovery for Express, NestJS and Spring, and screen navigation for Next.js, React Router, Angular and Vue. This has not yet been measured on qayaba's apps beyond §2.6.

## 3. Decision

Adopt **codegraph** as the engine, run it inside the execution sandbox on an exported workspace, and re-point the graph's effort from the agent's context window to the engine's signals, first among them the change pages every role and grader already consumes.

### 3.1 Why this engine

1. **The answer.** `explore` returns verbatim source, the call path and the covering tests in one read-equivalent payload. `search_graph` returns metadata and charges a second and a third round-trip for the same question. One competes with `read`; the other replaces it.
2. **Routes as anchors.** Framework route nodes with their files give change pages a deterministic anchor across JS/TS and Java stacks. That anchor is what makes change pages work for an app whose map is thin, and codebase-memory has nothing comparable.
3. **Repo-relative identity** in everything the agent reads.

**What the swap costs, stated plainly.** For the engine-side questions, codebase-memory is structurally ahead today:

- its Cypher answers a file-seeded question in one structured call;
- its store already lives outside the repo (`CBM_CACHE_DIR`).

codegraph has to pay for both: the workspace export (§3.3) and a structured symbol walk — a JSON command, or a read-only store reader that runs inside the sandbox. That cost is why the decision is gated (§3.6).

### 3.2 Why not the alternatives

- **Keep codebase-memory and write the missing surface.** A composed `explore` over `search_graph` + `get_code_snippet` × N is one spawn per symbol, it still has no source in one call, and it still has no route discovery. That rebuilds the flagship answer on weaker ground.
- **Run both engines** (codebase-memory for signals, codegraph for the agent). That means two indexes per run, two lifecycles, two pins and two security reviews, for an answer one engine can give. It is the fallback only if the gate fails partially (§3.6).
- **Embed the library.** Node 24 is in the image and `node:sqlite` would work. It would avoid a spawn and the `no-child-process-outside-launchers` rule. It is rejected because the engine parses source from repos the system does not control:
  - in-process parsing has no kill and no uid boundary;
  - a hung or compromised orchestrator is a worse failure than a slow query.
- **The MCP server in the agents container.**
  - The store holds every app's code.
  - The agents container runs as root with read-write mirrors (`agents/Dockerfile:46-49`), so nothing would bound what the agent reaches through it.
  - The per-run bound disappears.

### 3.3 Why the execution model changes with the engine

The current CLI already parses untrusted source as root with the container's network. A ~50 MB Node bundle with telemetry on by default would keep both properties if it were simply swapped in. The migration therefore closes the gap:

- **The `graph` launcher profile:**
  - sandbox uid, whose egress chain enforces zero network;
  - an explicit environment allowlist: `DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1`, a per-run `HOME`;
  - a process-tree kill.
- **The workspace export:**
  - only the tracked regular files at the run's SHA;
  - no links;
  - none of the repo's `codegraph.json` or `.codegraph/`;
  - an engine config written by the orchestrator from the language registry and the app's declared exclusions.
- **The root-owned store cache:** it is copied in, synced, validated, and published back by atomic rename under a per-(app, repo) lock, before any agent-influenced code runs. A partial build never reaches it, a spec cannot poison the next run's index, and parallel lanes cannot race.
- **The index cursor** moves into the cache's own metadata, keyed by engine, version and SHA. The mirror-keyed sidecar could otherwise skip indexing after the swap and leave the graph empty.

### 3.4 Why change pages, and why they extend `changeRoutes`

The owner asked for "esta pagina llega a esta accion". The measurement says the missing half is not a new section but reachability.

**Three proof paths**, each bounded and each recorded with the page:

- **Frontend change:** changed symbol → callers → a symbol in a route's implementation files → page.
- **Backend change in the same repo:** changed symbol → callers → handler → operation (by operationId, or by the handler route's verb + path) → the map's `feBe` → page.
- **Across repos:** service symbol → … → operation → ServiceLink → frontend call site → callers in the frontend index → page.

**Why extend `changeRoutes` instead of adding a section:**

- `changeRoutes` already drives DOM capture, the lead's plan, the lead review and the graders, so every one of them improves at once and for every app shape.
- A separate section would duplicate the source of pages, and would serve only the one app with ServiceLinks.

**Bounds:**

- depth;
- hub suppression: a symbol that reaches too many pages adds none and is reported as a hub;
- a per-run page cap;
- each page carries its basis (`implementation | source | spec | graph`), so graders and ablations can separate graph pages from the map's.

### 3.5 Why the lead gets a dossier and not only a tool

The adoption failure is an interface failure, and a tool description is a weak interface.

- The orchestrator puts the engine's read-equivalent answer for the change's top symbols into `static-signal`, inside its existing budget. This works for any model.
- `explore` remains for follow-up questions, with the steering as a linted prompt layer.
- The dossier is on by default: the owner made the code graph part of the grounding (`odd/tasks/codegraph-migration.md`, L38); an app or a run can still turn it off.

### 3.6 The gate

A throwaway spike under the real constraints answers six questions before any production change:

- (a) the store builds, and re-syncs from cache, in an exported workspace;
- (b) a structured way exists to list a file's symbols and walk callers/impact;
- (c) query commands open the store read-only;
- (d) route nodes come with files on at least two frontend stacks and one hand-written backend;
- (e) index, sync and spawn costs on the largest declared app;
- (f) output order is stable.

**Kill criteria:**

- If (a) or (b) fails, the engine swap stops and this ADR is amended. The dossier, the tool rename and the change-page work proceed on the current engine where it can serve them.
- If (d) fails, change pages use the map's routes only.

## 4. Consequences

**Positive**
- **The engine stops running as root with network access.** That gap exists today, independent of the engine, and the migration closes it.
- **A watched repo can no longer configure, pre-seed or redirect the index.**
- **Change pages reach backend and non-map changes for single-repo and multi-repo apps alike.** DOM capture, the lead's plan, the lead review and the graders all inherit this.
- **Tier 2 also matches hand-written controllers and a changed handler.** Today it matches only codegen naming and drops the changed methods themselves.
- **The lead's graph surface goes from three actions to one.** Its benefit no longer depends on a model choosing a tool.
- **Index freshness is recorded per run** (`lastIndexedSha`, `context_fresh`; see `docs/observability-design.md`).

**Negative**
- **A larger artifact enters the image:** a ~50 MB bundle with its own Node runtime, pinned per arch with its integrity hash and provenance. It replaces a small Go binary.
- **Each run pays for a workspace export and a store copy-in/publish.** Their cost is measured by the gate.
- **The engine's CLI JSON is not a published API.** Every command the adapter reads gets a recorded fixture and a contract test, and the pin's re-verification gains a codegraph smoke.
- **The flagship command is text.** The proxy cuts it at file boundaries, never inside a code block.
- **Graph reachability over-approximates from hub modules.** Hub suppression and the per-page basis bound it, and the ablation measures it.
- **The graph cannot cross repositories, in either engine.** The union stays a contract join that qayaba owns. This ADR records that as a property, not a gap to close.

**Risks**
- **Unverified engine facts** (§3.6 (b)-(d)) decide feasibility. The gate exists for them.
- **Resolution accuracy is untested** against the current engine on real apps.
  - Mitigation: a side-by-side parity check on known commits of a Java and a JS/TS app before the old engine is removed.
  - Mitigation: precision/recall of `changeRoutes` against labelled commits.
- **Widening `changeRoutes` moves grader baselines.** The basis per page is recorded and the baseline is re-recorded with its reason.
- **The multi-repo path is unproven, not working:** 3 runs, 0 verdicts. Its acceptance follows a green cross-repo run; it does not block the single-repo acceptance.
- **Adoption is not guaranteed.** It is judged on outcomes: change-page recall, route coverage, change-coverage, verdicts, and the plan turn's reads/tokens/duration. It is never judged on calls. A baseline is recorded before the surface changes.

## 5. What this ADR does not decide

- **Unit-test selection with `affected`.** Whether `--target code` should use it is deferred to its own change, with its own evidence.
- **The unused boundary profiles.** Whether `event` and `http-backend` should be enabled for any app, or the stitcher's call-site catalog widened, is a product decision. Today they are code without a caller.
- **The context map builder's Angular-specific instructions** (`prompts.ts:972,990`, the architecture-mapping skill). This is an agnosticism defect with its own change; §3.4 reduces its effect on change pages but does not fix it.
- **Deriving the context map from the graph.** It cannot be done for OpenAPI-codegen backends (0 route nodes). For frontends it is open until the gate's route measurement.
- **The dead extractor installs** in the image (`Dockerfile:72-85`). A separate cleanup.
- **The reviewer, publication, and change-coverage itself.** Nothing here changes any of them.
