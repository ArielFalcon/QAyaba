# Code graph engine: codebase-memory-mcp → codegraph

Objective: replace the code graph engine with codegraph, run it as what it is — a parser of untrusted source — and make the graph earn its keep for any app: the structural signal, a fixed tier 2, and change pages that reach backend and non-map changes ("this page reaches this action"). No application-specific branch, no model-specific tuning, no new agent capability beyond one read-only action.
Branch: the current working branch (single-branch rule, owner 2026-10-12); governance-sensitive tasks (T2, T7) each in their own commit. Delivery: ask-on-risk, slices recorded as commit ranges (forecast ~2 000-2 600 authored lines). Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24). T0 is a go/no-go gate: nothing after it starts until it passes.

## Specs

- **S0** (every phase — any app): the owner's goal is that this "mejore la calidad del analisis y los test generados por qayaba al ejecutarse contra cualquier aplicacion, no solo las que estan registradas y probandose ahora". Every behaviour below is defined on the language registry's declared scope (Java, JS/TS) and on framework-neutral keys (a route's `implementationFiles`, an operation's verb + path, its operationId), never on one app's naming, layout or stack. No default changes until it is validated on at least one Java and one JS/TS app, single-repo, and on a multi-repo app once one reaches a verdict. Nothing names or assumes a model.

### Phase 0 — gate

- **S1** (go/no-go spike): before any production change, a throwaway spike in the orchestrator image, under the real constraints (sandbox uid, no egress, read-only source, an exported workspace per S3), answers with evidence:
  - (a) a store builds in an exported workspace and a cached store re-syncs there incrementally;
  - (b) a structured (JSON) way exists to list a file's symbols with line ranges and to walk callers/impact from one;
  - (c) whether the query commands open the store read-only;
  - (d) route nodes with their component/handler file, on at least two frontend stacks and one hand-written backend;
  - (e) index time on the largest declared app, cached re-sync time, and the cost of one CLI spawn;
  - (f) whether output order is stable across identical runs.
  - Every command the adapter will read gets a recorded fixture.
  - **Kill criteria:** if (a) or (b) fails, the engine swap stops (ADR-0002 is amended). S13-S15 then proceed on the current engine; S10 proceeds only through the keys that engine can serve. If (d) fails, S12 falls back to the map's routes only.
  - When no CLI command answers (b) in JSON, the fallback is a schema-pinned, read-only reader of the store. It is shipped with qayaba and runs in the S2 profile, never in the orchestrator process. A contract test runs it against a recorded store fixture.

### Phase 1 — engine, isolation, lifecycle

- **S2** (isolation — how the engine runs):
  - **Execution:** the engine runs only through the execution launcher, in its own `graph` profile:
    - the sandbox uid, whose egress chain enforces zero network;
    - an environment built from an explicit allowlist (`DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1`, a per-run `HOME` and `TMPDIR`);
    - a bounded time and a kill of the whole process tree.
  - **Never:** as root, inside the orchestrator process, or as an MCP client, daemon, watcher or server. No code path can reach `serve`, `daemon`, `ui`, `upgrade`, `install`, `init`, `uninit` or `telemetry`.
  - **Degrade:** a spawn error, a timeout, a non-zero exit or unparsable output becomes a typed unavailable result.
  - **Plain runner:** the plain-runner "trusted binary" path is left to git alone (`.dependency-cruiser.cjs:77` and `sandboxed-binary-runner.ts:30` say so).
  - Why: the engine parses source from repos the system does not control. Today the graph CLI runs as root with the container's full network (L17.3). This migration closes that gap instead of inheriting it.
- **S3** (workspace — what the engine reads): the engine never indexes a mirror.
  - **Build:** per repo and run, the orchestrator builds a graph workspace outside the mirrors from the files tracked at the run's SHA. It holds regular files only (no link) and never the engine's own config (`codegraph.json`, `.codegraph/`).
  - **Engine config:** the orchestrator writes it itself. Extensions come from the language registry's declared scope and exclusions from the app's config (data, never code).
  - A watched repo can therefore neither configure, pre-seed nor redirect the index (L16.2), and the store never lands inside a mirror (L16.1).
- **S4** (store lifecycle):
  - **Cache:** one persistent store cache per (app, repo), root-owned `0700`, outside every path the sandbox uid can reach. The file-boundary check proves the sandbox uid can neither list nor write it.
  - **Per run:**
    1. Copy the cache into the workspace.
    2. Run `sync` (a full `index -f` when there is no cache or the engine version changed).
    3. Validate: the index is ready, its commit stamp is the run's SHA, and the node count is above zero.
    4. Publish the store back to the cache by atomic rename, before any agent-influenced code runs, under a per-(app, repo) lock so parallel lanes cannot race.
  - **Failures:** a failed or partial build never reaches the cache (a first index runs with `synchronous=OFF`, L16.5).
  - **Cleanup:** the workspace is removed when the run ends.
  - **Cursor:** the index cursor lives in the cache's own metadata, keyed by engine, engine version and SHA. The mirror-keyed `data/index-status.json` sidecar is retired, so a swapped or wiped store is never skipped as "already indexed" (L17.6).
- **S5** (which repos): a run indexes every repo its signals read.
  - That is the triggering repo and, on a service-triggered run, the primary (frontend) repo too (L18.6).
  - Each repo has its own budget, and each fails open on its own.
  - Onboarding builds the first cache through the same path (`src/index.ts:580-623` today).
- **S6** (provenance): per indexed repo, a run records:
  - the engine version, the SHA and the outcome (`built | synced | reused | failed | timeout | skipped`);
  - the duration and the node and edge counts.
  - The structural signal, the change pages (S10) and the tool answers carry the SHA of the index they read. This is ADR-0001's `lastIndexedSha`, feeding `context_fresh`.
- **S7** (port contract):
  - `CodeGraphPort` keeps its typed degrade.
  - The dead `existingCoverage` and `structurallyRelated` are removed, not re-backed (L17.2).
  - `coChangeCoupling` moves to git history through the trusted git runner; co-change is a history question, not a graph one.
  - The adapter returns repo-relative POSIX paths and sorted, de-duplicated results, so a prompt section hashes identically for identical inputs.
  - No engine identifier, absolute path or engine format crosses the adapter.

### Phase 2 — signals the engine computes

- **S8** (structural signal): `impactedSymbols` and `callersOf` are re-backed on S1's structured path.
  - **Seed:** the changed symbols of the diff (changed hunks ∩ symbol ranges).
  - **Budget:** a declared per-run budget (symbols, concurrency, wall time) that a hub module cannot blow.
  - **Depth 0:** the changed symbols themselves are part of the impact; today they are dropped (`codebase-memory-code-graph.adapter.ts:135`).
  - **Parity:** on known commits of a Java and a JS/TS app, both engines' answers are compared before the old engine is removed.
- **S9** (tier 2): a link is impacted when its operation is reached from a changed symbol by either key.
  - The keys are the operationId (codegen interfaces name the method after it) or the handler's verb + path from the engine's route node (hand-written controllers).
  - A changed handler counts.
  - Tier 2 gets the same budget as S8.
  - Tier 1 and the link layer (OpenAPI FE→BE, BE→BE, events) do not change and do not depend on the graph. When the graph is unavailable, tier 1 and the rendered links work as today.
- **S10** (change pages — the owner's "la funcionalidad \"esta pagina llega a esta accion\""):
  - **Proof paths:** the graph adds pages to `changeRoutes` through one of three proof paths. In each, callers are walked within S8's budget.
    - **Frontend change:** changed symbol → callers → a symbol in a route's implementation files (the map's `implementationFiles`, or the engine's route node file per S12) → page.
    - **Backend change in the same repo:** changed symbol → callers → handler → operation (S9's keys) → the map's `feBe` → page.
    - **Across repos:** service symbol → callers → handler → operation → ServiceLink (`contractRef`) → frontend call site (`from.file`, `from.symbol`) → callers in the frontend index → route component → page.
  - **Output:** it extends `changeRoutes`. There is no new prompt section and no second source of pages, because `changeRoutes` already drives DOM capture, the lead's plan, the lead review's unvisited/unproven pages (`9520f272`) and the route-coverage graders.
  - **Basis and proof:** each page carries its basis (`implementation | source | spec | graph`) and its shortest proving path (symbol and file names, never source). Graph pages rank after the map's direct links.
  - **Bounds:**
    - depth;
    - hubs: a changed symbol that reaches more than N pages adds none and is reported as a hub, with its count;
    - a per-run page cap.
  - **Degrade:**
    - no index leaves today's `changeRoutes` unchanged;
    - an absent edge never removes a page the map links;
    - the result is computed per run and never persisted with the context map (L18.7).
- **S11** (composition, not duplication): the change-page join consumes the stitcher's links and the map as they are. It never re-resolves a contract, never becomes a link source, and never derives an edge the stitcher already decides. When the stitcher emits no link for a symbol, no cross-repo page is claimed for it; an absent edge never implies an absent dependency.
- **S12** (routes): the map remains the source of page names and flows.
  - Where the engine's route nodes give a route's component or handler file and the map lacks it, the join uses the engine's file.
  - A disagreement between the map and the engine is recorded in the run, never resolved silently.
  - Measured limit: an OpenAPI-codegen Spring backend yields 0 route nodes (the annotations live in the generated interface), hence S9's operationId key.

### Phase 3 — the lead's surface

- **S13** (agent tool): the lead's graph surface is exactly one read-only action, `explore`.
  - **Who:** the lead is `qa-generator` without a delegation. Sidekicks and the other roles never get it, and neither does Codex (a custom tool is OpenCode's).
  - **Admission:**
    - 1-N terms, each at most 200 characters from an identifier/path character set;
    - a term never starts with `-` and is passed after `--`;
    - the project and the workspace come from the run, never from the agent;
    - `--max-files` and the character cap are decided by the orchestrator per call.
  - **Steering:** the tool description carries what the engine's MCP handshake would have said ("treat the shown source as already read; do not re-open those files") as a linted prompt layer. The "for text, templates and selectors use grep and read" line in `agents/AGENTS.md` and `agents/tool/codegraph.ts` is reconciled with it.
  - **Answers:** redacted as text, by value and by pattern, and cut only at a file boundary with an omission marker, never inside a code block.
  - This changes a security invariant (the admitted query shape), so it is its own commit.
- **S14** (deterministic change dossier): the lead's plan turn receives the engine's read-equivalent answer for the change's top changed symbols, inside the existing `static-signal` section and its budget.
  - So the benefit does not depend on any model choosing a tool, and a Codex lead gets it too.
  - The files it shows count as prompt-provided in `prompt_provided_read_count`.
  - It ships behind the structural-signal mode; whether it is on by default is decided by S16.
- **S15** (sidekick brief): each sidekick brief carries the S10 proof path of its flow's pages (symbol and file names, no source), bounded per brief, so its assertions aim at the changed behaviour.

### Phase 4 — acceptance and removal

- **S16** (measured acceptance): defaults change only through ADR-0001's ablation harness.
  - **Variants:** baseline vs graph variants, at least 3 replicates.
  - **Apps:** one Java and one JS/TS app, single-repo, plus a multi-repo app once it has a green run.
  - **Outcomes:**
    - precision and recall of `changeRoutes` against a labelled set of at least 5 commits per app (drafted from the code, confirmed by the owner);
    - `plan_route_coverage` and `delivered_route_coverage`;
    - change-coverage ratio;
    - verdicts;
    - plan-turn reads, greps, tokens and duration;
    - redundant and prompt-provided reads.
  - "Calls > 0" is not a criterion. A regression on any outcome blocks the default it would change.
- **S17** (removal): codebase-memory goes only after S1 passed and S8's parity check. One commit removes, together:
  - the binary pin and the volume;
  - the env and the entrypoint and file-boundary lines;
  - the client and the adapters;
  - the seam contract tests;
  - the docs (L17.1's list).

## Out of scope (do not do these here)

- **`affected` does not replace change-coverage.** Measured: `affected --filter "e2e/*"` returns empty for an app-source change, because Playwright specs do not import app source. From a hub module it maps one leaf change to ~50 test files (2 at depth 1). Change-coverage stays the objective signal. `affected` may feed unit-test selection in `--target code`, in its own change.
- **The MCP server in the agents container.** The store holds every app's code; the agents container runs as root with read-write mirrors, so nothing would bound what the agent reaches; and the per-run bound disappears. If ever revisited, it ships alone as a governance change.
- **The watcher, the daemon and the shared-server socket.** The workspace is fixed per run; an explicit sync is auditable, a background writer is not.
- **Enabling the `event` and `http-backend` boundary profiles**, or widening the stitcher's call-site catalog (today only `<receiver>.(get|post|…)(`). These are product decisions with their own validation.
- **The context map builder's Angular-specific instructions** (`prompts.ts:972,990`, `agents/skill/architecture-mapping/SKILL.md`). This is a real agnosticism defect; S12 reduces its impact on change pages but does not fix it. It gets its own change.
- **The dead extractor installs** (lizard, difftastic, tree-sitter at `Dockerfile:72-85`; the code was deleted in `9bef64c6`). This is a separate image cleanup.

## Tasks

| ID | Specs | Route | Risk | Status | Commit |
|---|---|---|---|---|---|
| T0 | S1 | inline (scratch container; no repo write) | item 5 (environment, measured only) | done — GO (L23); the fixtures are recorded with the adapter in T4 | — |
| T1 | S16 (baseline), S6 | inline | none | done — `code_graph` bucket; `graph_provided_read_count` persisted, in the contract and in `probe-report` JSON. The labelled sets and the baseline round move to T9 (L25) | `1b21e72b` |
| T2 | S2 | inline | item 2 (sandbox, egress) + item 5 (pinned binary) — own commit | done — profile, pin (sha512 per arch, checked in the build), docs; `sandbox:smoke` 22 + 5 checks green in the rebuilt image. The arch-rule comment moves to T10 with the plain-runner cleanup | `cf1bdef3` |
| T3 | S3, S4, S5, S6 | inline | item 2 (file boundary) + item 5 (new cache) | done — workspace export, store cache (lock, validate, publish through the confined reader, cursor in `meta.json`), sidecar retired, primary repo indexed on service runs, onboarding through the same path, provenance as the `qayaba.code_graph.index` span (L26) | `604efe78` |
| T4 | S7, S8 | inline | item 3 (`CodeGraphPort` consumers) + item 6 | done — port re-backed on the store reader, one walk per change, co-change from git, dead methods and the old adapters removed, `seam-parity` updated; parity (S8) run offline from the base commit (L28) | `604efe78` |
| T5 | S9 | inline | item 6 (only a live run proves a blast radius) | done — both keys (operationId reached; a reached handler whose route serves the link's operation, verb + path, parameters matching and a one-sided prefix tolerated), a changed handler counts (depth 0), the S8 budget; `MATCH_TIER` unchanged; HTTP links carry their contract operation (optional `operation`) | (L27) |
| T6 | S10, S11, S12 | inline | item 3 (`changeRoutes` consumers: graders, lead review, DOM capture) + item 6 | done — the join (three proofs, hubs, cap, disagreements) in `qa-run-orchestration/domain/change-pages.ts`; graph pages rank after the map's links in the pack (so DOM capture, the plan, the lead review and the graders see them); basis per page on the route-ranking span; the join on `qayaba.code_graph.change_pages`; graph pages scored apart; independent verifier: one blocker (operationId key needed a route node), fixed (L30, L31) | `e516984a`, `ab164e67` |
| T7 | S13 | delegated (writer reason: parallel unit with T5/T6, disjoint surface; worktree) | item 2 (agent tool surface invariant) — own commit | done — `explore` replaces the three actions (admission, endpoint, adapter, tool file, client); answer redacted then cut at file boundaries; agent-list fixture re-recorded in the agents container; codegraph smoke 14/14 in the image; independent verifier: no blockers (L29) | `56c2ae43` |
| T8 | S14, S15 | inline | item 3 (prompt contract) | done — sidekick proof path (S15) and the change dossier in `static-signal` behind `grounding.dossier` / `qa.structuralSignals.dossier` (off by default, the T9 lever); prompt-contract matrix: 0 findings, no baseline re-record needed (L31) | `03af259f`, S14 commit (L31) |
| T9 | S16 | per-action workers (long runs) | item 6 | pending — the ablation rounds; the verdict per default in the Log | |
| T10 | S17 | inline | item 5 | pending — the removal commit | |

Order: T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10.
- Every task is inline. No unit has a writer reason: each depends on the one before it (T6's backend path uses T5's operation keys).
- T7 depends only on T2-T3 and may move earlier if the gate passes and the signals stall.
- T9's runs go to per-action workers because they are long.

## Log

- **L1** (2026-10-25) owner's request that opened the work: "llevo tiempo peleando para que los agentes usen codebase-memory-mcp pero es imposible, ni dentro de qayaba ni en el harness de opencode personal para programar. No se que le pasa a ese mcp pero es inutil hacer que los agentes lo usen. Quiero que evalues la alternativa https://github.com/colbymchenry/codegraph a ver si se adecua bien a qayaba y si no tiene este mismo problema y los agentes lo pueden aprovechar para analizar y entender el proyecto que prueban de forma optima"
- **L2** (2026-10-25) owner asked for a decision, not an option list: "quiero que me des una decision como arquitecto de software del proyecto. que harias, solucionar el problema de codebase-memory o sustituirlo por codegraph y adaptar la arquitectura para aprovecharlo al maximo para los objetivos de la app. a nivel de herramienta cual es mejor y se adapta mejor a nuestras necesidades. que alternativa tiene mas ROI"
- **L3** (2026-10-25) owner's request for these documents: "redacta un documento o serie de documentos ODD sobre rodo el peoceso de implementación detallado con la información que has recopilado para hacer la migración a codegraph óptimamente. agrega las mejoras que describes del tier 2 del stitcher, incluyendo la mejora para la mitad infra-repo faltante que describes, para la funcionalidad \"esta pagina llega a esta accion\"."
- **L4** (2026-10-25) evidence — adoption is zero, not slow. `data/qayaba.db` at 300 `agent_turns` / 5 479 calls: `read` 2 273, `grep` 894, `glob` 525, `edit` 170, `codegraph_*` **0** (17 Serena calls, ~296 `authbrowser_*`, 95 `run_spec`). It was not a wiring fault: `run-75f5390` recorded `structuralSignal: "signal"`, and inside the container the store held `app-.mirrors-joomeco__name-webapp` with 9 433 nodes written during that same run. The tools were granted and never called.
- **L5** (2026-10-25) evidence — root cause measured over the MCP handshake in a scratch install of codegraph 1.6.2 (removed afterwards): `codebase-memory-mcp` sends **0 bytes** of `initialize.instructions`, 14 tools, 12 039 B of schema; `codegraph` sends 6 718 B of imperative instructions, 1 tool, 1 788 B. The steering the model needs was never in the context. Secondary wastes measured on the same repo: `qualified_name` embeds the absolute path in every symbol, and `search_graph` returns metadata only, so source costs a second call and callers a third — 3 calls / 5 422 B for a question `explore` answered in 1 call / 25 157 B including verbatim source.
- **L6** (2026-10-25) evidence — the engine is fast enough for a per-run index: ai-pipeline (1 426 tracked files) → 29 190 nodes / 104 930 edges in 7.1 s, 127 MB store; `ms-name-restaurants` (328 Java files) → 4 779 nodes in 963 ms, 14 MB store. The Java survey returned the controller → service → port → adapter chain with the covering unit tests in one call.
- **L7** (2026-10-25) evidence — the stitcher does **not** use the graph, contrary to the working assumption. `resolver-factory.ts:10-14` maps `http` → `OpenApiHttpResolver`, `event` → `EventResolver`, `http-backend` → `HttpBackendResolver`; none receives the graph client, and all three read mirrors through `RepoReader`. The last production prompt shows all 18 links with `source openapi-http`. The graph appears in one place only: `resolve-cross-repo-impact.use-case.ts:63`, `codeGraph.impactedSymbols(...)`, the tier 2 of a cross-repo impact.
- **L8** (2026-10-25) evidence — the stitcher's value is real and its coverage is thin. The rendered section is 4 842 B of a 45 221 B prompt (10.7 %) for 18 links plus 6 drift warnings; those warnings name endpoints the front calls that the backend contract does not declare (`users/{userId}/rewards`, `/achievements`, `/stats`, `/tier`, `orders/{id}/reorder`, `GET orders`). Against that: only **3** cross-repo runs exist in the whole history and all three failed (`infra-error`, `invalid`, `invalid`); `event` and `http-backend` are implemented and **no app declares them** — `name-webapp` is the only app with `boundaries`, and only `transport: http`.
- **L9** (2026-10-25) decision (recorded in `docs/adr/0002-code-graph-engine-codegraph.md`): replace the engine, keep the architecture. The seam (`/internal/codegraph`, the registry, the service token, redaction by value, per-run limits) is unchanged, which is why this is a swap and not a rewrite. The adoption failure is fixed by the surface, not by the engine — with the CLI path the engine's own instructions never reach the model, so the steering becomes ours and gets linted like any other prompt layer.
- **L10** (2026-10-25) design fact that changes T4's shape: `explore` and `node` have **no** `--json` in 1.6.2 (the README says otherwise; `callers`, `callees`, `impact`, `files`, `query`, `affected` and `status` do). So the proxy's structural cutting applies to the structured commands, and the flagship answer is redacted and cut as text. `shapeAnswer` already has that branch.
- **L11** (2026-10-25) design fact that bounds T6: `impact` takes a symbol, `explore` takes "a bag of symbol or file names". The file set is the engine's input, so tier 2 is one survey seeded with the changed files. Looping `impact` per symbol would spend the 40-call / 20 s budget on spawns.
- **L12** (2026-10-25) design fact that bounds T7: on the OpenAPI-codegen Spring app the engine emitted **0 route nodes** (annotations live in the generated `*Api` interface), so S12 holds — the context map stays the route source. The join therefore starts from the map's routes and only adds the component → API-symbol edges the graph can prove.
- **L13** (2026-10-25) open item, unrelated to this feature but found while reading: `docs/agent-reference.md` is untracked in the working tree. T4 and T7 both edit it; whoever takes them should confirm whether it is meant to be committed before the tasks land.
- **L14** (2026-10-25) Engram mirror written: the evaluation under `code-graph/mcp-adoption`, this plan under `odd/codegraph-migration/tasks`. No source file was changed by this document; T1-T8 are all pending and need an explicit go-ahead.
- **L15** (2026-10-25) owner's request for an architecture review of this plan and ADR-0002: "eres un arquitecto de software, tienes que evaluar la calidad de las propuestas de cambios de odd/tasks/codegraph-migration.md y docs/adr/0002-code-graph-engine-codegraph.md con el objetivo de corregir cualquier problema estructural que puedas encontrar, optimizar y hacer mas robusta la implementacion. Tu objetivo es mejorar las propuestas si es necesario, para resolver cualquier problema detectado y que la implementacion tenga la mayor calidad posible y mejore la calidad del analisis y los test generados por qayaba al ejecutarse contra cualquier aplicacion, no solo las que estan registradas y probandose ahora."
- **L16** (2026-10-25) review findings, NOT yet applied to the Specs/Tasks above (the review was cut short; apply them before T1). Engine facts are confirmed from the v1.6.2 source on GitHub (`src/directory.ts`, `src/project-config.ts`, `src/bin/codegraph.ts`, `src/db/index.ts`, `src/extraction/index.ts`, `TELEMETRY.md`); the rest are design findings to verify against HEAD.
  1. **S2 is unimplementable as written (confirmed).** The store is always `<projectRoot>/.codegraph/codegraph.db`; `CODEGRAPH_DIR` only renames the folder (no `/`, `..` or absolute path) and there is no `--db`/home switch. `index` needs write access to the project root (mkdir, `codegraph.lock`, `-wal`/`-shm`). The mirror is not writable by the sandbox uid. S2 must name a mechanism: index a per-run copy, or a `.codegraph` mount/link created by the orchestrator before the tree is sealed (unverified that the link is followed for writes).
  2. **A watched repo can steer the engine (confirmed).** It reads a root `codegraph.json` (`include`, `exclude`, `includeIgnored`, `extensions`) and treats a repo-shipped `.codegraph/codegraph.db` as an initialized index. A hostile or careless repo can hide changed files from the index and produce a silent "no impact". This breaks the "a watched repo cannot configure the agent" invariant unless the orchestrator removes/ignores both before indexing. New spec needed; T1/T2 become Risk item 2.
  3. **Telemetry needs three switches plus the egress filter (confirmed).** `DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1`, a throwaway `HOME`, and the process must run as the sandbox uid under the offline profile so the iptables chain enforces zero egress. Run as the orchestrator uid, no filter applies. `upgrade`, `install`, `serve`, `ui`, `daemon` must be unreachable from the admitted command set.
  4. **S8 has no command to run (confirmed).** `explore` has no JSON; `affected` returns test files only; no command maps a file set to dependent symbols/files as JSON. `impact <symbol> -d -j` and `callers -j` are per symbol. Tier 2 must either loop `impact -j` over the changed exported symbols under one bounded budget, or parse `context --format json` (unverified that it is seedable by files). Parsing `explore` text for a deterministic join is rejected.
  5. **First index is crash-unsafe (confirmed):** a fresh index runs with `journal_mode=MEMORY`, `synchronous=OFF`. Build the store off to the side, validate, then publish it; `sync` throws `LockUnavailableError` on a concurrent writer, so parallel lanes need one store per lane or a lock. Use `index -f` when mtimes may lie (mirror restores).
  6. **The plan ignores the lead + sidekicks target.** The graph's consumer is the lead's plan turn, which already receives `PlanningLimits.changeRoutes` (the pages of the map the change is linked to, `docs/agent-reference.md`). S10 `PageReach` must strengthen `changeRoutes` (reverse reachability changed symbol → map page, for every app, single-repo included), with the ServiceLink hop as the multi-repo extension — not a parallel prompt section that serves one app shape.
  7. **Adoption must not depend on the model choosing a tool.** Add a deterministic, budgeted "change dossier" seeded with the diff's symbols (works for OpenCode and Codex alike); keep `explore` for follow-ups. Replace S7's "calls > 0" with outcome metrics through ADR-0001's ablation harness (reads/tokens/duration of the plan turn, change-coverage ratio, verdicts; ≥3 replicates, ≥2 stacks).
  8. **T1 deletes the old engine before the parity check the ADR names as its mitigation.** Keep both adapters until T3's head-to-head on known commits passes; delete in a final commit.
  9. **T4 is Risk item 2, not "none":** `explore` takes free text; the admission must pass terms after `--`, reject a leading `-`, bound count/length, and never derive the project/store path from agent input. Cut text answers at file boundaries with an omission marker, never mid code block.
  10. Smaller: T5 (baseline) must run before T4; record `lastIndexedSha` + index outcome as provenance (ADR-0001); sort/dedupe engine output for byte-stable `section_hashes`; pin the npm platform package with its integrity hash and provenance; the heading "Riesgo por tarea" must be English; the branch line contradicts the single-branch rule; T8 should not hinge on the unrelated cross-repo failures.
- **L17** (2026-10-25) seam facts checked against HEAD of `fix/failure-observation-conflict`; they contradict parts of L7, S1, S4, T2, T3 and ADR-0002 §1-§3. Apply with L16.
  1. **The graph is used in more places than tier 2.** The structural signal calls `impactedSymbols`, `coChangeCoupling` and `callersOf` on every run (`structural-signal-port.adapter.ts:19,28,37`, rendered at `ground.steps.ts:149-151`). Onboarding also indexes (`src/index.ts:580-623`). T1-T6 must re-back these too. T1's removal list also misses `src/index.ts:63,580`, `src/server/file-boundary.ts:40`, `bin/container-entrypoint.sh:48`, `docs/execution-sandbox.md:83` and `seam-parity.contract.test.ts:261-263,350`.
  2. **T3 names dead methods as live.** `existingCoverage` and `structurallyRelated` return `ok([])` (`codebase-memory-code-graph.adapter.ts:350-365`). The live set is `syncTo`, `impactedSymbols` (2 callers), `coChangeCoupling` and `callersOf`. Does codegraph cover `coChangeCoupling` at all? Unverified; it may need git history instead.
  3. **S1 "exactly the shape today" means root, no sandbox uid and the container's full network.** Today's client is a plain detached spawn of a "trusted binary" (`sandboxed-binary-runner.ts:30`, `.dependency-cruiser.cjs:77`, `Dockerfile:110`). A Node bundle parsing untrusted source must instead run under a sandbox profile (sandbox uid, offline egress). This is a change to the seam, not a swap behind it.
  4. **S4's motivation is wrong.** The `blast.changedFiles` join (`resolve-cross-repo-impact.use-case.ts:57`) never touches the graph. Tier 2 joins on the bare `symbol` name (:65-69), and the port already returns repo-relative `file_path`. Keep S4 only as an adapter contract.
  5. **L11's 40-call / 20 s budget belongs to the agent tool** (`DEFAULT_CODE_GRAPH_TOOL_LIMITS`, `shared-kernel/code-graph-tools.ts:18`). Tier 2 has no call budget, only the client's 60 s default. T6 must define its own budget.
  6. **The index sidecar is keyed by mirror, not SHA, and lives apart from the store** (`data/index-status.json`, `index-status-port.adapter.ts:34-56`). After the engine swap, a stale `lastIndexedSha` skips `syncTo` and the graph comes back empty. Key the cursor by engine plus mirror, or invalidate it in T1.
  7. **ADR §3: `ComplexityHotspot.cognitive?` exists** (`static-signal.ts:7`), but nothing fills it.
  8. **ADR: the agents container already has read-write mirrors as root** (`agents/Dockerfile:46-49`), so the "needs write access" argument against the MCP server is wrong. The decisive argument is the store holding every app's code.
  9. **S7: per-turn tool names are already persisted** (`agent_turns.tool_sequence`, `history.ts:128`) and shown in `probe-report` (`byTool`). Redundant/prompt-provided read counters exist (`history.ts:116-121`). Missing: a `codegraph_*` bucket (today it falls into `other`, `tool-call-taxonomy.ts:106-107`) and an "already shown by the graph" read count.
  10. Confirmed facts: no parallel lanes exist (the queue is sequential); the lead (`qa-generator`, non-delegated) already has the tools (`lead-review-loop.md` T3, `03431e0b`); there is no codegraph smoke in `agents/smoke/`.
- **L18** (2026-10-25) topology and change-analysis facts checked against HEAD; they reshape S8-S12, T6 and T7. Apply with L16 and L17.
  1. **The extractors the ADR says the graph supplements are gone.** lizard, difftastic and the tree-sitter extractors were deleted in `9bef64c6`, and `StaticSignal` has no producer. Only their Dockerfile installs remain (`Dockerfile:72-85`). The structural signal is the graph alone. The "Replacing lizard…" out-of-scope line and ADR §1/§3 are stale.
  2. **Change → pages already exists.** `route-ranking.ts:61-107` links a route when a changed file matches its `implementationFiles` or `source`, or when a changed spec reaches it through `feBe.operationId`. The result becomes `changeRoutes` and drives DOM capture, the lead's plan, review and the `plan_route_coverage`/`delivered_route_coverage` graders. The real gap: a backend change that does not touch the spec links no page (a Java controller or service, a same-repo backend). S10 must extend `changeRoutes` with graph reverse reachability. The changed symbol walks callers up to a symbol inside a route's `implementationFiles`; for a backend symbol, it walks to the operation and then through `feBe`. Do not add a new section; one already exists (`change-pages`).
  3. **PageReach as specified fits one app shape.** ServiceLinks exist only with `services` + `boundaries`, a `<receiver>.(get|post…)(` call (`call-site-catalog.ts:21-41`), one YAML OpenAPI per service and a `{service}` URL token. Only name-webapp declares them; petclinic and jhipster-store (monorepos) get zero edges. The same-repo path must not depend on ServiceLinks.
  4. **The context map's route source is not agnostic.** It is agent-built from Angular-specific instructions (`prompts.ts:972,990`, `agents/skill/architecture-mapping/SKILL.md`). codegraph has framework route discovery (Express, NestJS, Spring, React Router, Next.js, Angular, Vue per its README). A deterministic route seed from the graph, validated against the map, is the transversal improvement. S12's "0 route nodes" was measured on one OpenAPI-codegen app only.
  5. **Tier 2 is already file-seeded and has no budget.** It makes 2 spawns, `LIMIT 200`, depth 3. It matches only when `operationId` equals the backend method name, and it drops the changed methods themselves (`codebase-memory-code-graph.adapter.ts:135`). So editing the controller method never hits tier 2. Fix both; they are the real tier-2 defects. Tier 1 marks every link of a service on any spec edit.
  6. **On a service-triggered run only the service mirror is indexed** (`opening.steps.ts:76`). A frontend-side join needs the primary mirror indexed too.
  7. **Persisting PageReach with the context map would carry stale edges.** Map reuse checks only the files the map names (`context-map-validity.ts:11-12`). Compute PageReach per run and never store it in the map.
  8. **Corrections to ADR §2.5.** Confidence 0.6 on openapi-http means a placeholder matched a path parameter, not a stem match. `*.api.ts` is name-webapp's `frontFiles` config, not engine code. The deterministic spec→`feBe`→route join already exists.
  9. **A new prompt section needs a new `FactId`** in `prompt-contract-lint.ts` and a re-recorded `scripts/prompt-contract-baseline.json` (`--allow-increase`). Extending `changeRoutes` avoids both.
- **L19** (2026-10-25) L16-L18 applied. Specs were rewritten as S0-S17 and the tasks re-planned as T0-T10, each with its Risk line; the old "Riesgo por tarea" section was folded into the table. ADR-0002 was revised in place and is still Proposed. The engine decision stands, now behind the T0 gate.
  - **Why the decision stands:** codegraph's read-equivalent answer serves the lead, and its framework route nodes give change pages a deterministic anchor across stacks. codebase-memory has neither.
  - **What it costs:** codebase-memory's Cypher already answers file-seeded questions in one structured call, and its store already lives outside the repo. codegraph has to pay for both: the workspace export (S3) and a structured symbol walk (S1(b)).
  - **Why a gate:** three facts that decide feasibility are unverified — S1(b), (c) and (d).
- **L20** (2026-10-25) context found while applying L16-L18.
  - `9520f272` (another session, same day) makes the lead review report the change pages its plan leaves unvisited or unproven, so extending `changeRoutes` (S10) feeds it directly.
- **L22** (2026-10-25) owner's go-ahead for the full implementation: "en odd/tasks/codegraph-migration.md y docs/adr/0002-code-graph-engine-codegraph.md estan los detalles de implementacion del plan para integrar codegraph y quitar codebase-memory-mcp. Las entradas de engram tienen informacion desactualizada sobre este tema, quienes mandan son estos documentos. Quiero que revises los planes y el codigo para que hagas la implementacion completa en esta rama. Si se puede paralelizar la implementacion para agilizarlo con worktrees hazlo, si no se sacrifica calidad de implementacion. Cualquier duda que tengas ahora o durante la implementacion me las haces por si se debe corregir o mejorar algo."
- **L23** (2026-10-25) T0, host half (macOS arm64, `@colbymchenry/codegraph@1.6.2`, integrity `sha512-hODH/mGnCf3IUMs6rzktv/zbecJIKJfdZAYHZ9mqecb0G7ZkHaA8CZafDVnswANFEL1YFcG+lfAwc5SIXzUH6Q==`, workspaces from `git archive HEAD`, `env -i` with the S2 allowlist and a throwaway `HOME`). The container half (sandbox uid, zero egress, linux bundle) is blocked: the Docker Desktop engine answers HTTP 500.
  - **Packaging:** each platform package (`codegraph-linux-x64`, `-linux-arm64`, …) is self-contained: `bin/codegraph` (sh) + its own `node` (~120 MB) + `lib/`. The npm shim is not needed. `init -y` is the non-interactive first build; `index` refuses an uninitialised path. `index -f` means "index even a home/root path", **not** a forced rebuild. `HOME` stays untouched.
  - **(a) pass:** `init -y` builds in the exported workspace; copying `.codegraph/` into a fresh export and running `sync` re-hashed only the edited file (name-webapp, 17 717 nodes: 0.68 s). `status -j` has no commit stamp, so the SHA cursor must live in qayaba's cache metadata (S4 already says so).
  - **(b) pass through the fallback:** `callers -j` and `impact -j -d N [-f file]` are structured per symbol (`targets`, `definitions[].affected[]` with `filePath`/`startLine`, `ambiguous`, `truncated`). No command lists a file's symbols with **end** lines (`node -f --symbols-only` is text, start lines only). The store is SQLite (`nodes(id, kind, name, qualified_name, file_path, start_line, end_line, …)`, `edges(source, target, kind, line)`, `files`, `schema_versions`), readable with `file:…?immutable=1`. So S1's fallback applies: a schema-pinned read-only reader, run in the `graph` profile.
  - **(c) fail:** every query command, `status` included, writes to the store (`attempt to write a readonly database` on a read-only copy). Queries therefore run on the run's own writable copy in the workspace, never on the cache; the reader (b) is the only read-only path.
  - **(d) pass:** `route` nodes with `references` edges to their handler/component — hand-written Spring (jhipster-store `POST /api/invoices` → `createInvoice`; petclinic `GET /owners/{ownerId}` → `findOwner`), canonical Angular (jhipster-store `admin.routes.ts` `/admin/health` → class `Health`), Astro (portfolio `src/pages/*.astro` → component). name-webapp's indirect routes (`RoutePath` enum, `loadFeature`, `withErrorProviders`) yield none, and spec files yield false routes: the map stays the page source (S12), engine routes only fill files the map lacks, and routes in test files are ignored.
  - **(e):** first index jhipster-store 1 117 files 3.6 s; name-webapp 1 697 files 6.0 s; ms-name-restaurants 1.2 s; cached re-sync 0.7 s; one spawn (`status -j`) 0.33 s.
  - **(f) pass:** `callers -j` and `explore` are byte-identical across repeated runs. Neither leaks the absolute workspace path.
  - **Verdict:** GO for the engine swap (kill criteria (a)/(b) not met).
  - **Container half** (after a Docker Desktop restart; orchestrator image, Node v24.20.0, arm64): `codegraph-linux-arm64@1.6.2` (284 MB unpacked, `npm pack`), run with `setpriv --reuid=1002 --regid=1002 --clear-groups env -i <S2 allowlist>` on a `git archive` export of the name-webapp mirror at `75f5390`. First index 11.7 s (1 121 files, 16 792 nodes, 82 MB store), `sync` after one edit 0.53 s, one spawn 0.26 s. The sandbox uid's egress chain blocks the network (`fetch` → `EAI_AGAIN`), and the engine runs to completion without it. The store and every file it writes stay inside the workspace; the throwaway `HOME` stays empty. Scratch removed afterwards.
- **L24** (2026-10-25) owner on acceptance scope: "Para las pruebas por ahora solo se usa name-webapp que es el que esta bien configurado y tiene entorno DEV real. Los demas no se usan, eso no significa que la implementacion deba estar optimizada para name-webapp, debe ser agnostica a la app que prueba, pero se prueba con esa luego. El contenedor de docker lo puedes levantar tu." Then chose "Código ahora, T9 al final": T1-T8 and T10 are implemented now; at the end the labelled name-webapp commits (≥5) are proposed to the owner, and T9 runs once they are confirmed.
  - **Fixture repo:** the adapter's recorded fixtures come from a synthetic two-stack repo (canonical Angular `web/` with a `package.json`, hand-written Spring `api/`), never from an app's code. Measured on it: Angular routes are detected only when the frontend's `package.json` names `@angular/*` (without it, 0 routes); a route array inside a `*.spec.ts` yields no route there.
  - **Measured, kept out of scope:** the engine synthesises a frontend HTTP call → backend route edge inside one index (`provenance: heuristic`, `metadata.synthesizedBy: "http-client"`, `href`, `registeredAt`), but only for a literal URL. jhipster-store, petclinic and name-webapp yield 0 such edges (their URLs are composed). S11 stands: no proof path is built on it.
  - **Declared deviation from S0/S16:** live acceptance runs on name-webapp only (Angular front + Java services, multi-repo), which covers both declared languages but not the single-repo shape. Agnosticism is proven offline: the adapter and join tests use recorded fixtures from jhipster-store (Spring + Angular), spring-petclinic-microservices (Spring), portfolio (Astro) and name-webapp.
  - The sibling worktree `../ai-pipeline-parallel-runs` (`3c77f475 feat(sandbox)!: give every slot its own sandbox lane`) brings parallel lanes. That is why S4 publishes the cache under a per-(app, repo) lock and keeps every per-run artefact in the run's own workspace.
- **L21** (2026-10-25) the Engram mirror `odd/codegraph-migration/tasks` is **pending**. After the session resumed, the memory host refused writes ("session already ended"). The mirror still holds the L14 version of this document. Re-save the full file at the next session start.
- **L25** (2026-10-25) implementation design, checked against HEAD (`9520f272`) before the first source write.
  - **Structured path (S1(b), S8):** one schema-pinned reader (`codegraph-store-reader.mjs`, `node:sqlite` `readOnly`, accepts schema version 11 and extraction version 27, refuses anything else as unavailable) answers every structured question in one spawn: the symbols of files with their line ranges, an inbound walk from seeds with each node's predecessor, and the route nodes with their handler/component. It runs under the `graph` profile, cwd the run's workspace. The CLI is used only for `init -y`, `sync -q`, `status -j` and `explore`. One spawn replaces the old per-anchor `callersOf` loop (up to 25 spawns).
  - **Seeds:** the innermost callable symbol (function, method, class, component) containing each touched new-side line; a deletion counts at the line after it. A changed file with no line information seeds its top-level symbols. Seeds are depth 0 (S8).
  - **Walk:** inbound `calls`, `instantiates` and `references`; a method lifts to its class or component at the same depth, so a route that references a component is reached from a changed method of it. Ordered by (depth, file, symbol), de-duplicated, cut by a symbol budget, `truncated` reported.
  - **Workspace (S3):** `<run work dir>/graph-<repo>`, root-owned `0755`, filled by a hardened `git checkout <sha> -- <pathspecs>` with a temporary `GIT_INDEX_FILE` and `core.symlinks=false`. The mirror's index and HEAD are untouched, and links arrive as regular files. Pathspecs come from the language registry (its extensions plus each language's manifests, `package.json` for JS/TS and `pom.xml`/`build.gradle*` for Java, because framework route detection reads them). They exclude every `.gitignore`, `codegraph.json` and `.codegraph`: the engine reads `.gitignore`, so a repo could otherwise hide tracked files. Only `.codegraph/` is sandbox-owned. The scope removes the work dir at the end of the run.
  - **Cache (S4):** `data/code-graph/<app>/<repo>/` (`/app/data` is already `0700` and proven closed to the sandbox uid by the file-boundary check), holding `codegraph.db` plus `meta.json` (`engine`, `engineVersion`, `sha`, counts, `builtAt`) and an `O_EXCL` lock file with a stale age. Same SHA and engine version: `reused` (copied in, validated, no sync). Otherwise copy-in + `sync`, or `init` when there is no usable cache. Publish = copy to a temp name + `rename`, then `meta.json` by rename. `data/index-status.json` is retired.
  - **Port (S7):** `syncTo(repoDir, sha)` → an index record (the S6 provenance); `impactedSymbols(repoDir, changed, budget)` → an impact report (seeds + reached + `truncated` + the index SHA); `callersOf(repoDir, symbols, budget)` for named seeds (a frontend call site); `routes(repoDir)`. `coChangeCoupling` leaves the port for a git-history adapter. `existingCoverage` and `structurallyRelated` are deleted. `BlastRadius` gains optional touched lines.
  - **No per-app engine selector (deviation from T4's text):** T10 removes codebase-memory on this same branch, so a selector would live a few commits. Parity (S8) is measured offline instead: a scratch script runs both engines on the same known commits of name-webapp (TS) and ms-name-restaurants (Java), and the comparison goes into the Log before T10.
  - **Parallelism (owner asked for worktrees, L22):** T1-T4 stay sequential and inline, because each depends on the one before. Once T4 fixes the port, T5 (service-topology tier 2), T6 (generation change pages) and T7 (agent tool surface) have disjoint edit surfaces and several hundred lines each. They run as three writers in their own worktrees branched from the T4 commit, and the parent merges them. The shared files (`composition-root.ts`, `rewritten-engine-factory.ts`, `docs/agent-reference.md`, this document) are edited by the parent alone at the merge. T8 and T10 follow inline.
  - **T1's baseline ablation round folds into T9:** the baseline is the graph-off variant, which needs no old engine and can run at any time.
- **L26** (2026-10-25) T3 + T4 implemented as one commit: the port change (S7) has to compile with every consumer at once.
  - **Deviation — old adapters removed now, not at T10:** the new port cannot be implemented by the codebase-memory adapters (`CodebaseMemoryCodeGraphAdapter`, `LazyProjectCodeGraphAdapter`, `StubCodeGraphAdapter`), so they leave with T4 together with the `index-status` sidecar. S8's parity still runs before T10: the scratch script runs the old adapter from a detached worktree at `cf1bdef3` and the new one from this branch, on the same commits, inside the orchestrator container. The codebase-memory CLI client stays for the lead's tools until T7, and the binary until T10.
  - **Provenance (S6):** every index leaves a `qayaba.code_graph.index` span (repo, engine, version, SHA, outcome, duration, node and edge counts, reason) and a `qayaba.code_graph.index` counter by outcome. The structural-signal context span now carries the index SHA as `captured_sha` and is stale when it differs from the change's commit.
  - **S5:** a service-triggered run indexes the service repo at the run's SHA and the primary repo at the commit its mirror is checked out at (`git rev-parse HEAD^{commit}`), each failing open on its own. Onboarding builds the first store through `buildCodeGraph`, the same function a run uses, in a launcher scope of its own.
  - **Scope (S3):** the workspace's extensions and manifests come from the language registry (`LanguageRegistry.extensions`, `.manifests`); exclusions from `qa.structuralSignals.exclude` (new optional field, globs).
  - **Prompt:** the structural block's intro no longer cites the old engine's confidence floor ("Derived from the call graph indexed at this commit."); the prompt only shrank, so `scripts/prompt-contract-baseline.json` was re-recorded without a raise.
  - **Checks:** typecheck, arch, seed lint, SDK typecheck and contract check green. Full suite 10 468 tests: 9 failures, all accounted for — 6 already failing at HEAD (the five "reviewer differs from generator" tests and "agent runtime manager re-injects runtime role models"), and the 3 prompt-baseline tests fixed by the re-record (re-run green).
  - **Found, not fixed (pre-existing):** the mutation preset range `src/server/rewritten-engine-factory.ts:558-590` (`scripts/mutate.ts:394`) no longer points at the factory's per-run memo even at HEAD.
  - **Seam for T7 and T8:** `CodeExplorePort.explore(repoDir, terms, maxFiles)` (text answer + index SHA), implemented by the same adapter instance over the run's indexed workspace and passed as `cfg.codeExplore`. T7's tool and T8's dossier consume it; neither reaches the engine or a workspace path.
- **L27** (2026-10-25) T5 (S9). HTTP links now carry the contract operation they call (`ServiceLink.operation`, optional, set by both HTTP resolvers), which is what the verb + path key needs; the links' rendering and the contract are unchanged. A route matches an operation on the same verb and path segments (any parameter matches any parameter); a prefix on one side only is tolerated when the shorter path keeps a literal segment, so a bare `/{id}` matches nothing. Routes are asked only when a pending link names an operation and the walk reached something. RED observed by disabling the route key (the new describe fails).
- **L28** (2026-10-25) S8 parity verdict and the verifier's advisories on T3/T4.
  - **Parity** (scratch script in the orchestrator container; the old adapter loaded from the base commit's sources, the new port from the branch; 6 non-merge commits per repo with at least one changed source file):
    - name-webapp (TS front, 16 764 nodes, first build 11.8 s): the old engine answered **0 symbols on all 6 commits**; the new port answered 1-300 symbols (two commits hit the 300-symbol budget and report `truncated`).
    - ms-name-restaurants (Java, 4 678 nodes, first build 1.6 s): the old engine answered on 4 of 6 commits (6-120 symbols, 3-36 files) and nothing on 2; the new port answered on all 6 (5-54 symbols with touched lines). File overlap on the commits both answered: 1-6 files. Symbol names never matched (the old engine named qualified symbols), so overlap is judged by file. The old answer was larger because it also walked **outbound** (the callees of the changed code); the new walk is inbound only, which is what S7 specifies (what reaches the change is what a test of it exercises).
    - Queries take 50-360 ms.
    - The new whole-file mode (a changed file without touched lines) seeded only the top-level symbols, so a changed class reached only the users of the class. It now seeds every symbol of the file, so a method's callers are reached too.
    - Verdict: the new port answers at least where the old one did, and also on the TS front, where the old one never answered. S8 holds.
  - **Verifier advisories on `604efe78` + `cb26b830`** (no blockers):
    - Applied:
      - **(1) Workspace identity.** The workspace lies in the run's work dir, which the sandbox owns. Publish now refuses a workspace whose directory is not the one built after the export (lstat dev/ino, no link). The header no longer claims the workspace root is root-owned.
      - **(3) Lifted containers.** A container lifted at depth 0 from a changed member is dropped from the answer, so it is no longer reported as changed.
      - **(5) Purge.** A purge removes `data/code-graph/<app>`.
      - **(6) Scope digest.** The cache metadata records a digest of the workspace scope, and a store of another scope is rebuilt.
      - **(7) Reasons.** Reasons name neither the workspace nor the mirror path and are capped at 400 characters.
      - **(8) Onboarding runId.** The onboarding runId no longer embeds the repo name.
    - Recorded, by design:
      - **(4) Module-level constants.** They seed nothing; a line outside every symbol seeds nothing.
      - The walk's `maxNodes` budget is also spent on the test and route nodes it then drops; the budget is a cost bound, not an answer size.
    - Separate governance commit:
      - **(2)** The new security-critical files join `src/server/merge-guard.ts`'s protected list.
- **L29** (2026-10-25) T7 (S13) is `56c2ae43`.
  - **How it landed:** a delegated writer built it in a worktree and its commit was cherry-picked. `agents/opencode.json` (`codegraph_explore` denied globally, allowed for `qa-generator`) was amended into the same commit, so the tool surface changes atomically.
  - **Fixture:** `src/integrations/fixtures/opencode-agent-list.json` was re-recorded against `opencode serve` 1.17.7 in the agents container, with an isolated HOME, `env -i` and a stripped config. The re-record also picked up the generator's and sidekick's step caps (250 and 300), which the previous recording predated, so the `opencode-agents` test now expects 250.
  - **Smoke:** `agents/smoke/codegraph-tool.smoke.mjs` passes 14/14 in the agents image.
  - **Verifier:** no blockers. Advisories:
    - The answer shaper's fence tracking relies on the engine numbering every source line, which it does today.
    - An empty answer is `ok` with empty text.
    - `codebase-memory-client.ts` is dead code that T10 removes.
- **L30** (2026-10-25) T6 (S10-S12).
  - **Where the join runs.** The join is computed inside the pre-generation grounding, before the context pack. That way the pages it proves enter route ranking and reach everything `changeRoutes` drives: the DOM capture, the lead's plan, the lead review's unvisited and unproven pages, the plan snapshot and the graders. To give the join the stitcher's links, the run now resolves the blast radius, the service links and the cross-repo impact before the grounding step. None of the three reads the grounding.
  - **The join** (`qa-run-orchestration/domain/change-pages.ts`, pure) reads the walks the index answered:
    - **Frontend proof:** a reached symbol lies in a page's implementation file. That file is the map's own, or the file of the symbol the engine's route node for the same path points at. The node's own file only declares the route, which is the map's `source`, so it never counts.
    - **Backend proof:** a reached handler serves a map operation (by verb and path, or by its name matching the operationId), and `feBe` joins that operation to a page.
    - **Across repos:** the walk starts at the frontend call site of each link the stitcher found reached. The proof opens with the link, and a link without a call-site symbol claims nothing (S11).
  - **Bounds:**
    - **Hubs:** a seed that reaches more than 4 pages adds none and is reported.
    - **Cap:** the graph adds at most 6 pages, shortest proof first.
    - **Map pages:** pages the map links keep the map's basis and take no slot.
    - **Disagreements:** a page whose map files differ from the engine's target is reported. The map's files decide.
  - **Record:**
    - **Basis per change page:** `qayaba.context.relevant_basis`, parallel to `relevant_ids`, on the route-ranking span.
    - **The join:** its pages, proofs, hubs, disagreements and omitted count go on a `qayaba.code_graph.change_pages` span.
    - **Persistence:** none in the context map (L18.7).
  - **Graders:** `plan_route_coverage` and `delivered_route_coverage` still grade every change page. The new `plan_graph_route_coverage` and `delivered_graph_route_coverage` grade the graph pages alone, so the ablation can tell graph pages from map pages. No metric baseline file exists; the baseline is T9's graph-off variant (L25), and the re-recorded numbers belong to T9.
  - **Degradation:**
    - Without an index (structural signals off, or a failed index) there is no join and the pages are the map's alone.
    - With the DOM pack off or no context pack, `changeRoutes` behaves as before.
  - **Verified on the recorded store:** a helper change proves `/orders` and `/profile` through the engine's route targets. A backend repository change proves `/orders` via `loadAll > findAll > listOrders > GET /api/orders (listOrders)`.
  - **Mutation preset ranges** (`scripts/mutate.ts`) in `context-pack.ts` and the grounding adapter were shifted to the lines they covered before.
  - **Checks:** the full CI gate is green. Full suite: 10 504 tests, 5 failures, all known at the base (the reviewer-differs-from-generator tests and the runtime-manager test).
  - **Domain-join tests:** I wrote the code before these tests. I then checked them against 7 mutants (hub, linked, disagreement, engine fallback, handler gate, operationId key, cap), and every mutant was killed.
- **L31 (2026-10-25) — T6 verification, T8 (S15, S14).**
  - **T6 verifier:**
    - **Blocker:** the operationId key only proved a page after a route node served it. A generated contract interface implemented by a class has no route node, so it proved nothing. Fixed in `ab164e67`: a reached symbol named for an operationId proves the pages `feBe` joins to it. Disagreements are also de-duplicated per (route, engine file).
    - **Advisories, out of domain or minor, kept as follow-ups:**
      - The proof-chain rebuild is quadratic. This is bounded by the S8 budget of 300 symbols.
      - Graph pages follow the order of the derived routes.
      - The hub count includes linked pages.
      - An untrusted-git-dir throw now comes before an abort.
      - Two-segment suffix matching can collide across monorepo packages.
  - **S15 (`03af259f`):**
    - A sidekick's brief carries up to 3 proofs for its flow's pages under "How the change reaches this flow's pages (from the run's call graph)". A proof longer than 8 steps elides its middle.
    - The proofs come from `grounding.changePages`, which is set in `groundRepository`.
  - **S14 (the dossier):**
    - **What it is:** the engine's read-equivalent source for the change's top changed symbols, appended to the structural block under its own heading. Symbols are ranked by direct callers.
    - **Limits:** 4 symbols, 4 files and 8 000 characters. The text is redacted and cut at file boundaries, then passes `sanitizeText` in model mode.
    - **Space and paths:** the lists give way so the block keeps its 20 000-byte budget. The files the dossier shows go to the prompt's provided paths, so `graph_provided_read_count` can see re-reads.
    - **Degradation:** a change with no changed symbol, or an index that cannot answer, gets no dossier.
  - **Lever:**
    - `qa.structuralSignals.dossier` in the app YAML, overridden per run by `grounding.dossier`, which is part of the contract and of the effective config.
    - The value is null when the structural signal is off. The default is off until T9 decides it.
  - **Prompt contract:** `scripts/prompt-contract-matrix.ts` reports 0 findings with the dossier off in the fixtures, so the baseline is not re-recorded.
  - **Checks:** full CI gate green. Full suite: 10 523 tests, 5 failures, all known at the base. Go tests green.
