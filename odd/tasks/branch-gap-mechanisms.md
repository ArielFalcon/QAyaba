# Branch gap mechanisms

Objective: the change-coverage branch gap (the untaken arms a regeneration is asked to close) holds only the change's own decisions, and the arms no test of the run can take reach the lead with the facts that say why and leave the regeneration by a basis the engine checks. Fixed by mechanism, for any app and any commit range.
Branch: feature branch off `main` after `worktree-agent-aa4282239b93783b2` (persistent test problems) and `worktree-agent-a15277ccb6ad0d93e` (structured agent answers) are merged. Delivery: ask-on-risk. Runner: `npm test` (node:test via tsx).

## Specs

- **S1** Owner request, verbatim (2026-11-01): "quiero que se identifiquen los mecanismos que dan este error en cualquier app o grupo de commits y corregir esos, si ahora causan el X% y en otro caso el Y% me da igual, se deben tratar los mecanismos que causan el error de forma transversal y corregirlo de raiz, siempre respetando las reglas del proyecto y la limpieza de la arquitectura hexagonal y DDD, respetando los dominios, las fuentes de verdad y la reparticion de responsabilidades".
- **S2** Earlier owner constraint for this step, verbatim: "debe buscar la solución segura que no causa regresión y que no quite funcionalidades". No arm leaves the measurement, the PR or the Issue; survivor closure, missing cases, graders and the enforce gap keep every input they have today unless an S# below removes a defect.
- **S3 (M1, build-added decisions)** A branch decision counts as the change's only when the source line the map places it at holds that decision (its condition or operator), by the same rule mutation sites already follow (`objective-signal/domain/mutation-site-source.ts`, `expressionOnSourceLine`): one rule, one owner, never a second implementation. Decisions placed on an arm line of a real multi-line decision stay (evidence: `navbar.component.ts:49` at ed28973). A file with no readable source keeps every decision (fail open). What the rule leaves out is counted on the record beside the mutation pass's `skippedSites`. Evidence: 10 confirmed build-added arms at ed28973 (runs `run-ed28973-mvxa8pvu-d4386ad1`, `run-ed28973-mvxbr8hz-82848d23`); scratch `scratchpad/branchcases/verify_listing.ts`.
- **S4 (M2, one decision counted twice)** One source decision is one arm pair however many bundle decisions map to it. Hypothesis to confirm with a RED test from the runs' data before fixing (`geo-restaurant.store.ts:171,184` repeating `:165,:178`); if not confirmed, record why and drop the task.
- **S5 (M3, template decisions)** A decision placed in a non-script file (a component template) follows S3 through the same expression-on-line check, since no language lister exists for it. Hypothesis to confirm first (`home.page.html:172`, `search.page.html:90`, `map.page.html:37,58` on `[(…)]` bindings).
- **S6 (M4, reachability facts missing from the gap)** Each gap unit the lead routes carries the facts the run already holds about its arm's reach, from their existing sources of truth and never re-derived: the data contradictions and defects of the pages its file seeds, the confirmed-empty pages, the route availability class, and the arm's own source line. Text only: no routing, verdict or gate changes. Evidence: the lead's gap prompt in both runs has no contradiction fact while the authors' briefs do.
- **S7 (M5, no typed way to decline an unreachable arm)** The lead may answer a gap finding with a typed decline whose basis reuses the plan's drop vocabulary (one vocabulary, `plan-coverage.ts`), verified by the engine against the run's facts the way a drop basis is; an unverified basis is asked about once and then honoured and recorded, as for drops. A declined arm stays in the measurement, the PR and the Issue, marked declined with its basis; a flow whose findings are all declined gets no revision turn; when nothing is left to route and no survivor is routed, the step ends on its existing empty outcome. Built on the structured answer contracts of the merged B branch. Needs its own RFC, an Engine/AI boundary row in AGENTS.md and its ADR, written in the same delivery.
- **S8** Out of scope here because another branch owns it: noise in the survivor "moved" signal and mutant spread (persistent test problems branch). Not reopened.
- **S9** Graders: a changed denominator bumps `GRADER_VERSION` and is regraded through the existing path; the docs (AGENTS.md "Branch coverage" and "Branch cases") describe the final state.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S3, S5 | delegated (context backstop) | pending (waits for both merges) | |
| T2 | S4 | delegated, same writer | pending | |
| T3 | S6 | delegated, same writer | pending | |
| T4 | S7, S9 | delegated, same writer; RFC first | pending | |
| T5 | S2 | independent verifier (item 3: graders and lead contract consumed by campaign tooling) | pending | |

## Log

- **L1** (2026-11-01) Owner, verbatim: "ese analisis de las ramas es extrapolable a cualquier aplicacion, es un patron base que se puede repetir o esta concidicionado a esta app o peor, a estos commits analizados?" then "el historial siempre es sobre esta app. quiero que se identifiquen los mecanismos que dan este error en cualquier app o grupo de commits y corregir esos, si ahora causan el X% y en otro caso el Y% me da igual, se deben tratar los mecanismos que causan el error de forma transversal y corregirlo de raiz, siempre respetando las reglas del proyecto y la limpieza de la arquitectura hexagonal y DDD, respetando los dominios, las fuentes de verdad y la reparticion de responsabilidades".
- **L2** Evidence: read-only review of runs `mvxa8pvu` and `mvxbr8hz` (sha ed28973) classified the untaken arms as A not drivable on web DEV, B app defect (`activeMenuCuisineType`), C test gap, D measurement artifact; only C is closable by a test. Mechanisms M1-M5 above generalise; proportions do not and are not a design input.
- **L3** Sequencing: T1-T4 touch `select-mutants.ts`/objective-signal (persistent branch) and the lead-correction contract (B branch); they start after both merges.
