# Structured agent answers

Objective: every agent role delivers its contract by calling a submit tool whose submission the orchestrator validates inside the same turn, and a turn that ends without an accepted submission is a typed end that gets one continuation, never a lost answer.
Branch: `worktree-agent-a15277ccb6ad0d93e`. Delivery: ask-on-risk (single branch, no PR split). Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24). Record: RFC-0018.

## Specs

- **S1** (problem, owner, verbatim): "es lo más superficial posible y cubre el caso hipotético que falló ahora solamente, no previene que se corte el json ni que se deforme la respuesta ni que se aborte sin reintentar por una respuesta mal estructurada."
- **S2** (approval, owner, verbatim): "Me parece bien ahora sí, aplicalo así"
- **S3** (approved design 1): each role delivers its answer by calling a submit tool (`submit_plan`, `submit_review`, `submit_result`, ... one per contract, named by what it submits) with typed arguments, following the existing custom-tool precedent (`agents/tool/run_spec.ts`, `authbrowser.ts`, `codegraph.ts`, `../lib/*-client.mjs`, the orchestrator's internal tools listener `platform/entrypoints/tools-endpoint.ts`, bound per session by a registry like `ClosedLoopRegistry`/`CodeGraphToolRegistry`).
- **S4** (approved design 2): validation happens inside the same turn: the orchestrator validates the submission against the domain contract and the tool returns the exact errors (path + reason) so the model corrects within the turn; an accepted submission is the answer. No brace guessing, no second reading rule.
- **S5** (approved design 3): a turn that ends (stop, output-length, or otherwise) without an accepted submission is a typed end ("no submission", with the last rejection's errors), never `AgentUnavailableError`; it gets one continuation in the same session restricted to the submit tool with the exact errors, bounded by the time the run deadline allots to that purpose (no fixed retry count, pillar P3); only then does the existing fail-closed path apply, with its reason recorded.
- **S6** (approved design 4): one source of truth: each contract's schema lives in the domain of the context that owns the contract (reuse the existing readers' contract types/validators); the tool's argument schema, the validator and the tests derive from it. The free-text scanner stays only where still needed (e.g. reading stored history) or is retired; do not keep two live answer channels for the same contract.
- **S7** (approved design 5): governance: this changes the contract of every agent role, so it has its own RFC (RFC-0018) and amends the RFC-0006 and AGENTS.md rows in the same commits as the code that makes them true; the agent-authority and tool-surface change ships as its own commit.
- **S8** (security): a submit tool is served only for the session the transport bound to that role in a live run, behind `QA_TOOLS_TOKEN`, and writes and runs nothing; each role's `tools` and `permission` in `agents/opencode.json` grant it its own submit tools only (pinned by `agent-tool-surface.test.ts`); the read-only lead stays read-only.
- **S9** (bounds): a submission is untrusted input: redacted then bounded, its errors bounded, its size capped.
- **S10** (tests, each through a public seam): a malformed submission returns path-level errors and the corrected one is accepted in the same turn; an output-length end without a submission gets the one continuation and is typed; no submission after the continuation fails closed with its reason; each role's tool is refused for any other role or session; the plan of the observed case (a plan missing its last brace) can no longer cause `E-NO-AUTHOR` without a continuation; the readers' behavior for valid answers is unchanged (differential check against a base copy).

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S5, S6, S7 | inline | done: RFC-0018 with the feasibility findings | 9468f86e |
| T2 | S3, S4, S5, S9 | inline | done: submission mechanism: kernel types and continuation helper, registry, endpoint, adapter, transport tool maps | 1c897622 |
| T3 | S3, S6, S8 | inline | done in two commits: the generated argument schemas, the converter and the client (3367aaea); then the authority commit: the submit tool file, roster grants, per-prompt tool map, role prompts, pins, smoke script | pending-sha |
| T4 | S4, S5, S10 | inline | done: the lead's plan, its re-ask and its amendment | aab944c4 |
| T5 | S4, S5, S10 | inline | done: the lead's review of the flows and its corrections | be92092d |
| T6 | S4, S5, S10 | inline | done: the sidekick's result | efa8ea6b |
| T7 | S4, S5, S10 | inline | done: the reviewer's verdict and the generator's verdict; contract repair retired | 4e9aa0aa |
| T8 | S4, S5, S10 | inline | done: the proposer's profiles; the closing-JSON scanner deleted (no consumer left) | 6a44bf48 |
| T9 | S6, S7 | inline | AGENTS.md, RFC-0006, docs and RFC-0018 as-built rows (the scanner itself went with T8) | pending |

Route declaration: every task inline. No Writer-trigger reason holds (the units share the submission mechanism and its files, so none is independent); the mapping needed more than one batch and was done inline by the parent before any write.

## Log

- **L1** (2026-11-01, owner, verbatim, two messages): "es lo más superficial posible y cubre el caso hipotético que falló ahora solamente, no previene que se corte el json ni que se deforme la respuesta ni que se aborte sin reintentar por una respuesta mal estructurada." and "Me parece bien ahora sí, aplicalo así"
- **L2** (2026-11-01, task brief): runs `run-2de1f7a-mvxdnd8j-c82fafc3` and `run-2de1f7a-mvxds0hp-f7addd2a` ended `infra-error E-NO-AUTHOR (plan-rejected:no-plan)`: the lead's plan JSON lost its final `}` twice (finish=stop, about 1.1k output tokens, 552 KB prompt); the re-ask said only "did not end with a plan JSON object" and the lead resent the same bytes; the plan turn has no repair; an output-length cut is turned into `AgentUnavailableError` (`agent-transport-policy.ts`, `agentErrorToInfra`) and the turn dies.
