# RFC-0011: Cross-repository impact follows the declared links over more than one hop (S7)

- **Status:** Accepted, 2026-10-30 ([ADR-0014](../adr/0014-owner-decisions-rfc-0011.md))
- **Implementation:** landed on `fix/root-cause-t29`, 2026-10-30, rebased on `86549a4c`: U0 `cc909839`, U1 `f4b3c3c8`, U2 `5b65b04f`, U3 `8bc3f271`, U4 `4c46969e`, U5 `27dfafc3`, U6 `3298b1d4`. Pending: the one replicate on an app that declares a backend-to-backend or event boundary (owner's go).
- **Code references at f8d25c3e:** `qa-engine/src/contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts`, `qa-engine/src/contexts/service-topology/domain/cross-repo-impact.ts`, `qa-engine/src/contexts/service-topology/infrastructure/adapters/service-links-port.adapter.ts`, `qa-engine/src/contexts/service-topology/infrastructure/resolver-factory.ts`, `qa-engine/src/contexts/service-topology/infrastructure/composite-resolver.adapter.ts`, `qa-engine/src/contexts/service-topology/infrastructure/http-backend-resolver.adapter.ts`, `qa-engine/src/contexts/service-topology/infrastructure/event-resolver.adapter.ts`, `qa-engine/src/contexts/service-topology/infrastructure/mirror-registry.adapter.ts`, `qa-engine/src/contexts/service-topology/domain/index.ts`, `qa-engine/src/shared-kernel/service-links.ts`, `qa-engine/src/shared-kernel/code/index.ts`, `qa-engine/src/shared-kernel/ports/code-graph.port.ts`, `qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/ground.steps.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/opening.steps.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/decided-end.ts`, `qa-engine/src/contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts`, `qa-engine/src/contexts/change-analysis/domain/reach-proof.ts`, `qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-sections.ts`, `qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-renderers.ts`, `src/server/run-engine-factory.ts`, `config/apps/example.yaml`. This record pins f8d25c3e (the head of the refactor branch when it was written), not 4105c582: `ground.steps.ts` and `run-engine-factory.ts` lines moved between the two. Read a line with `git show f8d25c3e:<path>`.
- **Related:** [ADR-0001](../adr/0001-design-pillars.md) (P3, P4, P5, P7), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [ADR-0008](../adr/0008-product-version-source.md) (open question 2 below), [RFC-0002](./0002-platform-steps-0-1.md), [RFC-0009](./0009-pack-record-matches-prompt.md) (the pack record is not touched). No slice of the family RFCs edits `service-topology` or `change-scope-port.adapter.ts`.

## Summary

1. The owner asked for it on 2026-10-30 (translated): "A change can travel between repositories indirectly, that is exactly what this system was made for. If A is changed, A calls endpoint B and that one depends on microservice C, that should be seen." (L21 of the feature document.) Today impact is one hop, in one direction.
2. Cause, confirmed by reading (no run shows a missed page; this is a capability gap the owner specified, S7, not one of the hypotheses of the investigation): the use case answers only the links INTO the changed repo, the step never feeds its own answer back, and the one consumer that reaches pages walks the callers of every impacted link in the app's own index, where a backend call site does not exist.
3. Proposal (O2): treat the links the run already resolved as a graph over repositories and walk it from each changed repo, with the primitive the engine already has (`callersOf` on a repo's index, under `DEFAULT_WALK_POLICY`), upstream (who depends on what changed) and downstream (what the changed code depends on). A repo with no index stops the hop and says so.
4. No new constant: the walk ends because every link enters the answer once and the repos are finite; each hop's walk keeps the policy's own "partial, never proven absent" semantics. An app that declares no BE-to-BE or event link keeps today's one hop, byte for byte.
5. Eight forks are the owner's (end of the record); the main one is where the index of an intermediate, unchanged repo comes from.

## Problem

Evidence labels: a statement without a label is confirmed (the file was opened at f8d25c3e). **Hypothesis** is an inference; **assumption** is something I could not verify (listed at the end of the Problem).

### What exists

The run resolves, once, every link of the app's declared repos: `ServiceLinksPortAdapter.resolve` builds a pool (the primary repo as `front`, every declared service whose mirror exists) and runs the composite resolver over it (`service-links-port.adapter.ts:25-41`). The composite joins one resolver per declared boundary profile (`resolver-factory.ts:11-15`, `:18-31`; `composite-resolver.adapter.ts:45-80`):

| Boundary profile | Link it makes | `from` | `to` | Where |
|---|---|---|---|---|
| `http` | frontend call site to a backend operation | the primary repo's call site | the backend repo, its contract file, the operation | `openapi-http-resolver.adapter.ts:265` |
| `http-backend` | backend call site to another backend's operation | any repo of the pool, the enclosing method of the call | the called service's repo and operation | `http-backend-resolver.adapter.ts:85-128` |
| `event` | publisher to listener, joined by event name or stem | the publisher's class | the listener's class | `event-resolver.adapter.ts:92-109` |

So the data of a multi-hop walk is already in `state.grounding.serviceLinks` (`ground.steps.ts:146`, written by `resolveServiceLinks`). Every `ServiceLink` carries both ends as `{repo, file, symbol}` (`service-links.ts:4-20`). The profiles exist in the example configuration (`config/apps/example.yaml:38-65`) and `serviceTopologyWired` needs only `services` and `boundaries` to be non-empty (`src/server/run-config-gates.ts:13-15`).

### The causal chain

| # | What happens | Where |
|---|---|---|
| 1 | The step asks the use case once per service entry of the change (the trigger and each other `role: "service"` entry), and skips a repo no link targets. The primary repo is never a candidate: an app-only change asks nobody. | `ground.steps.ts:147-155`, `:158-159` |
| 2 | The use case keeps only the links INTO the repo it was asked about. | `resolve-cross-repo-impact.use-case.ts:39` |
| 3 | It walks the changed symbols of that repo in that repo's index (`impactedSymbols`), takes the backend routes the walk reached, and marks a link impacted when its operation is served by a reached handler or its `operationId` name is reached. | `:79`, `:85-97`, `:124-131` (`routeServesOperation`, `cross-repo-impact.ts:17`) |
| 4 | It returns `{ impactedLinks }` and nothing is asked of any repo it names. A link `B -> C` is impacted when C changes; the links into B (the app's calls to B) are never looked at. | `:99-101`; `ground.steps.ts:161`, `:169` (the answer is merged, never re-fed) |
| 5 | The change scope turns the impacted links into pages: it seeds the `from` call site of every impacted link and walks its callers in the APP's index only. | `change-scope-port.adapter.ts:79`, `:163-188` (`callSiteWalk`, `callersOf(pages.repoDir, seeds)` at `:182`) |
| 6 | For the chain app, B, C, the impacted link is `B -> C`, whose call site is a file of B. The app's index does not hold it: `callersOf` answers "a name the index does not hold is absent" (`code-graph.port.ts`, the `callersOf` comment) and the walk is empty. No page is reached. | `:167-176`, `code-graph.port.ts:14-15` |
| 7 | The other direction does not exist at all: the links out of a changed repo are never read. `linksOf` and `callSiteWalk` take impacted links only. | `change-scope-port.adapter.ts:223-231`, `:167` |
| 8 | The record and the prompt carry what step 4 produced: `crossRepoImpactedCount = impactedLinks.length`, set only when an impact exists (`decided-end.ts:339`), and the prompt's service-links section marks the links the use case returned (`generator-sections.ts:175-188`). A run on the app alone leaves the count absent, which the owner read as "empty". | `decided-end.ts:338-339` |

Two further facts the chain depends on:

- **Which repos have an index in a run.** The run indexes the classify-source repo, the primary repo on a service-triggered run, and the other service entries OF THE CHANGE (`opening.steps.ts:95-115`; wiring at `run-engine-factory.ts:1043-1048`, `codeGraphRepoDirs` built from `companionServices`). An unchanged intermediate repo B is not indexed. The adapter says so: a repo the run did not index answers unavailable, never an empty graph (`codegraph-code-graph.adapter.ts:8`, `:394`, `:415`). A hop through B therefore needs B's index built first, or it stops.
- **A latent defect in step 5, confirmed by reading.** `callSiteWalk` seeds every impacted link's `from` in the app's index without comparing `link.from.repo` with the app's repo (`change-scope-port.adapter.ts:167-176`). Today a BE-to-BE or event link into the changed service is already seeded there. It is harmless only while no file and symbol of the backend equals one of the app's (hypothesis: no run shows a collision).

### What the evidence does not show

- No run in the record misses a page because of this. The gap is read from the code and from the owner's example; the RED test below is the first reproduction.
- The effect on test quality (P6) is a hypothesis: a spec for a page whose backend dependency changed two repos away is written without the change in its prompt. The signal exists (`change-scope` reach entries) but no run measures its consequence.

### Assumptions (not verified)

- The configuration of the app the owner used declares no `http-backend` or `event` boundary (recorded in T29 of the feature document; `config/apps/` is user data and was not read here). With only `http`, the link graph has no `B -> C` edge, so nothing in this record would change that app's run until the owner declares the boundary.
- `ImpactedSymbol.seeds` is filled for a symbol reached from several seeds on a `callersOf` walk (`code-graph/index.ts:51`, `:59`; the type says so, no walk was executed).
- A mirror of an unchanged service B is on disk whenever a link has B as `from`: the resolvers only scan pool repos whose mirror exists (`service-links-port.adapter.ts:30`), so this holds by construction; whether that mirror is at the commit DEV serves is not verified.
- The event link's direction (publisher is `from`, listener is `to`) is read from `event-resolver.adapter.ts:99-100`; whether "listener's repo changed" should impact the publisher is the existing rule (`reachedNames.has(link.contractRef ?? link.to.symbol)`, `use-case.ts:90`) and is not re-examined here.

## Goals and non-goals

Goals:

- **G1** A change in any repo of the run reaches, over the declared links, every repo and page that depends on it, however many hops (upstream), and the run knows what the changed code depends on beyond its first neighbour (downstream).
- **G2** The walk is bounded by the engine's existing means: `WalkPolicy` per hop and a visited set; no hop count, link count or size constant is added (ADR-0001 P3).
- **G3** A hop that cannot be walked says where it stopped and why. An unwalked hop proves nothing about absence.
- **G4** One rule for every app and stack: the graph is built from `ServiceLink` alone; no transport, repo name or framework is named in the walk (P4, P5).
- **G5** An app with only FE-to-BE links, or none, gets the answer it gets today.

Non-goals: new link resolvers or boundary kinds; resolving a link the profiles do not resolve (external calls, dynamic paths, `rpc`); making downstream links a scope of pages or candidates; changing `WalkPolicy` values; any gate (the signal stays advisory); the deploy gate of intermediate services.

## Options

### O0. Leave one hop

Removes nothing. Risk: S7 stays unmet; the owner's example (A changed, B depends on C) shows nothing, and the page of A that reaches C through B is never grounded for a change in C.

### O1. Make the app's index walk further

Seed the app's index with the transitive closure of call sites, so the app's own walk covers B's code. Rejected: the app's index does not hold B's code (step 6), and indexing B's code into the app's graph breaks "one repo, one index, one commit" (`codegraph-code-graph.adapter.ts:8`).

### O2. A link graph over repositories, walked with the per-repo inbound walk (recommended)

What it adds. One pure structure (the links indexed by `from.repo` and `to.repo`), one extra method on the use case that repeats, per hop, the matching it already does at hop one, and one on-demand index of the repo a hop walks. Nothing new in the code-graph port.

The primitive. `callersOf(repo, symbols)` answers which symbols reach the named ones, walked inbound under the policy, with the route nodes reached and the seeds that reach each symbol. Both directions are this one question asked with different seeds:

| Direction | Question to repo R | Seeds | A link is impacted when |
|---|---|---|---|
| Upstream (who depends on the change) | which handlers of R reach the call sites of the links already impacted | `from.{file,symbol}` of each impacted link whose `from.repo` is R | a link INTO R has an operation a reached handler serves (the rule of `use-case.ts:85-97`) |
| Downstream (what the change depends on) | which call sites of R's outgoing links does the change reach | `from.{file,symbol}` of every link OUT of R | the call site is a changed symbol, or a changed symbol (hop one) or an operation's handler (later hops) is among the callers the walk reached |

Upstream, for the chain app, B, C with C changed: hop one is today's answer (`B -> C` impacted); hop two walks B's index from that call site, reaches B's handler for the operation the app calls, and marks `app -> B` impacted; the app's pages are then reached by `callSiteWalk`, unchanged, from the app's call site. Downstream, for the app changed: the app's index says which of its outgoing call sites the changed symbols reach (`app -> B`); B's handler for that operation (`routes()` target, `routeServesOperation`) is looked for among the callers reached from B's outgoing call sites, which marks `B -> C`; and so on.

The graph and the order.

1. Hop 1 is today's `resolve` for each changed service repo (upstream) plus the downstream pass over each changed repo, the primary included. Its output for a one-hop app is today's output.
2. Frontier: the repos named by the `from` of upstream links (for the upstream pass), or the `to` of downstream links (for the downstream pass), that no earlier hop walked in that direction. For each: ensure its index; ask `callersOf` once per repo and hop with every seed of the frontier together (the policy scales its budget with the seed count, `expansionBudget`); match; the new links are the next frontier.
3. Stop when no link is new. Termination does not depend on a constant: a link enters the answer once (`linkKey`, `use-case.ts:133`), the links are a finite set, and a repo is walked once per direction and hop.
4. Each link carries how it was reached: the links crossed from the changed repo, in order, and the direction. Hop one has none.

When a hop cannot be walked. The repo has no index and cannot be indexed (no mirror, the build failed or timed out), or `callersOf` answers unavailable: the hop is not walked, the repo and reason are returned as a stop of the impact (`stops: [{ repo, direction, reason }]`), and the links beyond it are not claimed. A walk the policy left partial returns the links it did reach, the stop says `partial` with the seed count, and the claim is a lower bound, exactly as the existing walk's `truncated` is logged at `use-case.ts:80-81`. The change scope copies each stop into its `degraded` list (the field and its span attribute exist: `change-scope.ts:70`, `ground.steps.ts:248`).

What the run carries.

- `ImpactedLink` gains an optional `reach: { direction: "upstream" | "downstream"; via: ServiceLink[] }`; absent means hop-one upstream, today's value (`service-links.ts:36-43`, `MATCH_TIER` unchanged). `CrossRepoImpact` gains optional `stops` (`service-links.ts:45-48`).
- `crossRepoImpactedCount` keeps its meaning, the number of impacted links, now across hops and directions (`decided-end.ts:339`); it is also set when the run's change is the app alone. See Q4 for the epoch note.
- The prompt's service-links section already lists the impacted links first with their tier (`generator-sections.ts:175-188`); each line of a link reached beyond hop one names the chain it came through and the direction (`generator-renderers.ts:110-124`). A stop is one line of the same section, so the agent is told which hop was not walked.
- `callSiteWalk` seeds only links with `reach.direction !== "downstream"` and `from.repo === pages.repo`, and its `prefixOf` label becomes the chain: the described `via` links in order, then the link itself, each in today's format `${to.repo}: ${operation}` (`change-scope-port.adapter.ts:173-174`). `walkChains` already prepends `prefixOf` to the proof steps (`reach-proof.ts:103`), so a page reached through B shows `C: <op>` then `B: <op>` then the app's symbols in its evidence. The tier stays `cross-repo`, basis `call-site`.
- `linksOf` (operation entry points) ignores downstream links: a downstream backend operation is not a flow a UI test starts at.

Risk: the extra index of the intermediate repo (cost, Q1); the downstream pass runs for every changed repo even when no multi-hop link exists (it asks nothing when the repo has no outgoing link, like the prefilter at `ground.steps.ts:159`).

### O3. A static fallback with no index

For a repo with no index, treat every link into it as reached when a link out of it is impacted. No walk, no index. Rejected: it marks every operation of B impacted whenever any B call to C is; the section is advisory and "values precision over completeness" (`service-links-port.adapter.ts:38`), and an imprecise fact is worse than a stop that is recorded (P6: the agent writes tests for noise).

## Recommendation

O2, with the index of an unchanged intermediate repo built on demand (Q1).

- **Why it is the smallest change.** Every part exists: the links (resolved once), the per-repo inbound walk and its bound (`callersOf`, `DEFAULT_WALK_POLICY`), the handler matching (`reachedHandlerRoutes`, `routeServesOperation`), the page proof from a call site (`callSiteWalk` and `prefixOf`), the `degraded` record. The new code is a frontier loop and a pure link index; the code-graph port, the proofs and the tiers are untouched.
- **Why it is app-agnostic.** The loop reads `ServiceLink` ends and `WalkPolicy`; it names no transport (event and HTTP links are the same edge), no repo, no framework. Which links exist is declared in `boundaries:` of the app's configuration (P4).
- **Where it lives.** The pure link index and the hop derivation in `service-topology/domain`; the loop in `ResolveCrossRepoImpactUseCase` (a second method beside `resolve`, sharing its matching); the on-demand index and the call from `resolveCrossRepoImpact` in `ground.steps.ts`, reusing the indexing of `opening.steps.ts`; the seed filter and the chain label in `change-scope-port.adapter.ts`.
- **How it answers the pillars.** P1: the same links and indexes give the same answer; the order of the frontier is the links' sorted key. P3: no size constant (G2). P4/P5: above. P6: a page's prompt now holds the change that reaches it; nothing here makes a weak test pass. P7: the complexity added is one loop; the failure family it removes is "a change two repos away is invisible" (S7).
- **Config.** BE-to-BE links need an `http-backend` or `event` profile in the app's configuration (the profiles exist; `example.yaml:45-65`). An app that declares none has no edge beyond FE-to-BE and keeps the one hop (G5); the engine does not infer a boundary.

## Patches it supersedes

None to remove. Three places change meaning, each in the same commit as its test:

- `callSiteWalk` stops seeding links whose `from.repo` is not the app's repo (`change-scope-port.adapter.ts:167-176`): fixes the latent defect above for the one-hop case too.
- The step's prefilter and the "primary is never asked" rule (`ground.steps.ts:153-159`) give way to a per-direction frontier.
- `mergeImpacts` merges `stops` and de-duplicates links reached from two changed repos (`ground.steps.ts:173-179`).

## Test plan

Through public seams, with fakes for the ports (`CodeGraphPort`, mirrors, VCS read) and the real use case and change-scope adapter.

**RED test (the first commit, fails today for the bug's reason).** Seam: the run flow's two steps (`resolveCrossRepoImpact`, `computeChangeScope`) in the rig of `qa-engine/test/contexts/run-orchestration/application/run-qa.change-scope.test.ts`, with `deps.crossRepoImpact` = `CrossRepoImpactPortAdapter` over the real use case, `deps.changeScope` = the real adapter, and a fake `CodeGraphPort` keyed by repo directory.

| Piece | Fake |
|---|---|
| Change | a service entry C, one changed file |
| `serviceLinks` | two links: `app -> B` (http, call site `web/orders.api.ts#listOrders`, operation `GET /orders`) and `B -> C` (http-backend, call site `b/OrderClient.java#fetch`, operation `GET /items`) |
| Index of C | `impactedSymbols` reaches the handler of `GET /items` |
| Index of B | `callersOf([b/OrderClient.java#fetch])` reaches the handler of `GET /orders`; `routes()` lists it |
| Index of the app | `callersOf([web/orders.api.ts#listOrders])` reaches the page `/orders`; it holds nothing of B's files |
| Asserts | the scope reaches page `/orders` with tier `cross-repo`, basis `call-site`; its evidence begins `C: GET /items`, then `B: GET /orders`; `crossRepoImpactedCount` is 2; no `degraded` entry |
| Fails today because | only `B -> C` is impacted; its seed is looked up in the app's index, where B's file does not exist; no page is reached and the count is 1 |

Further tests, each named by behavior, added with their unit:

- T2 B has no index and cannot be built: the scope still holds the hop-one link, `degraded` names `B` and the reason, and no page is claimed.
- T3 A walk the policy leaves partial: the links reached are returned and the stop says `partial`.
- T4 A cycle of links (`B <-> C` by events) ends and returns each link once.
- T5 Downstream: the app changed; `app -> B` and `B -> C` are impacted with `direction: "downstream"`; no page or operation entry comes from them.
- T6 A link whose `from.repo` is not the app's repo is not seeded in the app's index (the latent defect).
- T7 One hop, FE-to-BE only: the impact, the scope and the prompt section are equal to the base's (the differential check below).
- T8 Two changed repos reaching the same link: it appears once.

**Differential check** (`AGENTS.md`, test discipline): run the one-hop fixtures of the existing `resolve-cross-repo-impact.use-case.test.ts`, `change-scope-port.adapter.test.ts` and `run-qa.change-scope.test.ts` on the base commit in a temporary copy and on the change; stdout, record and prompt section must be identical for every case without a link beyond hop one. Committed tests never read git history.

## Measurement

- **Deterministic proof:** the RED test, and T7 as the control. That is the evidence that the cause is gone; one run against one shows a direction, never proof ([ADR-0011](../adr/0011-root-cause-fix-policy.md)).
- **One replicate on the owner's go** (D13, one per version), on an app that declares an `http-backend` or `event` boundary (Q8 of the owner's configuration), with a change in the called service. Signals: `qayaba.change_scope.cross_repo` (reach entries of tier `cross-repo`, `ground.steps.ts:245`), the evidence lines of those entries (the chain), `qayaba.change_scope.degraded` (the stops), `qayaba.code_graph.index` spans for the repos indexed on demand (outcome and duration), `crossRepoImpactedCount` on the run record.

| Signal | Before | After, if the cause is gone |
|---|---|---|
| Pages reached through an unchanged intermediate repo | 0 (step 6) | the app's pages that reach the changed service, each with a chain of two or more links in its evidence |
| `crossRepoImpactedCount` for a change in C with `app -> B`, `B -> C` | 1 | 2 (and more downstream) |
| `qayaba.code_graph.index` spans | the changed repos and the primary | plus the intermediate repos a hop walked |

Read the structure, not the counts. The count series changes meaning at this commit (Q4): record the break in the timeline's epoch table, do not pool runs across it ([ADR-0011](../adr/0011-root-cause-fix-policy.md), rule 7).

## Implementation units (in order)

Each unit is a commit with its tests and docs (help text, `AGENTS.md` cross-repo paragraphs). Risk lines per the list in `AGENTS.md`; a unit that names an item gets its own commit and the independent verifier.

| # | Unit | Risk |
|---|---|---|
| U0 | The RED test and T7, as failing/pinned tests, in the rig above. | none |
| U1 | Pure link index and the hop derivation in `service-topology/domain` (links by `from.repo`/`to.repo`, `linkKey`, chain), with T4 and T8. | none (new pure code; no shared function changes) |
| U2 | The use case: the matching of `resolve` (tier 2 and handler routes) becomes one private method shared by hop one and the later hops; `resolveHops` for the upstream direction; `reach` and `stops` on the kernel types. T2, T3. Differential check on `resolve`. | item 3 (the shared matching and the kernel `ImpactedLink`/`CrossRepoImpact` types are consumed by the generation context; the change is additive and the hop-one answer must stay equal: the differential check proves it) |
| U3 | The step: frontier loop in `resolveCrossRepoImpact`, the on-demand index of the repos a hop walks through the existing `indexOne` (exported from `opening.steps.ts`), with the run's abort signal. | item 4 (`CodegraphCodeGraphAdapter.syncTo` replaces the adapter's run signal and clears its cached walks, `codegraph-code-graph.adapter.ts:174-177`; calling it mid-run must be sequential, with the run's signal, and before the hop's walk) |
| U4 | Change scope: seed only `from.repo === pages.repo` links, chain label in `prefixOf`, copy `stops` into `degraded`, ignore downstream in `linksOf`/`callSiteWalk`. T6. Differential check on `callSiteWalk`. | none after the shared-code check: `callSiteWalk` also serves hop-one links, and its output changes only for a link whose `from.repo` is not the app's (the latent defect), pinned by T6 |
| U5 | Downstream pass over each changed repo, including the primary; T5. | none (new path; additive) |
| U6 | The record and the prompt: chain and direction in the service-links lines, the stops, `crossRepoImpactedCount` over all hops; docs (`AGENTS.md`, `docs/efficiency-benchmark.md` row of the count). | item 3 (the persisted run field `crossRepoImpactedCount` changes meaning for runs after this commit; its readers are the probe report and docs, and the decision-blindness contract test keeps it out of verdicts) |

U3 and U6 each get their own commit. The units are sequential: U2 to U5 share the kernel types and the step, so they are one writer's work, not parallel units. A unit over about 400 changed lines is split by direction (U5 is already apart).

## Open questions

Each for the owner to decide; the recommended answer first.

- **Q1. Where the index of an unchanged intermediate repo comes from.** Recommended: build it on demand, only for a repo a hop needs (it is the `from.repo` of an impacted link or the target of a downstream link), at the commit its mirror holds, through the same `indexOne` and the store cache (a repeat run reuses or syncs the cached store). Alternative: index every declared service at `index-mirror` for every run of an app with a BE-to-BE or event boundary: no mid-run `syncTo`, but the cost is paid on runs that change only the app and need no hop. A third: no on-demand index, so only changed repos and the primary are walked and any hop through an unchanged repo stops (the smallest change; the owner's example, where B is unchanged, would stop at B and S7 would be unmet).
- **Q2. Which commit of B.** Recommended: the mirror's head, recorded on the index span (`qayaba.code_graph.sha`), as the primary repo is indexed (`opening.steps.ts:103`). Alternative: the commit DEV serves for B (`services[].versionUrl`, ADR-0008's version states, T19): exact, but needs T19 first and an app that declares `versionUrl` per service. Trade-off: the head can be ahead of or behind what DEV runs; a stale walk is advisory like the rest.
- **Q3. Both directions in this RFC.** Recommended: yes, as separate commits (upstream U2-U4, downstream U5), because the owner's example is downstream (A changed) and the first sentence of S7 names both. Alternative: upstream only now: the downstream pass needs the app's outgoing call sites walked in its own index for every run, and it grounds without reaching a page, so its value is the weakest.
- **Q4. What `crossRepoImpactedCount` means.** Recommended: keep the name and count every impacted link, any hop, any direction; mark the epoch break at the commit. Alternative: leave it as the first-hop count and add `crossRepoImpactedBeyondFirstHop` and `crossRepoDownstreamCount`: no break in the series, two more persist-only fields and a prompt that explains three numbers.
- **Q5. A cap on the number of hops.** Recommended: none; the visited set and the policy bound the walk (G2, P3). Alternative: a hop limit as a constant. Trade-off: a constant is a size threshold the owner rejected as the way to adapt (ADR-0001 P3), and it would stop a long chain silently unless a stop is recorded; the policy's own partial flag already says when work was left.
- **Q6. Downstream links in the scope.** Recommended: grounding only (the prompt and the record); they add no candidate, page or operation entry. Alternative: let a downstream operation of B be an `operation` entry of the scope like the upstream ones. Trade-off: more candidates for flows a UI test cannot start at the backend; the candidate offer is already long.
- **Q7. A stop in the prompt.** Recommended: one line in the service-links section naming the repo and reason, framed as unverified like the rest of the section. Alternative: record it only in `degraded` and the span. Trade-off: the agent otherwise reads the absence of a link beyond B as "no dependency", which the section already says it must not (`generator-sections.ts:193`).
- **Q8. Boundary declaration for the app that motivated the request.** The app's configuration declares no BE-to-BE or event boundary (assumption), so its B to C links do not exist and nothing here changes its runs. Recommended: the owner declares the boundary profile the example file documents (`config/apps/example.yaml:45-65`) when this lands; the engine infers none. Alternative: ship without it and verify only with the fake-based tests; the replicate of the Measurement section then cannot run on that app.

## Out of scope

- **Unresolvable links.** External calls, dynamic call paths and `rpc` links are dropped by the adapter (`service-links-port.adapter.ts:38`); a hop that depends on one stays invisible. Not changed here.
- **Event matching.** First-match-wins joins and the stem fallback (`event-resolver.adapter.ts:94-95`) can make a wrong link; a multi-hop walk inherits it. The resolver's header names the risk; a separate question.
- **The dead field `CrossRepoImpact.serviceImpacted`** (`service-links.ts:47`; merged at `ground.steps.ts:174` and set nowhere at f8d25c3e). Removal belongs to platform step 1, not here. (Correction 2026-10-30: step 1 did not remove it; it is still at `service-links.ts:47` and `ground.steps.ts:174` at 17bb77c1. Unit U2 changes the same kernel types (`CrossRepoImpact`), so T29 U2 carries its removal.)
- **The deploy gate of an intermediate service** and any use of its version beyond Q2.
- **Whether the app's pages that reach the changed service are tested well** (P6): this record grounds the agent with the change; test quality is read from the signals of ADR-0005.

Not verified here: the cost of building an index of an unchanged service in a run (no measurement; the store cache should make a repeat cheap, hypothesis); that a handler symbol reached from a call-site seed carries that seed in `seeds` (the type says so, no walk was run); the content of the owner's app configuration; the freshness of an unchanged service's mirror.

## Implementation notes

What the code does where this record left a choice open, each decided with the recommended option of [ADR-0014](../adr/0014-owner-decisions-rfc-0011.md):

- **Which repos the downstream pass asks.** A changed repo is asked only when it starts a chain of two links (`LinkGraph.hasOnward`: a link out of it lands in a repo that has links out of its own). This is how G5 and Q8 hold: an app with only frontend-to-backend links, whose first hop would otherwise now be recorded downstream, keeps exactly today's answer. It follows from Q6 (grounding only) that nothing is lost by the first hop being recorded only when it leads onward.
- **Downstream attribution needs the walk's own statement.** A link out of a repo is impacted only when the walk states that its call site is among the seeds that reach the handler that entered (`ImpactedSymbol.seeds`); a handler reached with no statement impacts nothing, because a wrong downstream claim adds a link, where a wrong upstream attribution only picks which chain describes a link already reached.
- **Mirrors.** The mirror of every declared service reaches the run as `codeGraphMirrors` (repo, directory, head reader), built by the factory like `codeGraphPrimary`, under the gate `serviceTopology` uses. The step indexes through `indexOne` (now exported and returning the record). The mirror directory of an already-indexed repo is the one the opening indexed.
- **The port's later-hop methods are optional** (`resolveUpstreamHop`, `resolveDownstream`, `resolveDownstreamHop`): a port that answers the first hop only keeps the one hop. The traced port passes them through and records no context item for them.
- **Units.** U1 carried the additive kernel types and the removal of the unset, unread `serviceImpacted` field (RFC :211); the merge of `mergeImpacts` moved to `mergeImpactedLinks` in the same commit. U5's downstream pass reuses the repo list the scope reads (`changeRepos`).
- **The count.** `crossRepoImpactedCount` stays a plain optional number on the run record (`gateSignals`): a stored run reads back with the value it was saved with, so the series splits at U6 and is never rewritten. The break is written in `AGENTS.md`, `observability-design.md`, `efficiency-benchmark.md` and on the field's declaration (`run-outcome.ts`).
- **Not edited here.** The epoch row of the run index (`rejected-explanations.md`) lies outside this change's surfaces.

