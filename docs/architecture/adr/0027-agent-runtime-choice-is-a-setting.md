# ADR-0027: The agent runtime is a setting, and the removed mode machinery stays retired

- **Status:** Accepted, 2026-11-01, owner; the design's open forks are RFC-0020's questions, not this acceptance
- **Decision source:** the owner, 2026-11-01 (translated from Spanish): "Write the RFCs and ADRs this implementation needs. It must adhere to the existing hexagonal architecture and DDD, to fit well as a new consumer and not duplicate logic or responsibilities. For now the dual mode that was removed is not re-implemented, only the option to choose between opencode or codex to run qayaba." (original: "deja escrito los RFC y ADR necesarios relacionados con esta implementacion. debe adherirse a la arquitectura hexagonal y DDD que existe, para acoplarse bien como un nuevo consumidor y no duplicar logica ni responsabilidades. Por ahora no se re implementa el modo dual que se borro, solo la opcion de elegir entre opencode o codex para ejecutar qayaba"). In the same conversation the owner stated the goal behind the second runtime: to run it on a monthly subscription rather than an API key (translated: "what I want is to be able to use it with my monthly subscription, not the client with API_KEY").
- **Code references at a56d9a64**
- **Related:** [RFC-0020](../rfc/0020-second-agent-runtime-beside-opencode.md), [ADR-0001](0001-design-pillars.md) (P2, P7), [ADR-0002](0002-architecture-direction.md), [RFC-0018](../rfc/0018-agent-answers-are-submissions.md), `docs/architecture-remediation.md` (P1.5, the owner's decision of 2026-10-25)

## Context

The engine reaches every agent through one port with one method (`engine/src/shared-kernel/ports/agent-runtime.port.ts:100`), and the platform resolves a role to a runtime through `RoleAssignment.provider` (`engine/src/shared-kernel/agent-role.ts:9`), which `AgentRuntimeFacade` dispatches on (`platform/agent-runtime/facades.ts:44`). The port was kept on purpose when the second runtime was removed: the owner's decision of 2026-10-25 removed it and every piece of the mode machinery around it, and kept the port "so other agents can be added later" (`docs/architecture-remediation.md:481`).

What that decision removed must not come back with the runtime: a mode variable that selected the runtimes the process ran, a provider per role read from the environment, and auto-selection by which provider key happened to be set. The owner now asks for the choice back, and for it to fit the existing layering without a second owner of anything.

## Decision

1. **A second agent runtime is selectable by configuration.** `AgentProvider` gains the second member; the choice is a setting read where the assignments are built (`platform/agent-runtime/config.ts:46`), not a mode of the process, not an environment variable per role, and not a decision taken by looking at which credential is present.
2. **The removed mode machinery stays retired.** No mode selector, no per-role provider variables, no auto-selection, no per-runtime budget key. This list is named in RFC-0020, "What stays retired", and each item is a thing a later change must not reintroduce by habit.
3. **The acceptance criterion for the design is the owner's, verbatim: hexagonal, DDD, a new consumer, no duplicated logic or responsibility.** Concretely: one port, one facade, one submit registry, one declaration of each tool's arguments, one roster of which role may call which tool, and the process spawn kept in the agents container behind the platform's HTTP edge, where `no-child-process-outside-launchers` requires it (`engine/.dependency-cruiser.cjs:98-102`).
4. **Nothing in the engine changes.** The token, gate, coverage, grader and learning layers are untouched; the runtime appears in a run only through the port and in its record as `primaryProvider` / `reviewerProvider` (`platform/agent-runtime/usage.ts:36`).
5. **The answers do not fork.** Both runtimes deliver a turn's answer through the submit tools judged inside the turn ([RFC-0018](../rfc/0018-agent-answers-are-submissions.md)); no runtime's answer text is read for a verdict.

## Not decided here

RFC-0020 Q1 to Q5 are open and are not part of this acceptance: the scope of the choice (one runtime per process, or one per tier), the authentication mode the second runtime offers, the sandbox setting of the roles that write, whether the role-to-tool roster becomes a neutral file, and whether the console shows live activity for a run on the second runtime.

## Assumptions taken (not the owner's words)

1. **"Codex" is the OpenAI Codex CLI**, the runtime the removed strategy drove, not a generic name for another provider. If the owner means a different client, this ADR and RFC-0020 are superseded.
2. **The subscription is an authentication mode, not a separate runtime.** The owner's stated goal is to run the second runtime on a subscription; that is one of RFC-0020 Q2's options, and choosing the API key instead does not contradict the rest of this decision.
3. **The choice is configuration, and the first step exposes it as one setting.** The owner's words read that way ("choose between opencode or codex to run qayaba"); a provider per tier is a later widening of the same code.

## Consequences

- The wire gains the second member (`platform/entrypoints/contract/commands.ts:432`) and `openapi.json`, `packages/sdk` and the Go client's types are regenerated in the same change.
- Configuration status stops being a key map: a stored subscription login has no API key to test, so the strategy's `health()`, which already reports `needs_config`, becomes the authority (`platform/agent-runtime/config.ts:25`).
- `RunUsage.complete` stops meaning "every role runs the first runtime" and starts meaning "every role that ran reported a snapshot"; a run on a subscription reports tokens and no cost, because a zero cost is never invented.
- Two runtimes are never pooled in one campaign: the provider names on the run are the field that separates them.
- The gate rule that bans the removed runtime's name (`scripts/check-previous-forms.ts:54`) is retired by the change that lands the runtime, and `platform/settings/compose-parity.test.ts:21` moves the removed key out of its assigned-but-unread list if the API-key path returns.
- The invariant list in `AGENTS.md` that states one runtime is current fact changes in the commit that lands the second one, not before.

## Enforcement

- `platform/agent-runtime/config.test.ts` and `strategies.test.ts`: the configured runtime reaches every assignment, an unknown value is refused, and each role opens on the strategy its assignment names.
- `platform/agent-tool-surface.test.ts`: one roster, both renderings, no drift.
- `npm run arch:check` (`no-child-process-outside-launchers`, the platform boundary), `npm run contract:check`, `npm run settings:check`, `npm run submit-contracts:check`, `npm run previous-forms:check`.
- The new strategy's own test and the agents image smoke named in RFC-0020's test plan, both added by the change.

## Alternatives considered

RFC-0020, "Options": a provider per tier now (B), a per-run override (C), no second runtime (D), and restoring the removed mode machinery (E). Each is rejected there with its reason; this ADR records only the scope the owner settled.
