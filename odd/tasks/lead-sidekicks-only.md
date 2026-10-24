Objective: make lead + sidekicks the only authoring path: fix what lost its work on R7, give the lead the whole change, make its decisions observable, then remove `single` and re-measure R7.
Branch: fix/failure-observation-conflict (single branch). Delivery: work-unit commits, no PR split. Runner: `node --import ./test-setup.mjs --import tsx --test <file>`, gate `npm run typecheck && npm run arch:check && npm run contract:check && npm test`.

## Specs

- S1 (point 1) A sidekick's files are taken back on evidence, not on its own status: a changed in-scope spec in its workspace is collected whatever status (or unreadable envelope) the sidekick reports; the static gate, execution and review judge it. The lead may not drop a flow whose spec the run_spec ledger shows ran.
- S2 (point 2) The static-fix loop keeps repairing while the run has delivered specs and rounds remain, not only while the last correction returned specs. A deterministic `eslint --fix` pass over the delivered specs runs before an agent repair round, through the sandbox launcher; an agent round is spent only for errors it leaves.
- S3 (point 3) The lead sees the whole change: a diff file the prompt cap leaves out is shown as a one-line digest (path, added/removed lines) instead of a bare name; broad diffs capture more live-DOM routes (bounded, tier-scaled); the plan turn is told the change-relevant routes the orchestrator derived and asked to account for each with a flow or a reason.
- S4 (telemetry) The plan, each review action per flow (with reason, refused/admitted), each sidekick turn's status and take-back, and the coverage decision (status, changed lines, mapped files, reason such as `no-source-map`) are span events; each static-gate check carries its first rule/file/line; agent turns are attributable to their phase; the per-spawn `scrubEnv dropped` line stops flooding the log; the orchestrator never classifies turns from a stale baked copy of agents/opencode.json.
- S5 "elimina el modo single": lead-sidekicks is the only coordination mode; `single` disappears from config, API, CLI, campaign and docs (the run still downgrades to the lead authoring alone when a plan is not admitted or sidekicks cannot author).
- S6 "relanza R7": re-run R7 (7a3e64fa..8442cd4e) in a fresh campaign id, freeze on, and compare with r7-steps5x-20261024.

## Tasks

- T0 commit step limits x5 (agents/opencode.json) — S6 prerequisite — inline — done 584afc14
- T1 S1 — inline — done c37f6157
- T2 S2 — inline — done 646753ca
- T3 S3 — inline — done db489e27
- T4 S4 — inline — done a57efbe2 (agent turns were already children of their phase span: verified on the R7 trace)
- T5 S5 — delegated (context backstop: ~60 files after one compaction) — done (see git log; Risk item 3: config/API contract)
- T6 S6 — inline — pending

## Log

- L1 (2026-10-24) "Sí: arregla primero el flujo de lead + sidekicks (puntos 1-3 y la telemetría), luego elimina el modo single y relanza R7." Earlier: "si se debe quitar el modo single, la unica fuente de trabajo es lead + sidekick, asi se simplifica el codigo y se elimina complejidad innecesaria. Respecto al lint, no entiendo el error, por que pasa un lint que no puede corregir? esto se debe arreglar."
- L2 Evidence (runs run-8442cd4-mvmulhz3-7eb60499 single pass 1 spec; run-8442cd4-mvmuxex5-99b5ae76 lead-sidekicks invalid): correction edit discarded on `needs-lead` (lead-sidekicks.ts:436); static-fix loop stops when the correction returns no specs (execute.steps.ts:127); home flow lost to an unreadable DelegationResult three times then dropped; diff cap 50k alphabetical (prompt-cap.ts:13), MAX_ROUTES 4 (dom-snapshot.ts:138); coverage never measured for this app (no source maps); decisive facts only in data/coordination-events.jsonl.
- L3 (2026-10-24) T1-T4 committed; full suite 10568 pass, 5 known failures (all roles on one model). Sidekick turns stated no step limit and were classified against the orchestrator's baked opencode.json (60): now against the server's last listed cap.
- L4 (2026-10-24) T5: `single` was an early return in coordinateFirstPass; removed with its config/API/CLI/campaign surface. `qa.coordination.mode: single` now fails config load; `coordinationMode` is gone from the contract (unknown body fields are ignored). gateSignals.coordination.mode kept as a string. Explorer grounding is now off for every e2e run unless the run asks (what lead-sidekicks apps already had). Gate: 10559 pass, 5 known failures.
