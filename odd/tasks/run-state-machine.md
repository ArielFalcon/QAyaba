# Run state machine

Objective: break `RunQaUseCase.execute` (~2440 lines) into an explicit state machine (typed RunState, RunContext with the run's live services, one function per phase, a declarative step table, a small runner) without changing behavior. No checkpoint/resume yet.
Branch: `feat/regeneration-session-continuation` (worktree `regen-session`). Delivery: work-unit commits on this branch (owner rule: single branch). Test runner: `node --import ./test-setup.mjs --import tsx --test` under Node v24.11.0; full gate `npm run typecheck && npm run arch:check && npm run sdk:typecheck && npm run contract:check && npm test`.

## Specs

- S1. The user's request, verbatim: "lo que me parece bueno es implementar la maquina de estados aunque no se use el retry por ahora. para dejar mas organizado y declarativo el codigo, romper esa funcion de 4000 lineas en flujos mas organizados."
- S2. Accepted design (assistant proposal, approved with "Sí, empieza el refactor con ese diseño en esta rama"):
  1. `RunState` with one section per phase output; each phase writes its own section and reads earlier ones (fields several phases rewrite live in one documented shared section).
  2. `RunContext`, separate from the state: deps, config, trail, signal and the run's live services (proof ledger, regeneration acceptance, confinement totals, handles), so the state can later be checkpointed without live objects or secrets.
  3. Each phase is a function `(state, ctx) → { update } | { end: RunQaResult }`; the closures that capture locals become module functions that take `ctx`.
  4. A linear step table with skip conditions, not a general graph; loops (static fix, fix loop, review rounds) stay inside their phase.
  5. A small runner that walks the table, enters the phase cursor, applies the update or returns the end. `runHandlingEnds` and the `finally` of `runInScope` stay as they are.
- S3. Behavior-preserving: public surface unchanged (`RunQaUseCase.run`, `RunQaUseCaseDeps`, `RunQaInput`, `RunQaResult`, `RunQaConfig`); `RunOutcome` shape unchanged (seam-parity); every existing test passes unmodified except tests that pin internal line numbers.
- S4. One phase (or one coherent group) per commit, top to bottom (strangler: the not-yet-extracted remainder stays inline in `execute` and shrinks each commit); every commit leaves the full gate green.
- S5. `scripts/mutate.ts` `carry-forward` line ranges point at the code they mean after the move (they had already drifted before this work).

## Tasks

| ID | Specs | Scope (F = run-qa.use-case.ts lines at baseline 2dac84fa) | Route | Status | Commit |
|---|---|---|---|---|---|
| T1 | S2-S4 | runner, RunState/RunContext, run services (workspace closures F:909-1086), steps gate, workspace, classify, index (F:874-1140) | inline | done (gate green: 10402 pass / 0 fail) | 7b785189 |
| T2 | S2-S4 | setup (F:1141-1335) | delegated (context backstop) | done (gate green: 10402 pass / 0 fail / 3 skipped) | this commit (git log -- odd/tasks/run-state-machine.md) |
| T3 | S2-S4 | ground (F:1339-1590) | delegated | pending | |
| T4 | S2-S4 | generate + pre-exec grounding (F:1592-1754) | delegated | pending | |
| T5 | S2-S4 | validate/static fix, health, pre-execute auth, execute (F:1763-1952) | delegated | pending | |
| T6 | S2-S4 | fix loop + suite fingerprint (F:1954-2236) | delegated | pending | |
| T7 | S2-S4 | coverage + enforce regen (F:2237-2333) | delegated | pending | |
| T8 | S2-S4 | review + stale-coverage re-measure (F:2334-2918) | delegated | pending | |
| T9 | S2-S4 | final proof guard, decide, coordination telemetry, publish, persist, learn, result (F:2925-3316); `execute` becomes runner-only | delegated | pending | |
| T10 | S5 | re-point mutate.ts carry-forward ranges | inline | pending | |

## Log

- L1 (2026-10-22, user): "lo que me parece bueno es implementar la maquina de estados aunque no se use el retry por ahora. para dejar mas organizado y declarativo el codigo, romper esa funcion de 4000 lineas en flujos mas organizados."
- L2 (2026-10-22, user): "Sí, empieza el refactor con ese diseño en esta rama"
- L3: Mapping (explorer): execute F:873-3316; 15 `trail.phases.enter` boundaries match RUN_PHASES; ~25 closures capture locals; 13 test files construct RunQaUseCase and all go through `run()`; seam-parity pins RunOutcome; mutate.ts carry-forward has 18 drifted ranges of F.
- L4: T1 done in 7b785189. Conventions: `application/run-flow/` holds run-flow.ts (runner), run-state.ts (RunState sections), run-context.ts (RunContext, WorkspaceRunContext, RunEnds bound to the use case), run-services.ts (live services), run-steps.ts (BEFORE_WORKSPACE, IN_WORKSPACE tables) and phases/*.steps.ts (step functions). execute() runs the tables, then rebinds state/services to their former local names for the not-yet-moved remainder. Each later task appends steps to IN_WORKSPACE and shrinks the remainder. RED for the runner was not observed separately (new module, tests written alongside); behavior-preservation is pinned by the existing 13 run-qa test files.
- L5: T2 done. New RunState section `setup: { suiteRestored, storeRestoredLogin, authSeedUnauthored }`; RunEnds gained prepareAuth, replaceRestoredLogin, announceSuite, announcePrecondition, preconditionNote and terminal (bound terminalResult). The live handles (geolocation, closedLoop, agentBrowser) stay on `trail`; the remainder rebinds them from it. The setup phase is five steps in phases/setup.steps.ts; the ground-phase prelude (diffArchetypes) before `phases.enter("ground")` stays in the remainder for T3.
