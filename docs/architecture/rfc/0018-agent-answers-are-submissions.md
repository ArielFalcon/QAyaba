# RFC-0018: An agent's answer is a validated submission, not text that ends in JSON

- **Status:** Accepted, 2026-11-01, owner ("Me parece bien ahora sí, aplicalo así"). Amends [RFC-0006](./0006-review-answer-crosses-whole.md) and the `AGENTS.md` invariants "Agent output is read through one scanner", "An agent's answer crosses whole" and "Contract repair" for every contract this RFC moves.
- **Code references at e7adef68** (the base of this change).
- **Implementation:** the feature document `odd/tasks/structured-agent-answers.md`.
- **Related:** [ADR-0001](../adr/0001-design-pillars.md) (P1 determinism with flexibility, P2 the engine/AI boundary by rules, P3 no fixed retry counts, P7 justified complexity), [RFC-0006](./0006-review-answer-crosses-whole.md), [RFC-0010](./0010-tool-call-record-outcome.md) (a tool call is a recorded outcome).

## Summary

1. Two runs (`run-2de1f7a-mvxdnd8j-c82fafc3`, `run-2de1f7a-mvxds0hp-f7addd2a`) ended `infra-error E-NO-AUTHOR (plan-rejected:no-plan)`: the lead's plan JSON lost its final `}` twice (finish `stop`, about 1.1k output tokens). The re-ask said only "the answer did not end with a plan JSON object" and the lead resent the same bytes. The owner rejected a fix that only improves that message: it "cubre el caso hipotético que falló ahora solamente, no previene que se corte el json ni que se deforme la respuesta ni que se aborte sin reintentar por una respuesta mal estructurada."
2. The cause is the channel: every role writes its contract as prose ending in a JSON object that the engine finds afterwards (`closingJsonObject`). A cut, a lost brace or a malformed field is discovered when the turn is over, by a reader that can say only that it did not find an answer, and the plan turn has no repair. An output-length cut is thrown as `AgentUnavailableError` and the turn dies.
3. Decision: each contract is delivered by calling a submit tool with typed arguments. The orchestrator judges the submission against the contract inside the same turn and returns the errors (path and reason), so the model corrects while it still holds the context. The first accepted submission is the answer. A turn that ends without one is a typed end, gets exactly one continuation in the same session restricted to the submit tool, and only then fails closed with its reason recorded.
4. One source of truth: the contract's owning context judges the submission with the reader it already has (the same function admits the answer later), and the tool's argument schema is generated from the context's wire schema. The free-text scanner is retired for every contract moved; no contract keeps two live answer channels.

## Feasibility (verified before design)

Evidence labels: **confirmed** (read in the pinned packages or the repository), **documented** (OpenCode documentation, not run here), **not verified** (needs the image).

| # | Question | Finding | Source |
|---|---|---|---|
| F1 | Typed arguments for a custom tool | **Confirmed.** `tool({ description, args, execute })` takes a zod raw shape (`tool.schema` is zod 4); a tool file's export is named `<file>_<export>`. | `agents/node_modules/@opencode-ai/plugin/dist/tool.d.ts`, `tool.js` (plugin 1.16.0, zod 4.1.8); [OpenCode custom tools](https://opencode.ai/docs/custom-tools) (context7 `/anomalyco/opencode`, `custom-tools.mdx`); precedent `agents/tool/codegraph.ts` (`codegraph_explore`) |
| F2 | What the model receives when a tool's `execute` fails, or when its arguments do not fit the schema | **Documented** for the current OpenCode line: a throw or rejection from `execute` goes back to the model as an error result; invalid input never executes the tool and is a model-visible error. **Not verified** on 1.17.7. The design therefore relies on neither: the submit tool returns its answer as a normal result, as `run_spec` already does (`{ ok: false, code, message }` as text). | context7 `/anomalyco/opencode` (`packages/ai/README.md`, `specs/v2/tools.md`); `agents/lib/codegraph-client.mjs` |
| F3 | Can a turn be required to end with a tool call | **No in the client this repository uses.** The v1 SDK's prompt body (`SessionPromptData.body`) has `agent`, `model`, `system`, `tools`, `parts`: no tool choice. The v2 SDK adds `format: { type: "json_schema", schema, retryCount }` (a `StructuredOutput` tool the runtime forces, `StructuredOutputError` after `retryCount` failed validations, default 2). It validates JSON Schema only, its retry text is the runtime's and not the contract's, the client here is v1, and whether the 1.17.7 server accepts `format` from a v1 client is not verified. The design does not use it: **the engine detects the missing call** (an accepted submission is state the orchestrator holds; absence is a typed end). | `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` (v1 `SessionPromptData`), `dist/v2/gen/types.gen.d.ts` (`OutputFormatJsonSchema`, `StructuredOutputError`); [SDK structured output](https://opencode.ai/docs/sdk) |
| F4 | Per-prompt tool control | **Confirmed.** `openCodePromptBody` already sends a `tools` map per prompt (`NO_TOOLS`, `NO_WRITE_TOOLS`, `authbrowser*`, `codegraph*` hidden for a session the run did not grant, `denyTools`). A trailing wildcard key is the precedent (`authbrowser*`). Order-dependent allow-after-deny maps are not relied on: a prompt hides the other submit tools by name, and the restricted continuation lists every other tool by name. | `platform/agent-runtime/opencode-client.ts` (`openCodePromptBody`, `NO_TOOLS`); [permissions](https://opencode.ai/docs/permissions) (keys are wildcard patterns over tool names) |
| F5 | Output-length cut | **Confirmed.** The assistant message carries `MessageOutputLengthError`; `agentErrorToInfra` turned it into `AgentUnavailableError` and the turn died. It is now a subclass (`AgentOutputLengthError`), still an infrastructure fault for every caller that did not ask for a submission, and a typed end for one that did. | `agent-transport-policy.ts` (`agentErrorToInfra`) |
| F6 | The tool listener's bounds | **Confirmed.** `QA_TOOLS_TOKEN` bearer, per-session call limiter, an 8 KiB body cap that fits a path and a filter and not an answer. The submit path has its own cap (256 KiB); every other path keeps 8 KiB. | `platform/entrypoints/tools-endpoint.ts` |
| F7 | Reading the image | **Not verifiable here.** The pinned OpenCode (`agents/Dockerfile` `OPENCODE_VERSION=1.17.7`) and the plugin (`agents/package.json` 1.16.0) did not move. A tool file was added, so `agents/smoke/submit-tool.smoke.mjs` must be run in the new image by whoever has docker, as the three existing smokes are. | `agents/Dockerfile`, `agents/AGENTS.md` |

## Problem

The lead's plan turn is the weakest instance, not the only one. Every reader of an agent's answer (the lead's plan, review, correction and amendment turns, the sidekick's result, the reviewer's verdict, the generator's verdict, the proposer's profiles) calls `closingJsonObject` on the finished text and then checks the object against its contract. Three failures follow from that order, and no wording of the re-ask removes them:

1. **The error is found after the turn.** A missing brace, a field of the wrong type, a duplicate flow id are all discovered when the model has stopped. The repair is a second prompt whose text can name only what the reader could say.
2. **The channel can be cut.** A cut answer is not text with a different shape: the object never closes, and the only signal is that no object was found. The plan turn has no repair at all.
3. **The turn can be killed by the cut.** `MessageOutputLengthError` became `AgentUnavailableError`, which every caller treats as infrastructure.

RFC-0006 closed the engine-side losses (defaults standing in for fields, tolerances reading unreadable entries as silence) and left the channel as it was.

## Options

- **O0. Better re-ask text.** Rejected by the owner (the quote under Summary): it covers the case that failed and prevents none of the three.
- **O1. Use the runtime's structured output (`format: json_schema`).** Not chosen: F3 (client version, JSON Schema only, the runtime's retry text, unverified on this server) and it cannot carry the contracts' semantic checks (a flow named twice, a flow that is not under review).
- **O2. Submit tools validated by the contract inside the turn (chosen).**

## Design

**The tool.** `agents/tool/submit.ts` exports one tool per contract: `submit_plan`, `submit_flow_review`, `submit_corrections`, `submit_result`, `submit_specs`, `submit_review`, `submit_profiles`. Each tool's arguments are the contract's typed fields. The tool forwards `{ sessionID, agent, tool, answer }` to `POST /internal/submit` on the tools listener (`agents/lib/submit-client.mjs`, like `codegraph-client.mjs`) and returns the orchestrator's answer as text.

**Where the schema lives.** The owning context declares the contract's wire schema (zod) beside the reader it already has (`coordination/application/*.contract.ts`, `generation/domain/verdict-schemas.ts`, `service-topology`). The wire schema fixes the types only; the bounds, trims and tolerances stay where the readers have them, so an answer the reader admitted before is still admitted (differential check, below). `npm run submit-contracts:gen` renders each wire schema to JSON Schema in `agents/tool/submit-contracts.json`; the tool builds its zod arguments from that file, and `npm run submit-contracts:check` fails when the file is stale (the same arrangement as `settings:check`). A test derives each role's expected submit tools from the same table.

**The check.** A `SubmissionContract<T>` is `{ tool, check(answer) }` (`shared-kernel/submission.ts`). `check` is the context's own reader run on the object: it returns the value, or the errors as `{ path, reason }`. The same function later admits the answer, so there is no second reading rule. Reasons are redacted and bounded by the registry before the model reads them.

**Arming.** `AgentRuntimeAdapter` arms the session for one prompt (`SubmissionRegistry.arm(sessionId, agent, contract)`) when the prompt carries `submit`, and closes the slot when the prompt ends. The endpoint finds the contract by session id; a session no prompt armed, another role, another contract's tool and a call after an accepted answer are refused. The first accepted submission is the answer. A submission writes nothing and runs nothing: it validates a value and keeps it in memory for the prompt that armed it.

**The typed end and the continuation.** `submitTurn` (`shared-kernel/submit-turn.ts`) is the one place a caller asks for a submission. A turn that ends without an accepted one (the model stopped, or `AgentOutputLengthError`) is not an error: it gets exactly one more prompt in the same session with only the submit tool available and the last rejection's errors in its text, under the same limits (`timeoutMs`, `timeLimit`, `stepLimit`) so the run deadline's runtime decides what time the purpose is allotted; a continuation the allotment cannot hold is reported `continuationTimedOut`. There is no retry count: the number of corrections inside a turn is bounded by the turn's time and steps, and the continuation by the allotment (P3). `describeNoSubmission` words the reason the fail-closed path records.

**What the callers do with a miss.** The existing fail-closed paths stay and take the reason: the plan is `plan-rejected:no-plan` with the submission's reason on the lead decision; a review the lead did not deliver keeps every flow as it is; a sidekick without a result is `failed` with the answer-miss class `unreadable`; a reviewer without a verdict is the existing parse miss; a generator without a verdict is `no-verdict`.

**What happens to the text scanner.** `closingJsonObject` is removed with its last consumer (stored-history reading has none: the history stores the turn's text, not parsed objects). The `Contract repair` turn, the "unreadable entries asked once" turns of RFC-0006 and the prompt sections that asked for them are removed for the contracts that moved: the in-turn errors and the continuation replace them. RFC-0006's rule that an answer crosses whole stays: it is now enforced where the model can still fix it.

## Authority

- The tools are in the roster of the roles that deliver the contract and no other: `qa-lead` holds `submit_plan`, `submit_flow_review` and `submit_corrections`; `qa-author` holds `submit_result` and `submit_specs`; `qa-reviewer` holds `submit_review`; `qa-proposer` holds `submit_profiles`; `qa-assistant` holds none. `agent-tool-surface.test.ts` pins each role's resolved tools.
- A prompt shows its session only the submit tool of the contract it armed and hides every other; a prompt that armed none hides all of them (`submit_*`). The continuation lists every other tool by name as denied.
- The lead stays read-only: a submit tool writes no file and runs nothing.
- The endpoint serves a submit call only for an armed session, behind `QA_TOOLS_TOKEN`, under the per-session call limit. With a generated (mismatched) token no registry is handed to the engine and a prompt that asks for a submission fails loudly naming the variable.
- A submission is untrusted input: bounded at 256 KiB by the listener, judged by a context reader that redacts and bounds every free string it keeps, and its errors are redacted and cut before they return to the model.

## Differential check

For each moved contract, a test runs the reader on a set of valid answers that the previous reader admitted and compares the admitted value with the previous reader's, taken from the base commit in a scratch directory. The result is in the feature document.

## Risks and limits

- **QA_TOOLS_TOKEN is now required for every run that asks an agent for an answer.** Before, a mismatched token cost the run the tools of `run_spec` and the browser and nothing else. The failure is loud and early (the first submitting prompt throws with the variable's name).
- **A model that does not call the tool.** The continuation and the typed end bound the cost; whether a given model follows a tool contract better than a free-text one is measured by the campaigns, not assumed.
- **Not verified in the image:** F2 and the exact text the model reads for an invalid call (`agents/smoke/submit-tool.smoke.mjs`).

## Owner decisions needed

1. Whether the roles not yet moved at the time of this change stay on the scanner until their own commit (the feature document lists which contracts each commit moved) or the change waits for all of them.
2. Whether `QA_TOOLS_TOKEN` becoming mandatory for every run is acceptable, or a generated token should degrade to the scanner (two live channels, which this RFC does not recommend).
