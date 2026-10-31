# RFC-0016: The context map is a precondition of a run

- **Status:** Proposed, 2026-11-01. The owner has decided nothing in it.
- **Code references at 831dae98** (branch `fix/root-cause-2026-10-28`; read a line with `git show 831dae98:<path>`). Every claim is read from code at that commit; no run telemetry was read for this record, so each statement about quality effects is a hypothesis and says so.
- **Related:** [ADR-0001](../adr/0001-design-pillars.md) (P1-P7), [ADR-0009](../adr/0009-campaign-freeze-on-server.md) (the server freezes campaign runs), [ADR-0015](../adr/0015-owner-decisions-2026-10-30.md), [RFC-0006](0006-review-answer-crosses-whole.md) (partial admission of an agent's answer), [RFC-0013](0013-learning-slice.md), [RFC-0015](0015-verdict-from-uninstrumented-execution.md); feature document `odd/tasks/root-cause-2026-10-28.md` rows T44 and T45 and Log L83; `docs/engine-platform-architecture.md` (placement rule); `docs/efficiency-benchmark.md:516-521` (freeze table); `docs/lead-sidekicks.md`.
- **The owner's requirement** (2026-10-31, translated): "I think it should be an agent configured for that, I understand one already exists for the context run mode, that can be given the full thing or the diff since the previous one, and that the lead sends before it hands out the testing tasks. But a run can never execute without context as you say, rather it waits for the heal and then resumes; if it detects there is no context it should end that execution and launch the context mode and, when that is ready, launch the initial execution again, because the context is indispensable. This does not go in before the run, but you should launch an agent at xhigh effort to analyse it and propose a way to do it that fits well in the hexagonal architecture with DDD with the resources already developed so as not to duplicate logic."

## Summary

1. The stored FE-BE context map is optional grounding today. Three triggers ask for a rebuild (a shell pre-step, the process-audit flag, a stale-map check inside a grounding closure), none of them makes the run wait on the outcome, and a run that is frozen, a continuation, a purpose run, or whose rebuild failed or was already tried goes on without a map (`platform/entrypoints/runner.ts:667-682`, `platform/composition/run-engine-factory.ts:686-718`, `:973-1017`).
2. Proposal: the map becomes a precondition owned by `run-orchestration`. One gate step in the engine's step table (after `classify-change`, before anything that costs time) either lets the run go on with a map that describes its commit, or ends the run with a closed outcome and returns a typed follow-up. The shell turns the follow-up into two queue entries, a `mode: context` run and a relaunch of the original, linked by `parentRunId`. A relaunch never defers again, which bounds the loop at one attempt per lineage with no counter.
3. The rebuild becomes incremental: the same delta classifier the validity check already is (`contextMapValidity`) names the affected entries; the engine derives what it can deterministically (routes from the code graph, operations from OpenAPI, links from the service-link resolver plus the call graph); a new read-only agent role fills only the gaps and returns a patch; the engine admits the patch entry by entry and writes the map. Full build is the same path from an empty base. This settles T44 and T45.
4. The lead is not given a tool for this. The gate is deterministic and runs before the lead's plan turn; the lead is the first consumer of the map.
5. Eight work units, the first four enforce the owner's rule with the existing builder; the last four make the rebuild incremental and framework-neutral. One unit (the new role) is governance-sensitive and ships alone.

## Problem

### 1. Today's flow, case by case (confirmed by reading)

A run asks for the map in three places. Each is a separate piece of policy; two of them sit in `platform/`, against the placement rule (row 3: a module that decides something about a run is engine code).

| Trigger | Where | What it does | What it skips |
|---|---|---|---|
| **A. Shell pre-step** `rebuildContextMapFirst` | `platform/entrypoints/runner.ts:517` (stage `context_map`), `:667-682`; the question `contextMapNeedsRebuild` at `engine/src/contexts/run-orchestration/application/context-map-rebuild.ts:18-29`, wired in `platform/composition/context-map-wiring.ts:9-19` | Before the engine is built, asks "is there no map, is it flagged stale, or did a file it names change?". If so it runs a `mode: context` run **inside this run's queue turn** (`trackRun(..., insideRun=true)`, linked by `parentRunId`) and only then builds the engine, so this run reads the fresh map. | Not asked for a frozen request, a context run, a run with a `purpose`, a run with `triggerRepo`, a run with `parentRunId` (`engine/.../domain/run-prework.ts:33-35`). Once per app and commit **in process memory** (`run-prework.ts:51-70`, the `PreworkMemory` set). A question that throws is logged and the run goes on (`runner.ts:671-676`). The rebuild's own outcome is never read: a failed rebuild, and a rebuild already tried at that commit, leave the run to ground without a map. The age bound is not part of the question. |
| **B. Process-audit flag heal** | `run-engine-factory.ts:686-703` (`staleFlagHeal`, `engine/.../domain/context-heal.ts:12-16`), `RequestContextHeal` (`engine/.../application/request-context-heal.use-case.ts:6-32`), `wire-app.ts:321-324` | The audit marks `context_stale` after three runs in a row with the same UI-mismatch class (`engine/.../cross-run-learning/domain/process-audit.ts:55-66`, `platform/composition/run-engine-factory.ts:1280-1288`). A later run that still sees the flag **enqueues a separate context run at the queue tail** and grounds without the stored map (`:973-981`). | Frozen runs "withhold" (the flag stays, the map is not used, `recapture: "skipped"`); context runs; service-triggered runs. In practice A consumes the flag first, so B fires only where A is skipped: continuations and purpose runs. |
| **C. Stale-map heal inside the grounding closure** | `run-engine-factory.ts:705-718` (`requestMapHealIfDue`, `staleMapHeal`, `context-heal.ts:19-22`), the closure `loadContextMap` `:973-1017`, `contextHealRequested` `:387` | When the stored map does not fit the run's commit (`contextMapFitsRun`, `engine/.../domain/context-map-fit.ts:25-43`) **or is older than 14 days** (`CONTEXT_MAP_MAX_AGE_MS`, `engine/src/shared-kernel/telemetry/context-provenance.ts:25`), enqueues a context run once per app and commit in process memory. The run in flight uses `fit.map`: none when the files it names changed, the map with the links of modified pages dropped when only page files changed, the old map when only its age is past. | Frozen runs (`recapture: "skipped"`); context runs. Two consumers call this one closure per run, so the git comparison runs twice: change-scope (`platform/composition/engine-root.ts:312`, `change-scope-port.adapter.ts:106-108`) and grounding (`pre-generation-grounding-port.adapter.ts:367-384`). |

What each run kind gets, today:

| Run | Map used | Rebuild | Evidence |
|---|---|---|---|
| Diff or manual run, primary repo, not frozen, map missing, flagged or not fitting | the fresh map, when the in-turn rebuild succeeds; **none** when it fails or was already tried at this commit | A, in this run's turn | `runner.ts:667-682` |
| Same, map fits but is older than 14 days | the old map | C, separate run at the queue tail | `run-engine-factory.ts:988-1000` |
| Same, map fits except modified page files | the map **without the links of those pages** (`pages-modified`) | none | `context-map-fit.ts:41-42`. These are the pages the diff touches: the most relevant ones. |
| Campaign replicate (frozen) | the stored map if it fits, else **none**; a flag makes it none | none; the docs tell the operator to run `mode: context` once first | `run-freeze.ts:25-31`, `run-engine-factory.ts:974-981`, `docs/efficiency-benchmark.md:520` |
| Continuation (`/continue`), `purpose` run | stored map if it fits, else none | B or C, separate run at the tail; the run does not wait | `run-prework.ts:34`, `run-engine-factory.ts:693`, `:707` |
| Service-triggered run | the stored map even when its sha differs (`fits: false`, `map` kept, `context-map-fit.ts:33`) | see F1 | |
| Context run | stored map is not given to it (`T44`) | it is the rebuild | `task-builders.ts:22-93` |

### 2. Findings

- **F1 (hypothesis, read from code, not reproduced).** For a service-triggered run C can enqueue a context run at the **service's** sha. `staleFlagHeal` excludes service-triggered runs (`context-heal.ts:13`), but `staleMapHeal` takes only `{ mode, frozen }` (`context-heal.ts:19`) and `contextMapFitsRun` returns `fits: false` for such a run (`context-map-fit.ts:33`), so `stale` is true and `requestMapHealIfDue` calls `contextHeal.execute(app.name, run.sha, ...)` with `run.sha` the service commit (`run-engine-factory.ts:709-717`). The test at `platform/composition/run-engine-factory.test.ts:689` covers the flag path only, and that closure is not evaluated at build time. A context run at a commit the primary mirror does not hold would fail at checkout. To be confirmed by a test before this RFC relies on it.
- **F2.** No role exists for the context mode. A `mode: context` run is authored by `qa-author` through the author target `context` (`engine/.../coordination/application/author-dispatch.ts:14-16`, `sidekick-kinds.ts:80-92`; `agents/opencode.json:300`, tools: write, edit, read, `run_spec`, authenticated browser, geolocation, Playwright). The roster of `agents/opencode.json` is `qa-lead` (`:27`), `qa-reviewer` (`:110`), `qa-assistant` (`:186`), `qa-proposer` (`:249`), `qa-author` (`:300`). The task is `buildContextTask` (`engine/.../generation/infrastructure/prompt-builders/task-builders.ts:22-93`): "Extract FROM the Angular routing files" (`:58`), "Find ALL Angular routing files" (`:76`), "typically src/app/generated/" (`:80`), no stored map, no delta (T44, T45).
- **F3.** The delta is already computed, cheaply, and thrown away. `contextMapValidity` (`engine/.../domain/context-map-validity.ts:68-94`) classifies the `git diff --name-status` of the files the map names into `same-sha`, `inputs-unchanged`, `pages-modified` (with the unverified routes), `inputs-changed` and `unverifiable`, and stops at the first invalidating file. Everything it learns beyond "invalid" is discarded; the builder gets none of it.
- **F4.** Provenance is partial. A route names its `source` and `implementationFiles`, an operation its `spec` (`context-map-validity.ts:43-65`); a `feBe` link names nothing it was derived from (`via` is a method name, `generation-input.ts:35-39`). The validity file says so: "a generated client that feeds `feBe` is not named, so the 14-day age bound still applies" (`:13-14`). The age bound is a time constant standing in for missing provenance (P3).
- **F5.** Two diff readers exist: `gitChangedFiles` (`run-engine-factory.ts:362-378`, `execFileSync git diff --name-status -z`) and the engine's `GitMirrorReadAdapter` behind `VcsReadPort` (`engine/.../change-analysis/application/ports/vcs-read.port.ts:5-15`), which has `diff`, `blastRadius`, `message`, `ancestor` and no name-status. The map check uses the first.
- **F6.** The map has more than one write path and one read path with policy in the shell: the agent writes `e2e/.qa/context.json`, an adapter checks that "this run wrote it" with `git status` (`ContextMapWrittenThisRun`, `run-engine-factory.ts:396`), reads it back and stores it (`context-map-capture-port.adapter.ts:31-43`); the form validator `isValidArchitectureContext` lives in the grounding adapter (`pre-generation-grounding-port.adapter.ts:72-106`); `ArchitectureContext` is declared twice (`generation-input.ts:48-54`, `shared-kernel/grounding.ts:2-8`); `context_heal_requests` is written (`context.repository.ts:57-59`) and read by nothing.
- **F7.** What deterministic sources already hold (confirmed to exist; their coverage on frameworks other than Angular is a hypothesis to measure):
  - routes: `CodeGraphPort.routes()` returns frontend page routes (`method` absent) with the declaring file, line, and the target symbol's file (`engine/src/shared-kernel/ports/code-graph.port.ts:18`, `GraphRoute` `shared-kernel/code/index.ts:149-155`, adapter `codegraph-code-graph.adapter.ts:466-486`; the test at `engine/test/shared-infrastructure/code-graph/codegraph-code-graph.adapter.test.ts:320-329` shows `/orders` and `/profile` with `target`). The route-table extractor (`RouteTableSyntax = "angular-router"`, `shared-kernel/language-id.ts:47-51`, `generation/infrastructure/route-table/route-tables.source.ts`) reads the router's structure but only for Angular and without an implementing file.
  - operations: `parseOpenApiYaml` returns `{ service, path, verb, operationId }` (`service-topology/infrastructure/openapi-ingress.ts:22-47`).
  - links: `ServiceLink { from {repo,file,symbol}, to, operation {verb,path} }` from the resolver run (`shared-kernel/service-links.ts:1-30`, `ground.steps.ts:173-187`), resolved only for an app that declares `services[]` (the topology is wired under `serviceTopologyOn && app.services`, `run-engine-factory.ts` near `:1013`).
  - route reach: `callersOf` under the one `WalkPolicy`, already used to find "the pages through which a browser reaches an operation" (`change-analysis/domain/use-case-candidate.ts:101-108`, `reach-proofs/cross-repo-call-site.ts`).
  So routes, operations and a part of the links can be derived without an agent. What cannot: a call site whose path is computed (`UnresolvedCall`), a framework whose routes the graph does not recognise, an app with no `services[]` (no resolver links), `flows`, `name`.

### What it does not explain

No run was read for this record. It does not establish how often runs ground without a map, or what a missing map costs in test quality (hypothesis: the lead plans with less FE-BE context and the author falls back to the live DOM and the code graph; the counter `qayaba.context.recapture{outcome}` in `platform/telemetry/instrument-table.ts:40` is the baseline to read first, see Measurement). It does not establish the coverage of the deterministic sources outside Angular.

## Goals and non-goals

Goals:
1. A run that generates tests never starts without a map that describes its commit; the exceptions are typed, few, and each has a reason.
2. One place decides it (the engine), one place sequences it (the shell), no second queue.
3. A rebuild reads the stored map and the delta, derives what is provable, asks the agent only for what is not, and verifies the answer.
4. Nothing in code or prompts names a framework; per-framework knowledge is a declaration in the language registry.
5. Campaign replicates stay comparable.

Non-goals: a priority lane in the queue; retry or backoff constants; a new bounded context; a lever to run without a map (an A/B arm for the map's value is not asked for; `GroundingInput` has `stitcher`, `domPack`, `lessons` only, `contract/commands.ts:166-170`); changing what the map contains for the consumers (`routes`, `api`, `feBe`, `flows`); the Context Pack's live DOM.

## Options

The real forks, each with what it removes, what it adds and its risk.

**Fork 1: where the wait lives.**

| Option | Removes | Adds | Risk |
|---|---|---|---|
| A. Keep the shell pre-step A, make it strict (do not skip frozen, continuation or purpose; fail the run when the rebuild fails) | The fail-open paths of A | Exceptions stay in the shell (`mayBePreceded`), the engine can still start without a map, triggers B and C remain | The invariant "a run never proceeds without a map" is enforced by whichever entry point remembers to call the shell step. Nothing in the engine's step table states it. Row 3 of the placement rule stays violated. |
| **B. Engine gate step, closed outcome, typed follow-up the shell executes (recommended)** | A, B and C as triggers; the grounding closure's policy; the process-memory sets | One step, two end reasons, one error class, one value on the run result, one shell executor | The follow-up enqueues two runs after a run ends: ordering on the sequential queue and the change-set handoff are the risk (item 4). |
| C. A lead tool `request_context_map` | nothing the engine does not already know | A tool surface on the lead, which is read-only today (`agents/opencode.json:27`) | The precondition becomes probabilistic (an LLM decides to call it), so the engine would need the gate anyway and the tool is redundant; it also hands an agent a way to put work on the queue and cannot be allowed under a freeze. Rejected, see R9. |
| D. The wait stays in the same queue turn (no end, no relaunch): the gate runs the context run through a port, then continues | The relaunch record | A nested run inside an engine run | The engine's working copy is the shared mirror: `restore-accepted-suite` and `set-up-project` run after the gate, and a context run's `checkout -f` + `git clean -fd` on the same mirror would wipe state a nested run built. Only a gate before the working copy is prepared is safe, which is where A sits today and which the engine cannot own. Rejected. |

**Fork 2: how the relaunch is queued.**

| Option | Removes | Adds | Risk |
|---|---|---|---|
| **A. Enqueue the context run and the relaunch together when the original ends (recommended)** | Any state about "waiting" | The relaunch re-evaluates the gate (one git comparison) | If the context run fails, the relaunch ends `context-map-unavailable`: a record of its own, typed, never learned from. The queue is FIFO, so nothing queued later runs between the two. |
| B. Enqueue the relaunch from the context run's completion hook, only on success | The relaunch's extra gate evaluation | A completion hook with a decision in it | A failed context run leaves no record of what happened to the original's commit. The hook is shell code that decides. |

**Fork 3: what the rebuild agent returns.**

| Option | Removes | Adds | Risk |
|---|---|---|---|
| A. The whole map, given the stored map and the delta | The cost of the empty-base build | Nothing new | The agent can silently change entries the delta did not reach; the engine can only validate the whole file's form. The failure T44 exists to prevent. |
| **B. A patch over the affected entries and the named gaps; the engine merges (recommended)** | Drift in unaffected entries; the "did this run write the file" check | A patch schema, an admission function (the same pattern as the reviewer's answer and `qa-proposer` with its scorer) | Entry-level refusals need a recorded reason; a patch that names nothing refused leaves the gaps open, recorded. |
| C. No agent: derive everything | The agent | Nothing | Coverage on frameworks other than Angular is unmeasured (F7), and an app with no `services[]` has no links. Not now; the gap list shrinks toward it as the skeleton improves. |

**Fork 4: a frozen (campaign) run with no fitting map.**

| Option | Removes | Adds | Risk |
|---|---|---|---|
| A. Run without a map (today) | nothing | nothing | A replicate measures a different system when the map is missing; the owner's rule is violated. |
| B. End the replicate `context-map-unavailable` | The silent degradation | An environment-invalid replicate | Operator has to build the map first (today's docs already say so). |
| C. The campaign launcher builds the map before the first replicate | The operator step | A launcher action that is not frozen (the run it queues has no `campaign` tag) | Does not by itself protect a replicate launched through the API directly. |
| **D. B and C together, plus the map digest on each replicate (recommended)** | | One digest attribute, one comparison in `campaign-compare` | The `restored_digest` pattern already exists (`scripts/campaign-compare.ts:97-99`). |

## Recommendation

### R1. Which bounded context owns what

**`run-orchestration` owns the rule "the context map is a precondition of a run".** It already owns the freeze (`domain/run-freeze.ts`), the prework (`domain/run-prework.ts`), the heal decision (`domain/context-heal.ts`), the validity and fit rules, the step table, the closed ends and `finalizeRun`. The decision "may this run proceed" is a policy whose outcome changes a run: placement row 3.

**`generation` keeps owning the map's content and how it is built**: the `ArchitectureContext` type, its validator, the brief and the builder (it already owns `buildContextTask`, the capture port and the loader). The new builder port sits there.

**`shared-kernel`** holds the vocabulary both sides import, because `generation` must not import `run-orchestration` (the dependency runs the other way): `ContextMapDelta`, `RunFollowUp`.

No new context. The pieces are about six modules; a context would add a facade, a dependency-cruiser entry and an ownership boundary the code does not need yet (P7).

### R2. The rule (domain, `run-orchestration/domain/context-map-gate.ts`, pure)

```
need(run)   = exempt(reason) | present | fits-commit
status      = fits(map, withheldRoutes) | needs-patch(delta) | needs-full(reason)
gate(need, status, run{frozen, relaunch}) = go(map) | defer(followUp) | refuse(reason)
```

- `need`: `exempt("context-run")` (it is the provider), `exempt("purpose")` (login bootstrap is not a change to test), `exempt("regression")` (`classification.generating` false: the existing suite runs, nothing is generated); `present` for a service-triggered run (its sha belongs to the service repo, so "fits the commit" cannot be asked; today's `contextMapFitsRun` already compares by sha only for it, `context-map-fit.ts:33`); `fits-commit` for everything else. This replaces `mayBePreceded`'s negative list (`run-prework.ts:33-35`) with a typed positive one.
- `status` comes from the store and the delta (R10). `needs-full` reasons: `absent`, `unreadable` (corrupt row or fails the form check), `condemned` (the process audit's flag), `unverifiable` (the two commits cannot be compared).
- `gate`: `go` for `fits`; for `needs-patch` and `needs-full`: `refuse` when the run is frozen (`frozen-run-without-map`) or is a relaunch (`relaunch-without-map`), else `defer`. A status that could not be established (the comparison throws) is `refuse("status-unreadable")`, never a pass: the invariant "surface integration errors loudly" replaces the fail-open `catch` at `runner.ts:671-676`.
- `pages-modified` stays tolerated: a `fits` status with `withheldRoutes`, links withheld as today, recorded as a signal (Q2).

### R3. Ports

| Port | Kind | Where | Adapter |
|---|---|---|---|
| `ContextMapStorePort { load(app): StoredContextMap | undefined; save(app, sha, map); isCondemned(app); clearCondemned(app) }` | driven | `run-orchestration/application/ports/` | `ContextRepository` (`platform/persistence/repositories/context.repository.ts:41-85`) implements it directly; the committed-file fallback (`loadContextMapFromDisk`) becomes a one-time adoption into the store inside the adapter, not a parallel read path |
| `TreeDiffPort { changedFiles(from, to): Promise<ChangedFile[] | undefined> }` | driven | `run-orchestration/application/ports/` | `GitMirrorReadAdapter` gains the method through its existing hardened runner; `gitChangedFiles` (`run-engine-factory.ts:362-378`) is deleted |
| `ContextMapBuilderPort { build(base, delta, skeleton, signal): Promise<ContextMapBuild> }` | driven | `generation/application/ports/` | deterministic skeleton + `LlmContextBuilderAdapter` over `AgentRuntimePort`, after `LlmProfileProposerAdapter` (`service-topology/infrastructure/llm-profile-proposer.adapter.ts`) |
| `RunFollowUp` (value on `RunQaResult`) | the engine's output, not a port | `shared-kernel` | executed by the shell (`RunnerDeps.followUp`), replacing `EnqueueContextRunPort` and `RequestContextHeal` |

The engine returns data; the shell enqueues. Compared with today's outbound `EnqueueContextRunPort`, the engine never calls the queue, and a test asserts on the result.

### R4. Where the gate sits in the step table

A step `ensure-context-map` in `IN_WORKSPACE` (`engine/.../run-flow/run-steps.ts`), **immediately after `classify-change` (`:35`) and before `arm-run-deadline` (`:36`)**.

- After `classify-change`: a commit classified `skip` ends `classify-skipped` first and never costs a context run; the working copy is already prepared by then (`opening.steps.ts:149-152`: "Prepare already checked out the mirror"), so the delta can be computed against the mirror at the run's commit.
- Before `arm-run-deadline`, `index-mirror` (code graph index, up to 270 s), `restore-accepted-suite`, `set-up-project` (`npm ci`), the login, the grounding and any agent turn: a run that will defer has spent only a classification and one `git diff`, and the run's deadline has not started.
- `runs: requiresContextMap`, `skipReason: contextMapExemptReason` (the mechanism the coverage steps already use, `run-steps.ts:69-70`), `writes: ["grounding"]`: the step stores the evaluated status once in `RunState.grounding`. The two consumers of the closure (change-scope at `engine-root.ts:312`, grounding at `pre-generation-grounding-port.adapter.ts:367`) read that one result; the platform closure keeps no policy.
- The table goes from 49 to 50 steps; `AGENTS.md` ("a table of 49 named steps") and the header of `run-steps.ts` (which says 48) are restated by the unit that adds it.

### R5. The closed outcomes

Two end reasons added to `END_REASONS` (`run-flow/end-reason.ts:3-23`), `RunEnd` (`run-end.ts`), `END_EFFECTS` and `shapeOf` (`finalize-run.ts:105-160`):

| Reason | Verdict | Persisted outcome | Publishes | Learns | Why |
|---|---|---|---|---|---|
| `context-map-pending` | `skipped` | no (like `classify-skipped`: `UNRECORDED`) | none | none | The run did nothing and is replaced by its relaunch. `skipped` is `engineStatus` success and carries no error class (`error-class.ts:108-109`), so it neither colours trends red nor teaches. Carries `followUp` and a note naming the context run and the relaunch. |
| `context-map-unavailable` | `infra-error`, class **`E-CONTEXT-MAP`** | yes (`RECORDED_TERMINAL`) | none (an `infra-error` resolves to side effect "none") | none | The run cannot be tested: frozen run without a map, relaunch without a map, status unreadable. A typed, persisted, visible end. |

`E-CONTEXT-MAP` is added to `ERROR_CLASSES` and `ERROR_CLASS` (`error-class.ts:4-46`), to `NON_LEARNING` (`learning-gates.ts:8`) and to `OBSERVED_OPERATING` (`:11`, so a streak is visible to the audit without teaching, the way a reviewer outage is) and to `resolveErrorClass`. It is not "E-PRECONDITION": that class means a positively evidenced login failure (`error-class.ts:140`).

A new verdict (`deferred`) is not proposed: the six verdicts are a contract the Go client, the web console, the SDK and the graders consume (Q1).

### R6. How the original run is relaunched

1. The gate returns `defer`; the step ends the run with `context-map-pending` and `followUp = { kind: "context-map-then-relaunch", contextRun: { app, sha, build: "patch" | "full" } }`. `sha` is the commit the map must describe (the primary repo's; for a service-triggered run the primary mirror's head, Q3).
2. `finalizeRun` runs as for any end (workspace pruned, mirror free). The runner's job reads `run.followUp` after it updates the record (`runner.ts` job, after the `updateRecord` that writes the verdict) and calls `RunnerDeps.followUp` (composed in `wire-app.ts` next to `runnerDeps()`, `:311-313`, which has the queue).
3. The shell enqueues, back to back on the one `JobQueue` (`platform/entrypoints/queue.ts:15-29`):
   - C: `contextMapRequest(app, sha, parentRunId = original.id)` (`run-prework.ts:78-80`, trigger `context`, `source: manual`);
   - R: the original `RunRequest`, unchanged in `app`, `sha`, `mode`, `guidance`, `shadow`, `commits`, `baseSha`, `triggerRepo`, `source`, `closedLoop`, `agentBrowser`, `grounding`, `captureMode`, with `parentRunId = original.id`, `trigger: "relaunch"` (a new member of `RUN_TRIGGERS`, `run-trace.ts:11`), `previousNamespace: ""` (the original made no data, like `contextMapRebuildRequest`, `run-prework.ts:83-85`).
   Both go through `enqueueTrackedRun`'s path (`runner.ts:352-370`): no second queue, no new table. `parentRunId` is the existing column (`run.repository.ts:171`); the lineage is already walkable (`:572`).
4. **The change set must travel.** A webhook run may have absorbed later pushes (`PendingChangeSets`: `take` at the start of its turn closes the set, `pending-change-sets.ts:148-152`). R must carry that set or the pushes are lost. R is not coalescible (it has a `parentRunId`, `isCoalescible` `:69-87`), so it needs the closed set handed to it: `PendingChangeSets` gains `hold(runId, set)` (record a set that is never offered). A test pins it.
5. If a context run for the same app and commit is already queued or running, the shell does not queue a second: it queues only R behind it. The check reads the run history (a small query on `RunRepository`, which has `childrenOf` and `listRecords` today), not process memory.
6. The original's record gets `facts.contextMapFollowUp = { contextRunId, relaunchRunId }` so a client following the original can find them.

When C ends `context-pass`, `captureContextMap` stores the map (`decided-end.ts:182-193`) and R's gate finds `same-sha`. When C fails, R's gate finds no fitting map and ends `context-map-unavailable`.

### R7. Frozen runs and campaigns

Rule: **a frozen run never builds a map and never runs without one** (Fork 4, option D).

- Engine: `gate` returns `refuse("frozen-run-without-map")` for a frozen run whose status is not `fits`. The freeze keeps its meaning (no rebuild, no process audit, a read-only suite store, `run-freeze.ts:9-12`); what changes is that the replicate does not silently measure a different system. A flag armed before the campaign is a `needs-full(condemned)` status and now refuses with a typed reason instead of degrading (`docs/efficiency-benchmark.md:520` tells the operator to clear it first; this makes it an enforced precondition).
- Launcher: `scripts/campaign.ts` `preflight` (`:256-278`, "everything that can be known before DEV is touched") gains one check per case: the app's map fits the case's sha. When it does not, the launcher queues one **untagged** `mode: context` run per case commit (a non-frozen run, outside the campaign) and waits for it, before replicate 1. The frozen replicates never see the queue change.
- Comparability: each replicate records the digest of the map it read (`qayaba.context_map.digest`, the pattern of `qayaba.suite_store.restored_digest`, `attribute-registry.ts:394`); `campaign-compare` marks a replicate whose digest differs from replicate 1 invalid, and one with no digest "isolation unknown" (`scripts/campaign-compare.ts:97-99`).
- The context run that the launcher queues is not part of the campaign, so the existing rule "a context-mode run still stores the map it builds" (`docs/efficiency-benchmark.md:523-524`) holds.

### R8. Loop protection

Structural, with no counter and no constant:

1. A context run never defers (`exempt("context-run")`).
2. A relaunch never defers: `gate` returns `refuse("relaunch-without-map")` for a run with `trigger: "relaunch"`. A lineage is therefore at most original → C → R, three records, whatever happens.
3. A frozen run never defers (R7).
4. The typed failure it ends with is `context-map-unavailable` / `E-CONTEXT-MAP`, persisted on R, with a note naming C and the reason (`relaunch-without-map`).
5. Across commits, an app whose map cannot be built produces three records per commit, finite and visible. Recurrence is a signal (`OBSERVED_OPERATING`, a finding the audit logs, never an engine action). No backoff is proposed; if it is wanted it should read a signal (the last context run of the app failed with the same delta), not a count.
6. The process memory sets that bound today's rebuilds (`PreworkMemory.contextMapRebuilt`, `contextHealRequested`) are deleted: they bound by forgetting on restart and by hiding a failed rebuild; the lineage replaces them and survives a restart.

### R9. "The lead asks for it" and "the run never starts without it"

**Recommendation: the deterministic gate before the lead's plan turn; the lead is the first consumer of the map, and gets no tool.** Reasons, against the owner's priorities:

- **Determinism (P1)**: whether a map fits a commit is a fact the engine holds (a `git diff` against the files the map names). The lead has no evidence the engine lacks. A tool call by a model would make an invariant ("never without") depend on the model deciding to call it; the engine would still need the gate, so the tool would be redundant.
- **Rule-drawn boundary (P2)**: the table already assigns "which flows a change needs" to the lead and "which verdict a run ends with" to the engine. This is the second kind. A row is added (R12).
- **Invariants**: an agent that can put runs on the queue widens its authority (`AGENTS.md` invariants on read-only roles and on tools bound per role); under a freeze it could not be allowed anyway.
- **What the lead does get**: the plan turn is told which pages of the map the change reaches (`docs/lead-sidekicks.md`, "What the lead plans from"); with the gate that map is always there, and the prompt states the map's provenance and the routes whose links were withheld. If the lead or the reviewer finds the map wrong, the existing channel is the process-audit flag (`context-heal` disposition, `process-audit.ts:55-66`), which now yields a `condemned` status and a full rebuild on the next run. No new tool.

The owner's order is kept: map first, then the lead's plan, then the testing tasks.

### R10. Incremental mode

**One path: a full build is a patch over the empty map.**

*The delta.* `contextMapValidity` is generalised, not replaced and not duplicated: it becomes `contextMapDelta(map, capturedSha, runSha, changes) → ContextMapDelta`, using the same `ChangedFile[]` from `parseNameStatusZ` (`context-map-validity.ts:97-106`) and the same naming of inputs (`namedFiles`, `:43-65`). The old return type is a projection of the new one, so its tests carry over unchanged. The type lives in `shared-kernel` (`generation` reads it, `run-orchestration` computes it):

```
ContextMapDelta =
  | { kind: "none", reason: "same-sha" | "inputs-unchanged" }
  | { kind: "tolerated", withheldRoutes: string[] }                 // today's pages-modified
  | { kind: "patch", affected: AffectedEntries, files: ChangedFile[], discover: string[] }
  | { kind: "full", reason: "absent" | "unreadable" | "condemned" | "unverifiable" }

AffectedEntries = { routes: string[]; operations: string[]; links: { route; operationId }[] }
```

`patch` covers what `contextMapValidity` calls `inputs-changed` today, which forces a whole rebuild: the entries affected are those whose evidence file changed or went away (a route whose `source` changed, an operation whose `spec` changed, a route whose implementation file was deleted or added, a link whose evidence file changed), plus the routes accumulated in `withheldRoutes` (a patch refreshes everything stale at once), plus `discover`: added files of a kind an existing route source has (`kindOf`, `:36-40`, the existing name-suffix rule, derived from the map's own sources, not from a framework).

*Provenance.* `feBe` links gain an optional `files: string[]` (the client file and the call site). With it, a changed client file names the links it affects, and the age bound has nothing left to stand in for: **a map whose links carry `files` is valid by content alone; a stored map without them keeps the 14-day bound until it is rebuilt once** (a persisted-format addition, optional, Q7). `CONTEXT_MAP_MAX_AGE_MS` is deleted when the last legacy map is gone.

*What the builder receives.* The stored map as base (the raw stored data, not the fit-filtered one), the affected keys with the reason of each, the changed files with git's status restricted to those the affected entries and `discover` rest on (not the whole diff), the skeleton the engine already derived for those keys, and the gaps (R11). The input is bounded by structure, not by a size constant.

*What it returns.* A patch, not a map:

```
{"patch":{"routes":{"upsert":[...],"remove":["/p"]},"api":{...},"feBe":{"upsert":[...],"remove":[{"route":"/p","operationId":"o"}]},"flows":{...}},"note":"..."}
```
read through the one scanner (`closingJsonObject`, `@kernel/last-json-object.ts`, as the proposer's adapter does).

*Deterministic admission and merge* (`applyContextPatch`, pure, `generation/domain`), the pattern of the reviewer's answer (RFC-0006) and of the proposer + scorer:
1. every key in the patch is in `affected` ∪ the gaps; an entry outside is refused, recorded, never applied;
2. every cited file (`source`, `implementationFiles`, `spec`, link `files`) is read through the confined reader (`spec-path-confinement.ts`) at the run's commit; a missing file refuses the entry;
3. the merged map passes `isValidArchitectureContext` (moved out of the grounding adapter into `generation/domain`, one validator for load and for admit: unique paths, unique operation ids, links resolve), and `flows` entries naming a removed route or operation are pruned deterministically;
4. refused entries are recorded in `gateSignals.contextMap.refused[]` and the rest stand (RFC-0006's partial admission); the engine, not the agent, writes `builtAtSha = run sha`, so the stored column and the field inside the blob stop being two truths (`context.repository.ts:62-64`);
5. an unresolved gap is recorded and is not asked again until its inputs change; it is not a failure.

The engine writes `e2e/.qa/context.json` itself with the confined writer (for the publication path and the disk adoption) and stores the map through `ContextMapStorePort.save`. `ContextMapWrittenThisRun` and the adapter's file read-back disappear (F6).

### R11. What is deterministic, what is the agent's, and T45

**Skeleton (engine, no agent)**, per affected key, in order:
1. routes ← `CodeGraphPort.routes()` page nodes: `path`, `source = file`, `implementationFiles = [target.file]`, `component = target.symbol`. Where the repository's manifest declares a route-table syntax (`LanguageRegistry.routeTableSyntaxesFor`, `language-id.ts:120-125`), the route-table extractor's nesting is used to complete a partial path. (Hypothesis to measure: whether the graph yields complete nested paths for Angular and any page nodes for React or Vue.)
2. operations ← `parseOpenApiYaml` over the contract documents the app and its services declare (the `openapi` hints), exposed through `service-topology/application` (`generation` imports that facade already, `typescript-expectations.ts:29`); `spec` is the file.
3. links ← the run's `ServiceLink`s (`deps.serviceLinks`): a link's `from.file/symbol` and `operation {verb,path}` give the operation (`findOp`, `openapi-ingress.ts`); `callersOf` from `from.symbol` under `DEFAULT_WALK_POLICY` to the route targets gives the route; `files = [from.file]`.

**Gaps (the agent's part)**, a closed list with a position each: `routes-undeclared` (no page node and no declared syntax in the affected files), `route-path-partial`, `route-without-implementation`, `call-site-unresolved` (`UnresolvedCall`), `operation-unlinked` (no `services[]`, so no resolver links: the case of a single-repo app with an `openapi` hint), `link-route-unreached` (`callersOf` was partial or hub-pruned), and `flows`/`name` (optional). A deterministic miss is a gap, never a guess.

**T45 is settled here.** The brief is built from a section registry like every other prompt (`PromptSectionDef`, `assembleDefs`, `stability` and `reason` per section, `prompt-registry-rule.test.ts`): static sections (role, return shape, boundary, the patch contract) are byte-identical for every app; run sections carry the base, the delta, the skeleton and the gaps; the closing recap carries the contract. Where routes and clients are found comes from the registry's declarations (route-table syntax, manifests) passed as facts, never from a framework named in text. `buildContextTask` (`task-builders.ts:22-93`) is deleted, not edited. A test renders the brief for an Angular-shaped and a React-shaped fixture and asserts the static sections equal and no framework name appears in them.

**The role (a):** a new read-only agent `qa-context`, after `qa-proposer` (`agents/opencode.json:249`): tools `read` only, the same `permission.read` deny list (env files, `e2e/.auth/**`, `storageState*.json`, `client.p12`, `cert.pass`), a step cap, its model from the role config (`modelForRole`, `platform/agent-runtime/types.ts:118` pattern), nothing in code names a model. It writes nothing: the orchestrator writes the map. It is not given the code-graph tool: the engine hands it the graph facts in the skeleton and the gaps, and widening that tool beyond `qa-lead` is a separate governance decision (Q5). The author target `context` (`sidekick-kinds.ts:80-92`) and its branch (`author-dispatch.ts:14-16`) are deleted. If a context run has no gaps and no affected key needing the agent, **no agent turn runs**: a patch-only run is deterministic end to end.

### R12. Engine/AI boundary rows and pillar checklist

Rows to add to the table in `AGENTS.md` ("Engine/AI boundary"), each flipped to "in force" by the unit that lands it:

| Decision | Decides | Rule it follows | Status |
|---|---|---|---|
| Whether a run may proceed without a map that describes its commit | Engine | A fitting map or a typed end; the exemptions are `context-run`, `purpose`, `regression`; a frozen run or a relaunch never defers | lands with RFC-0016 U1 |
| Which entries of the map a commit invalidates | Engine, from git | The files each entry names; no size or age constant once links carry `files` | lands with U4 |
| What fills an entry the engine cannot derive | Agent with facts, the engine verifies | The agent returns a patch over named gaps; every cited file is read, the merged map passes the form check, an entry outside the gaps is refused | lands with U7 |

Pillars (ADR-0001), one line each:
- **P1 determinism with flexibility**: the gate, the delta, the skeleton and the merge are deterministic; the agent is confined to named gaps and its answer is verified. Identical commit and identical stored map give an identical gate decision and an identical skeleton.
- **P2 boundary by rules**: R12 rows; the lead gets no tool for a fact the engine holds.
- **P3 signals, not thresholds**: retires `CONTEXT_MAP_MAX_AGE_MS` (time constant) once links carry `files`; adds no new constant (the loop bound is structural).
- **P4 app-agnostic through ports**: three ports; framework knowledge only in the language registry; no framework in text.
- **P5 mechanism, not symptom**: the cause is that the precondition is not an engine invariant and the rebuild forgets what it knew; nothing app-specific.
- **P6 test quality is the product**: runs stop grounding without a map (the lead plans with the FE-BE context), and the withheld links of the pages under test are a recorded signal, not silent.
- **P7 no pattern for its own sake**: no new context, no Command; the removal list below is larger than the addition list.

### R13. Reuse inventory

**Reused as they are:** `parseNameStatusZ`, `ChangedFile` and the file-naming of `contextMapValidity` (`context-map-validity.ts`); `isCommitSha` (`git-revision.ts:13`); `decideRunFreeze` / `RunFreeze` (`run-freeze.ts`); `contextMapRequest` (`run-prework.ts:78`); the `parentRunId` column, `trackRun`, `enqueueTrackedRun`, `JobQueue`; `PendingChangeSets`; `runEnd`, `END_EFFECTS`, `finalizeRun`, `failure-policy.ts`; `ERROR_CLASS`, `NON_LEARNING`, `OBSERVED_OPERATING`; `ContextRepository.saveContextMap/loadContextMap/markContextStale/clearContextStale`; `isValidArchitectureContext` (moved, not rewritten); `loadContextMapFromDisk` (as adoption); `ContextProvenance`, `mapProvenance`, the `qayaba.context.recapture` counter; `CodeGraphPort.routes` / `callersOf`, `WalkPolicy`; `ServiceLink`, `deps.serviceLinks`; `parseOpenApiYaml`, `findOp`; `RouteTableSyntax` and `LanguageRegistry.routeTableSyntaxesFor`; `closingJsonObject`; `PromptSectionDef`, `assembleDefs`; `AgentRuntimePort` and the proposer + scorer pattern; the confined reader/writer (`spec-path-confinement.ts`); `publishKindFor` (`publish-policy.ts`); the campaign `preflight` and the `restored_digest` comparison.

**Deleted or replaced** (also the list under "Patches it supersedes"): `rebuildContextMapFirst`; `RunnerDeps.contextMapNeedsRebuild`; `contextMapNeedsRebuild`, `ContextMapRebuildPorts` and `context-map-rebuild.ts`; `platform/composition/context-map-wiring.ts`; `contextMapRebuildRequest`; `PreworkMemory.contextMapRebuilt` and its two methods (the login-bootstrap half stays); `RequestContextHeal`, `EnqueueContextRunPort`, `ContextHealRunRequest`, `enqueueContextHealRun` and the `enqueueContextRun` dep (`wire-app.ts:321-324`, `:372`); `staleFlagHeal`, `staleMapHeal`, `ContextHealAction` (`context-heal.ts`); `contextHealRequested`, `requestMapHealIfDue`, `mapFitsRun` and the policy in the `loadContextMap` closure (`run-engine-factory.ts:387`, `:705-724`, `:973-1017`); `gitChangedFiles` and the `contextMapChanges` test seam (`:358-378`); `ContextMapWrittenThisRun` and the file read-back in `ContextMapCapturePortAdapter`; `buildContextTask`; the author target `context`; `CONTEXT_MAP_MAX_AGE_MS` (after maps carry `files`); the second `ArchitectureContext` declaration (`shared-kernel/grounding.ts:2-8`) where a unit touches its consumers. `recordContextHealRequest` and the `context_heal_requests` table are written and read by nothing (F6): dropping the table is a migration (item 1) and is a separate decision.

### R14. Work units, in order

Estimates are changed lines including tests, about 400 each; a unit that passes 400 says why. Every unit runs the full gate, observes RED first, adds the differential check below, and closes with its Risk line. A unit whose Risk line names a high-risk item gets its own commit and one independent verifier.

| # | Unit | Content | Risk |
|---|---|---|---|
| U1 | **The precondition, its two ends and the follow-up** (~450; passes 400 because the engine half and the shell half must land together: an engine that returns a follow-up nobody executes would lose the run) | `context-map-gate.ts` (need/status/gate), `ContextMapStorePort`, step `ensure-context-map`, end reasons `context-map-pending` and `context-map-unavailable`, `E-CONTEXT-MAP`, `RunQaResult.followUp`, `RunInput.relaunch`, `RunnerDeps.followUp` executing [C, R] with the lineage, `trigger: "relaunch"`, `PendingChangeSets.hold`, dedupe of a queued context run. Triggers A, B, C still exist: A runs first, so the gate normally finds a fit; it is the net under their failures. | Risk: item 4 (two runs enqueued after one ends, change-set handoff, queue order) and item 3 (a run with no fitting map used to go on; the run record gains an end and a class) |
| U2 | **Delete the three triggers** (~-300 / +150) | Remove A, B, C and their helpers (R13 list); one status evaluation per run read by both consumers; `TreeDiffPort` on `GitMirrorReadAdapter`, `gitChangedFiles` deleted; service-triggered `present` need (settles F1); retarget their tests before deleting. | Risk: item 3 (removes shared internals and changes which `recapture` values runs record; the differential check pins a fitting-map run byte-equal) |
| U3 | **Frozen runs and campaigns** (~250) | `refuse` for a frozen run; `scripts/campaign.ts` preflight builds the map per case commit; `qayaba.context_map.digest`; `campaign-compare` marks a differing digest invalid; `docs/efficiency-benchmark.md:516-524` | Risk: item 3 (campaign launcher and comparison behaviour; a replicate that used to run with an unfit map now ends environment-invalid) |
| U4 | **The delta** (~380) | `ContextMapDelta` in `shared-kernel`; `contextMapValidity` becomes a projection of `contextMapDelta`; blocking vs tolerated; optional `files` on `feBe`; the age bound applies only to a map without `files` | Risk: item 1 (the persisted map format gains an optional field and validity changes meaning for maps that carry it) |
| U5 | **Skeleton: routes and operations** (~400) | `deriveContextSkeleton` for `routes` and `api` over `CodeGraphPort.routes`, the route-table nesting and `parseOpenApiYaml`; the `service-topology/application` export; gaps `routes-undeclared`, `route-path-partial`, `route-without-implementation`; coverage counters on the run record (`gateSignals.contextMap.derived/gaps`), measured on the repositories available, never a gate | Risk: item 3 (the stored map every run grounds on changes content; golden-fixture tests pin it) |
| U6 | **Skeleton: links** (~350) | `feBe` from `ServiceLink` + `callersOf`; `files` on each link; gaps `call-site-unresolved`, `operation-unlinked`, `link-route-unreached` | Risk: item 3 (same) |
| U7 | **The role, the brief, the patch admission** (~450; governance-sensitive, **ships alone**) | `qa-context` in `agents/opencode.json` + `agents/agent/qa-context.md`, roster fixture, `types.ts` role, `agent-tool-surface.test.ts` (read only, credential deny list), the section registry for the brief, `LlmContextBuilderAdapter`, `applyContextPatch`, engine-written map and file; delete `buildContextTask`, the author target `context`, `ContextMapWrittenThisRun` | Risk: item 2 (an agent role grant and a prompt contract; it removes the author's write of the map and adds a read-only role) |
| U8 | **Records** (~150) | ADR recording the owner's answers; the three rows of R12 flipped; `AGENTS.md` (run flow, grounding bullet, step count, invariants, the "Modes" paragraph), `docs/lead-sidekicks.md`, `docs/efficiency-benchmark.md`; this RFC's status | Risk: none |

Order reason: U1-U3 enforce the owner's rule with the builder that exists, at no extra cost to a non-frozen run (A already rebuilt in-turn); U4-U7 reduce the cost of a rebuild and remove the framework named in the prompt. The map is correct and complete before it is cheap.

## Patches it supersedes

- `platform/entrypoints/runner.ts:83`, `:147-151`, `:517`, `:667-682` (prework A and its stage); `engine/.../domain/run-prework.ts:33-35` (the negative list, kept for the login half), `:51-70` (map half), `:83-85`.
- `engine/.../application/context-map-rebuild.ts` (whole file) and `platform/composition/context-map-wiring.ts` (whole file).
- `engine/.../domain/context-heal.ts` (whole file), `request-context-heal.use-case.ts` (whole file), `ports/enqueue-context-run.port.ts`, `domain/context-heal-run-request.ts`; `wire-app.ts:321-324`, `:372`.
- `platform/composition/run-engine-factory.ts:358-378` (`gitChangedFiles`), `:387` (`contextHealRequested`), `:396` (`contextMapWrittenThisRun`), `:686-724` (flag heal, map heal, `mapFitsRun`), `:973-1017` (the closure's policy).
- `engine/.../generation/infrastructure/prompt-builders/task-builders.ts:22-93` (`buildContextTask`), including `:58`, `:76`, `:80`; `coordination/application/sidekick-kinds.ts:80-92` (`context` target), `author-dispatch.ts:14-16`.
- `engine/.../generation/infrastructure/adapters/context-map-capture-port.adapter.ts:31-43` (file read-back).
- `engine/src/shared-kernel/telemetry/context-provenance.ts:24-25` (`CONTEXT_MAP_MAX_AGE_MS`), after U4 and a rebuild of every legacy map.
- The "recapture requested/skipped" paths of `mapProvenance` (`run-engine-factory.ts:712-717`, `:979`): the gate records its own status instead.

## Test plan

RED first, through a public seam, one test per rule; the previous behaviour of everything that shares the changed code is pinned by one test each.

1. **Gate** (`RunQaUseCase` with fakes, the pattern of `run-qa.use-case.test.ts`): a diff run with no map ends `context-map-pending`, spends no install, no deadline arming, no agent turn, returns a `followUp`; verdict `skipped`; no Issue; nothing learned; `classify-skipped` still wins when the commit is `skip`. A fitting map: the run proceeds and `RunState.grounding` holds it. Exemptions: context run, `purpose` run, regression run (`generating: false`) never consult the store. Service-triggered run: present-only.
2. **Loop**: a run with `trigger: "relaunch"` and no fitting map ends `context-map-unavailable` (`infra-error`, `E-CONTEXT-MAP`), persisted, not learned, no Issue, never a `followUp`. A context run never defers.
3. **Frozen**: a campaign-tagged run with a non-fitting map ends `context-map-unavailable` (`frozen-run-without-map`); with a fitting map it proceeds, byte-equal to today's grounding; the digest is recorded.
4. **Shell** (`runner.test.ts` pattern): a `followUp` enqueues C then R in that order with `parentRunId`; R's request equals the original's on every field of the list in R6 step 3 and carries the closed change set of a coalesced webhook run; a queued context run of the same app and commit is reused; cancelling the original before the follow-up leaves nothing queued; R is not coalescible; `previousNamespace` empty.
5. **Status unreadable**: a comparison that throws ends `context-map-unavailable` (`status-unreadable`) and is logged loudly; it is never a pass.
6. **Delta**: table-driven over `contextMapDelta`; every case of today's `context-map-validity.test.ts` still passes through the projection; new cases for a deleted declaration (patch, affected = its entries), a deleted implementation file, an added file of an existing route-source kind (`discover`), an unreadable commit pair (full), a legacy map without link `files` (age bound), a map with `files` (no age bound).
7. **Admission**: a patch key outside `affected` ∪ gaps is refused and the map is unchanged; a cited file that does not exist refuses the entry; a dangling link or a duplicate route fails the form check and nothing is stored; applying the same patch twice gives the same map; `builtAtSha` is the run's.
8. **Skeleton** (fakes for the graph, the contract documents, the links): each source maps to its entries; each miss is the named gap; no entry is guessed.
9. **T45**: the context brief for an Angular-shaped and a React-shaped fixture has equal static sections and no framework name in them.
10. **Role**: `agent-tool-surface.test.ts` lists `qa-context` with `read` only and the credential deny list; no model name in code (`platform/no-model-literals.test.ts`).
11. **Differential check** (AGENTS.md test policy; scratch copy of the base commit, never committed): for a run with a fitting map, the grounding result, the change scope and the prompt are byte-equal before and after U1-U2; `contextMapValidity` outputs are equal through the projection for every fixture of U4.
12. **Architecture**: `npm run arch:check` with no new shell exception (the shell-exception list only shrinks, `ADR-0024`); the new step is counted (50) in the test that pins the table.

## Measurement

Before and after on one app with one replicate each; one against one shows a direction, not proof (S3).

- **Runs grounded without a map.** Before: the counter `qayaba.context.recapture{qayaba.context.recapture.outcome}` (`platform/telemetry/instrument-table.ts:40`, `attribute-registry.ts:347`) for `requested` and `skipped` over the last N runs per app, read from Tempo, and the `contextMapLeftOut` event. After: zero for every non-exempt run; the exempt kinds are named by the step's `skipReason`.
- **Cost of a map update.** On one app with a one-route-file change: before, the context run's steps, tokens and wall time (a whole rebuild, `buildContextTask`); after, the same for a patch run, and the share of context runs that had no agent turn (`gateSignals.contextMap.derived`, `.gaps`).
- **Lineage integrity.** Every `context-map-pending` has exactly one context child and one relaunch child (`parent_run_id`); `context-map-unavailable` count per app; a streak is the `OBSERVED_OPERATING` finding.
- **Comparability.** Replicates of one campaign case carry the same map digest.
- **Skeleton coverage.** Per app, the entries derived vs the gaps by kind; the figure that tells whether option C of Fork 3 is within reach. Recorded, never a gate.

## Owner decisions needed

1. **Q1. Verdict of the deferred original.** Recommended: `skipped` with a typed end reason and a note (R5). Alternative: a seventh verdict `deferred`, a contract change for the client, web, SDK and graders (item 3).
2. **Q2. A routed page whose implementation file changed (its links withheld).** Recommended: tolerate it as today, record it as a signal, and refresh it in the next patch. Alternative: block, which sends every frontend commit that touches a routed page through a context run.
3. **Q3. Service-triggered runs.** Recommended: they need a map to be present, not to fit (their sha is not the primary's); when absent the context run is built at the primary mirror's head. Alternative: exempt them entirely, which leaves F1's path without a rule.
4. **Q4. Campaigns.** Recommended: Fork 4, option D (refuse in the engine, the launcher builds the map first, digest per replicate).
5. **Q5. The role.** Recommended: a new read-only `qa-context` with `read` only and no code-graph tool; the engine gives it the graph facts. Alternative: keep `qa-author` with target `context` and a whole-map answer (Fork 3, option A), which keeps the author's write authority on the map.
6. **Q6. Gate-requested context runs and the repository.** A clean context run publishes a `docs(context)` pull request on a non-shadow app (`publish-policy.ts`, `decided-end.ts`). With incremental rebuilds that becomes frequent. Recommended: a context run requested by the gate does not publish (the database is the source of truth, the committed file only a fallback adopted once into the store); an explicit context run (API, onboarding) still publishes.
7. **Q7. The 14-day age bound.** Recommended: retire it for maps whose links carry `files`; legacy maps are rebuilt once. Alternative: keep it as a ceiling, which keeps a time constant in place of a signal (P3).

## Out of scope

- Making the Context Pack, the lessons or the Go client follow a relaunch (a client may read `facts.contextMapFollowUp`; following it automatically is a client change).
- Dropping `context_heal_requests` (a migration, item 1).
- Widening the code-graph tool to `qa-context`.
- Resolver links for an app that declares no `services[]` (the topology resolving against the app's own `openapi` hint); until then those apps' links are the agent's, as gaps.
- Collapsing the other duplicate declarations of the map's shape (`PageMap`, `FittedContextMap`, `ArchitectureContextSchema` in `contract/commands.ts:948-954`) beyond the one a unit touches.
- A backoff for an app whose map keeps failing to build.
