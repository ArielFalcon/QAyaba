# run-signal-integrity

Objective: fix the structural causes found in campaign t7-broad-3c-2026-10-27 (green suites that catch nothing), transversally for any app.
Branch: main (owner rule: single branch, governance changes as own commits). Delivery: one commit per unit, merged from per-unit worktrees. Runner: `node --import ./test-setup.mjs --import tsx --test <file>` (Node v24), gate `npm test && npm run typecheck && npm run arch:check`.

## Specs

- S1 (F1) One canonical resolution of an agent-reported spec reference against the app's `specRelDir`, in the shared kernel, used by the review findings filter, the routing of verified review findings, and coordination's spec confinement. A reviewer citation `e2e/flows/x.spec.ts` (specRelDir `e2e`) and `flows/x.spec.ts` resolve to the same spec. A blocking finding dropped because its citation resolves to nothing of the run is recorded (count + reason on the review decision span) and the `approval_consistent` grader reports an accepted run whose model verdict rejected with blocking findings that were all dropped.
- S2 (F7) One shared reader of "the last JSON object in an agent's output that satisfies schema X". The sidekick DelegationResult reader uses it (narration containing `{name, value, url}` or an earlier unrelated JSON object no longer turns a valid closing block into `failed`). An unreadable answer is distinguishable from a sidekick that reported `failed` (its own reason/class in the coordination event and telemetry). A flow sidekick's prompt carries one closing contract only.
- S3 (F4) A candidate derived from a context-map link keeps the changed file(s) that linked it as seeds, so per-candidate coverage measures it and the coverage gap groups its lines under it. The lead's plan prompt shows each candidate's changed files and executable changed-line counts.
- S4 (F3) Coverage-gap findings that name a changed source file are owned by the flow whose cited candidates seed that file; a finding no flow owns whose file seeds a candidate the plan did not cover opens one flow for that candidate (within `maxFlows` and the time reserve), generalizing the maintenance flow. A lead drop reason claiming the candidate is cosmetic/style-only is refused by the orchestrator when the candidate has executable changed lines. The arm cap is spread across files/candidates and the number left out is stated.
- S5 (F2) A surviving bundle mutant on a line a delivered test executed becomes a correction finding carrying the spec that reached it, file:line and the mutation, routed through the existing correction path to that spec's flow. Signal only, never a gate.
- S6 (F5) A `flaky` run with green bytes is measured (change-coverage) and reviewed like a pass; publication stays `quarantine`. A flaky case whose first attempt read an empty/different data state (`failureResultCount`) is classified as DEV data instability and reaches the owning flow as a finding to stop depending on live data.
- S7 (F8) `network_class`/`network_error_count` count only requests the page depends on (same origin or app-declared origins; document/fetch/xhr/script); third-party beacons are counted separately and never classify a test as `egress`.
- S8 (F6) The run records a digest of the suite set restored from the suite store; `campaign-report` marks a replicate invalid when its restored digest differs from the campaign's first replicate; the campaign runner never enqueues a replicate before the previous one finished.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1 | delegated (parallel, worktree) | pending | |
| T2 | S2 | delegated (parallel, worktree) | pending | |
| T3 | S3 | delegated (parallel, worktree) | pending | |
| T4 | S4 | delegated (parallel, worktree) | pending | |
| T5 | S5 | delegated (parallel, worktree) | pending | |
| T6 | S6 | delegated (parallel, worktree) | pending | |
| T7 | S7 | delegated (parallel, worktree) | pending | |
| T8 | S8 | delegated (parallel, worktree) | pending | |

Route evidence: Writer trigger (a) — eight independent units with their own tests; overlapping files (coverage.steps.ts, lead-sidekicks.ts, maintenance-flow.ts) → isolated worktrees, parent merges.

## Log

- L1 (2026-10-27, user, verbatim): "Separa las tareas pendientes en unidades de trabajo lógicas y aplícalas en paralelo con agentes, si necesitas worktrees por cada uno hazlo"
- L2 (2026-10-27, user, verbatim, the constraint on every fix): "No debes priorizar parches que solucionen solo la manifestación actual del error sino identificar la causa estructural para que la solución sea válida para cualquier ejecución sobre otra app no solo para ese caso"
- L3 Evidence: runs run-ed28973-mvpw76qh/mvq9r6vy/mvqb6uob/mvqc7x8j/mvqd9fda; engram diag/t7-broad-3c, diag/t7-broad-3c-causes.
