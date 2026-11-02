# ADR-0028: RFC-0020's answers (the second runtime's five forks) and the layering rule that governs them

- **Status:** Accepted, 2026-11-01, owner; the layering rule is his, the five answers are the recommended options of [RFC-0020](../rfc/0020-second-agent-runtime-beside-opencode.md) taken on his instruction
- **Decision source:** the owner, 2026-11-01 (translated from Spanish): "Apply the recommendations of Q1-Q5. The code must couple only to the implementations in the infrastructure layers; the other layers are agnostic to the runtime the agent uses." (original: "aplica las recomendaciones de q1-q5. el codigo solo debe acoplarse a las implementaciones en las capas de infraestructura, las otras capas son agnosticas al runtime que usa el agente"), under the scope of [ADR-0027](0027-agent-runtime-choice-is-a-setting.md).
- **Code references at a56d9a64**
- **Related:** [RFC-0020](../rfc/0020-second-agent-runtime-beside-opencode.md), [ADR-0027](0027-agent-runtime-choice-is-a-setting.md), [ADR-0001](0001-design-pillars.md) (P2, P7), [ADR-0002](0002-architecture-direction.md), `docs/engine-platform-architecture.md` (the placement rule)

## Context

RFC-0020 proposed a second agent runtime and closed with five open forks, each with a recommended answer and, where it applied, an alternative. The owner answered all five by taking the recommendations, and stated the rule the implementation is judged by: only the infrastructure layers couple to a runtime implementation; every other layer is agnostic to which one runs the agent.

That rule is not satisfied today, and the inventory below is part of this decision because it is the work the rule creates.

## Decision

Every recommended answer of RFC-0020 is taken as written, one row per question:

| # | Question | Decision |
|---|---|---|
| Q1 | The scope of the choice | One runtime for the process, read where the assignments are built (`platform/agent-runtime/config.ts:46`), not a provider per tier. A per-tier choice is a later widening of the same code. |
| Q2 | The second runtime's authentication | The stored subscription login, under the runtime's own home directory. No API key is required, and a key present in the child's environment never outranks a stored login: it is stripped by name before the turn starts. The API-key mode is a later setting if an operator asks for it. |
| Q3 | The roles that write | The runtime's read-only sandbox for the roles that do not write, and its documented escape for externally sandboxed environments for the roles that do. The agents container is that environment and it stays unprivileged; granting it the capabilities the runtime's own sandbox needs is refused. |
| Q4 | The role-to-tool roster | One neutral roster is the single owner of which tools a role may call. Both renderings read it: the existing runtime's tool map is asserted against it, and the tool server advertises a role's tools from it. |
| Q5 | The console's live activity | Absent for a run on the second runtime in the first step. The run record, its turns and its tool calls carry the facts; a streaming surface is not added. |
| Q6 | The layering rule (the owner's words, not an RFC fork) | Only the infrastructure layers — `platform/agent-runtime/`, `platform/persistence/`, `platform/telemetry/`, `agents/` and each context's `infrastructure/` — couple to a runtime implementation. The engine's domain and application layers, and the platform's control plane, name no runtime. |

## The consequence the layering rule has today

The code does not satisfy Q6 yet. The couplings, each with its site:

| Site | What couples | The task it becomes |
|---|---|---|
| `platform/composition/run-engine-factory.ts:1097`, `:1121`, `:1136` | Whether a role's runtime can call a granted custom tool is decided by comparing the provider's name to one runtime's. | Deleted, not abstracted: with both runtimes able to call a granted tool the comparison has no false case left. |
| `engine/src/contexts/coordination/application/lead-sidekicks.ts:339`, `:420`, `:1308` | The application layer reads `settings.flowBudgetMs.opencode`: a budget keyed by the runtime's name. | One flow budget per app, not one per runtime; the per-runtime map is removed from the app config (`engine/src/contexts/app-catalog/application/app-config.schema.ts:358-360`) with the operators' advice, in its own commit (Risk item 3: a config format others consume). |
| `platform/entrypoints/onboarding/onboarding-job.ts:144-146`, `:460` | Onboarding is gated on one runtime's provider key and on that runtime's agent being configured on its server. | The gate asks the runtime facade whether the role that proposes can run, and reports the runtime's own reason. |
| `platform/entrypoints/api/handlers/agent.ts:61`, `platform/entrypoints/contract/openapi.ts:460` | The provider is named in an API error message and in the OpenAPI parameter's enum. | The message names the values the contract accepts; the enum is the contract's, regenerated from `AgentProviderSchema`. |
| `platform/entrypoints/api/use-cases/ask.ts:6`, `platform/entrypoints/api/handlers/system.ts:6`, `platform/composition/cli.ts:38`, `platform/composition/wire-app.ts:48` | The control plane imports one runtime's raw client for the assistant, the session count and the deps. | Those reads go through the facade the platform already owns (`AgentFacade`), never through a runtime's transport module. |
| `engine/src/contexts/agent-tools/domain/submission.ts:12`, `engine/src/contexts/agent-tools/infrastructure/closed-loop-registry.ts:27` | The domain and an adapter say "OpenCode message id" and "the OpenCode agent name". | Vocabulary only, no behaviour: the identifiers are the runtime's transport's, so the comments say "the runtime's". |

RFC-0020's status becomes Accepted. Nothing in RFC-0020's options changes; the record keeps them as they were.

## Assumptions taken (not the owner's words)

1. **The layering rule names `platform/composition/` as allowed to couple.** It is the composition root (placement rule row 8) and its function is to build the adapters; the rule's "infrastructure layers" is read to include it. Its coupling must still be wiring, not a policy: the row above that decides a capability by name is in it, and it is deleted.
2. **A config format others consume changes in its own commit**, with the advice an operator reads when the old key appears (the schema refuses an unknown key and names the replacement), and one architecture row updated with it.
3. **The second runtime is not selected until Q6's tasks land.** A setting that offers a runtime whose non-infrastructure layers still name the other one would move the duplication instead of removing it.

## Consequences

- The runtime's work is ordered by the rule: the layering tasks first, then the runtime, then the roster and the tool server, then the contract, the console and the client.
- One app-config key is removed (`qa.coordination.flowBudgetMs.opencode`), replaced by one number; the schema refuses the map with the advice, and the two test files that pin the refusal move with it.
- The onboarding gate stops depending on a key name, so an operator who authenticates the second runtime with a stored login can onboard.
- A run still records which runtime produced it (`primaryProvider` / `reviewerProvider`), and a campaign never pools two runtimes.

## Enforcement

`engine/test/arch/` gains a rule for the layering: a runtime's name appears in `engine/src` only under a context's `infrastructure/`, and in `platform/` only under `agent-runtime/`, `persistence/`, `telemetry/`, `composition/` and the generated contract; the test's exception list starts at the six sites above and may only shrink. The rest is held by the tests RFC-0020's plan names, each added by the commit that lands it, plus `npm run arch:check`, `npm run contract:check`, `npm run settings:check` and `npm run previous-forms:check`.

## Alternatives considered

See RFC-0020, "Options". The forks' alternatives are recorded there and are not reopened by this ADR.
