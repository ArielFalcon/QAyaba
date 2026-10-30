# Time authorities at be6d70f7 (RFC-0012 appendix)

Read-only map, 2026-10-30 (an explorer over `qa-engine/src` and `src`, nothing run). `qa/` is `qa-engine/src/contexts/`, `k/` is `qa-engine/src/shared-kernel/`. Columns: where | what it bounds | who sets it | relation to the run deadline | what happens when it fires.

| # | Where | Bounds | Set by | Relation | When it fires |
|---|---|---|---|---|---|
| 1 | `qa/run-orchestration/domain/run-time-budget.ts:15-21` | the run from the end of classify | constants 25/40/60/45/60 min, `QA_RUN_TIME_BUDGET_MS_*` | is the deadline | `RunDeadlineExceededError` → `run-deadline`, E-TIME-BUDGET; `deadline-after-proof` after a proven suite |
| 2 | `qa/run-orchestration/domain/run-deadline.ts:36-42` | `allowance(purpose)` | — | ignores the purpose | — |
| 3 | `qa/run-orchestration/infrastructure/run-deadline-runtime.adapter.ts:44-52` | every agent turn | min(own, left), own = prompt ?? session ?? host cap | clamps | deadline error only when `left <= own` |
| 4 | `qa/generation/application/generate-tests.use-case.ts:207-217` | the run-level author's first pass | `DIFF_TIME_BUDGET_MS` 6/12/none, `QA_DIFF_TIME_BUDGET_MS_*` | min(tier, allowance) once at the start | `timeCut` `tier-budget` |
| 5 | `generator-time-budget.ts:61` | tier vs host cap | — | duplicates the host cap | tier dropped |
| 6 | `qa/generation/domain/repair-turn.ts:4,7`; `review-port.adapter.ts:187-191` | repair turns | 120 s | through #3 only | first answer stands |
| 7 | `k/wall-clock-budget.ts:30` | a regeneration's start | `wallClockBudgetMs` or 18 × the mode's agent timeout (90 min in diff) | a second clock | `regenerationAllowed` false, quietly |
| 8 | `src/orchestrator/schemas.ts:328-335` | comment | — | describes a check the code does not make | — |
| 9 | `qa/coordination/application/lead-sidekicks.ts:79-82` | `MIN_FLOW_MS` 60 s, `MIN_RESERVE_MS` 120 s, `RESERVE_SHARE` 0.25 | constants | derived from `remainingMs()` | `NO_TIME`, no re-ask |
| 10 | `lead-sidekicks.ts:1195-1219` | `leadTurnBudget` = min(planBudgetMs, room − 2 × MIN_FLOW) | derived | reads it | turn skipped |
| 11 | `lead-sidekicks.ts:795,821-827` | review turn, revised flows | min(planBudgetMs, room) | reads it at the turn's start | break, orders dropped |
| 12 | `k/coordination.ts:56-57`, `schemas.ts:320-324` | `planBudgetMs` 180 s, `flowBudgetMs` 480 s | constants, app config | independent | `plan-timed-out` |
| 13 | `qa/coordination/application/lead-plan.ts:292-296` | per-flow budget | min(flowBudgetMs, (left − reserve)/waves) | reads it | `NO_TIME` downgrade |
| 14 | `qa/coordination/application/flow-capacity.ts:31-34` | flow count | derived | reads it | zero flows |
| 15 | `qa/coordination/application/fan-out-dispatcher.ts:91-95` | per-flow timer | `flow.budgetMs` at admission | a separate timer | flow abort |
| 16 | `src/integrations/opencode-client.ts:478-485,698-701` | generator budget by mode, `agentPromptCapMs` | constants, `OPENCODE_TIMEOUT_MS` | host cap; also feeds #7 | `AgentTimeoutError` |
| 17 | `src/settings/defaults.ts:7`, `review-port.adapter.ts:109` | reviewer session 6 min | constant, env | clamped by #3 | agent timeout |
| 18 | `stall-watchdog.ts:37`, `src/settings/defaults.ts:9` | no activity 180 s | constant, env | independent (an activity detector) | `StalledAgentError`, session disposed |
| 19 | `agent-transport-policy.ts:172,636` | abort settle 10 s | constant | independent | dispose proceeds |
| 20 | `qa/test-execution/domain/run-spec-capability.ts:26,29,225` | one `run_spec` call | `perCallMs` 120 s (app config), `MIN_CALL_MS`, `CLEANUP_RESERVE_MS` | reads it at the call's start | `NO_TIME` refusal |
| 21 | `closed-loop-port.adapter.ts:40,84,194`, `agent-browser-port.adapter.ts:33,86` | tool leases | `left`, else 60 min | reads it | lease expires |
| 22 | `agent-browser.use-case.ts:164-165`, `k/agent-browser.ts:25`; `run-engine-factory.ts:286` | one browser call 30 s, lease wait 15 s; Chromium 3 h wrapper | constants | min(perCall, left) | refusal |
| 23 | `qa/test-execution/infrastructure/e2e-execution.runner.ts:33,47,277,316,1042` | a Playwright suite run, 900 s | `QA_E2E_TIMEOUT_MS` | ignores it | `ran:false`, untyped |
| 24 | `e2e-execution.runner.ts:35,887` | cleanup 300 s | constant | ignores it | — |
| 25 | `static-gate.checks.ts:17,125` | tsc, lint, list 300 s | constant | ignores it | infra check failure |
| 26 | `regeneration-acceptance.ts:140,214-218` | an acceptance's start | the deadline | reads it before starting only | deadline error, role acceptance |
| 27 | `fix-loop.aggregate.ts:533` | triage re-execution | remaining | reads it | `no-budget` |
| 28 | `run-dump-bridge.ts:30`, `coverage-dump-reader.ts:20` | dump check, decode 10 s | constants | independent | file left out |
| 29 | `setup.adapter.ts:23` | install 600 s | constant | ignores it | install error |
| 30 | `run-engine-factory.ts:1202` | auth setup 120 s | constant | ignores it | timed out |
| 31 | `dom-snapshot.ts:627-654` | DOM capture, up to 200 s | constants | ignores it | capture fails |
| 32 | `codegraph-engine.ts:42`, `codegraph-workspace.ts:24`, `git-co-change.adapter.ts:22` | graph build 270 s, query 20 s, git 120 s / 30 s | constants | after arming, not clamped | `EngineFailure` timeout |
| 33 | `run-engine-factory.ts:1277-1279`, `build-run-orchestration.ts:13` | deploy gate 60 s / 600 s | constants | before arming (by design) | `InfraError` |
| 34 | `src/server/run-delegate.ts:50` | CLI poll 30 min | constant | shorter than four budgets | `timedOut` |
| 35 | `src/server/wire-app.ts:339` | orphan-session TTL | longest run budget + 5 min | derived (the model) | cleanup |

Contradictions (one fires while the other believes time remains): A #23 vs #1 (an execution overshoots, the next turn fails before-turn); B #4 vs #2 (allowance not by purpose, tier snapshot, two typed ends); C #7 vs #1 (never binds by default, fires quietly when set); D #9-#11 vs #3 (the reserve is not enforced by the runtime); E #15 vs #3 (flow timer and runtime clamp race, two error kinds); F #20/#22 vs #23 (the same spec run under two deadline rules); G #18 vs #16 (a hung session stalls first, not retried against the time left); H #34 vs #1 (the CLI gives up on a live run); I #32 (the graph build overshoots a small remaining budget).
