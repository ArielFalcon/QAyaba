# RFC-0020: A second agent runtime, chosen by configuration, beside OpenCode

- **Status:** Accepted, 2026-11-01: [ADR-0028](../adr/0028-rfc-0020-answers.md) decides Q1 to Q5, under the scope [ADR-0027](../adr/0027-agent-runtime-choice-is-a-setting.md) records. The options below are kept as they were.
- **Implementation:** the feature document `odd/tasks/second-agent-runtime.md` (S1-S14, T1-T10, the found state and the commit slices).
- **Code references at a56d9a64.**
- **Related:** [ADR-0001](../adr/0001-design-pillars.md) (P2, the engine/AI boundary by rules; P7, justified complexity), [ADR-0002](../adr/0002-architecture-direction.md), [RFC-0018](./0018-agent-answers-are-submissions.md), [ADR-0023](../adr/0023-owner-decisions-rfc-0015.md), [ADR-0025](../adr/0025-delivered-specs-do-not-intercept-requests.md), [ADR-0027](../adr/0027-agent-runtime-choice-is-a-setting.md), `docs/architecture-remediation.md` (P1.5, the owner's decision of 2026-10-25).

## Summary

1. The engine already sees an agent runtime through one port with one method (`engine/src/shared-kernel/ports/agent-runtime.port.ts:100`), and the platform already dispatches a role to a strategy by `RoleAssignment.provider` (`platform/agent-runtime/facades.ts:44`). A second runtime is the case the port was kept for.
2. This RFC makes the OpenAI Codex CLI a second member of `AgentProvider`, chosen by configuration, with no new port, facade, prompt builder, verdict, gate or grader.
3. The new code is one strategy and one HTTP client in the platform's provider edge, the process spawn in the agents container's supervisor, one MCP server that reuses the tool clients already runtime-neutral, and one roster that both runtimes render their tool grants from.
4. The answers a role delivers do not change: both runtimes deliver them through the submit tools of [RFC-0018](./0018-agent-answers-are-submissions.md).

## Problem

The runtime and the model are one decision today, and only the model is configurable.

- `AgentProvider` has one member (`engine/src/shared-kernel/agent-role.ts:7`), the list of known runtimes has one entry (`platform/agent-runtime/types.ts:12`), `configFromEnv` builds every assignment with the literal `"opencode"` (`platform/agent-runtime/config.ts:46`), and the wire accepts one value (`platform/entrypoints/contract/commands.ts:432`).
- So an operator can change `AGENT_<TIER>_MODEL` but cannot change which agent loop spends the run's turns. Everything downstream of the loop — how a turn is bounded, how a fault is classified, which tools the model is shown — is reachable only by changing code.

What the code already separates, and why this is small:

- The run flow never names a runtime: every prompt goes through `AgentRuntimePort`, whose only method is `openSession(role, cwd, opts)`.
- `RoleAssignment` is already `{ provider, model }` per tier (`engine/src/shared-kernel/agent-role.ts:9`), and the facade already opens the session on `strategies[assignment.provider]` (`platform/agent-runtime/facades.ts:44`).
- The reviewer-independence derivation already compares providers (`platform/agent-runtime/config.ts:56`), so a cross-runtime review is a distinct judgment for free.
- The tool clients under `agents/lib/` are plain HTTP against the orchestrator's internal listener: nothing in them is OpenCode's. The only OpenCode-specific layer is the registration file (`agents/tool/submit.ts:2`, `@opencode-ai/plugin`).
- The agent's write capability already comes from the role, in the kernel (`engine/src/shared-kernel/agent-role.ts:21`).

What this problem is not: it is not a defect, and the mode machinery removed on 2026-10-25 (`docs/architecture-remediation.md:481`) is not needed to close it. That decision removed a selector nobody read and an auto-selection by key presence; a second runtime needs neither, because the assignment is the selector.

## Goals and non-goals

Goals:

1. A run's agents can execute on either runtime, chosen by configuration, without a code change and without a second run path.
2. The tool surface, the argument schemas and the answer contracts keep one owner each.
3. The process spawn stays in the agents container, behind the platform's HTTP edge, as the sandbox invariants require.
4. A stored subscription login is an accepted way to authenticate the second runtime, beside an API key.
5. A run records which runtime produced it, so two runtimes are never pooled in one measurement.

Non-goals:

1. No mode variable, no per-role provider environment variables, no auto-selection by which key is present (see "What stays retired").
2. No second `AgentRuntimePort`, facade, prompt assembler, step-limit reader, submit registry or verdict.
3. No change to models, prompt text, gates, graders or the run's time budget.
4. No new runtime beyond the second one; a third is the same shape again.

## Options

- **A. One member of `AgentProvider`, one strategy, one client, one setting that picks the runtime for the process (recommended).** The choice is read once, `configFromEnv` stops hardcoding `"opencode"`, and every assignment it builds carries the chosen provider. It removes the hardcoded literal and adds no selector: the setting feeds the argument `providerConfig(provider, ...)` already takes (`platform/agent-runtime/config.ts:34`).
- **B. A provider per tier.** `RoleAssignment` already allows it and the facade already dispatches per assignment, so it is a small widening of the same code. Not recommended for the first step: it multiplies the validation surface (each tier's model must exist on its provider), the step-limit and context-window reads, and the operator's mental model, and no requirement asks for two runtimes in one run.
- **C. A per-run override on the API and the CLI** (`--runtime codex`). Not recommended: it is a second selector beside the assignment, so the same run could be asked for two runtimes by two truths. If a per-run choice is ever wanted, the right shape is a writer that sets the assignment for that run, not a new field the run flow reads.
- **D. No second runtime: point the existing one at another provider.** It changes the model and nothing else: the loop, the tool delivery, the fault classes and the turn accounting stay OpenCode's. It also does not reach a subscription login, because the existing runtime's provider credentials are API keys. Rejected by the owner's goal (ADR-0027).
- **E. Restore the removed mode machinery** (a mode variable, a provider per role from the environment, auto-selection by key presence). Rejected: two of the three are what the owner's decision removed, and the third reproduces a selector the assignment already is.

## Recommendation

Option A, for four reasons:

1. **It is the smallest change that removes the constraint.** The hardcode is one call site (`platform/agent-runtime/config.ts:46`); the dispatch, the port, the role table and the model resolution already exist and are tested.
2. **It keeps the engine untouched.** No engine file changes. That is the test of whether the seam was real, and it was: `AgentRuntimePort` has one method and takes a role, a directory and limits.
3. **It puts each new piece where the placement rule puts it** (see the table in "Design"): the decision "which runtime serves this role" is already the platform's provider edge, the spawn is the agents container's, the tool declarations are the agents container's.
4. **It is app-agnostic and model-agnostic.** Nothing names an app, a model or a provider's quirks outside the runtime's own strategy and the operator's settings.

## Design

### The choice

One setting names the runtime (`AGENT_PROVIDER`), typed as `AgentProvider`, defaulting to the value every deployment uses today. `configFromEnv` passes it to `providerConfig`, which is already the only place an assignment is built. The API keeps its existing runtime-config surface: `applyConfig` writes models today, and the provider is read from the same config object, so the console's Agent Runtime view can set it without a new endpoint.

Two consequences the wire and the operator see:

- `AgentProviderSchema` gains the second member (`platform/entrypoints/contract/commands.ts:432`); `openapi.json`, `packages/sdk` and the Go client's types are regenerated in the same change (`npm run contract:check`).
- A configured value the contract does not know is refused at load, as any unknown setting value is, never defaulted.

### The seam that does not move

`AgentRuntimePort` (`engine/src/shared-kernel/ports/agent-runtime.port.ts:100`) and every consumer of it stay as they are: the generation adapter, the deadline wrapper, the round wrapper, the sidekick executor, the reviewer adapter. `AgentRuntimeStrategy` (`platform/agent-runtime/types.ts:55`) is the contract a runtime implements, and it already marks as optional what a runtime may not have: `stepLimits`, `modelWindows`, `startEventStream`, `cleanupOrphans`, `restart`, `dispose`. This RFC fills those absences with statements of absence, never with invented numbers:

- `stepLimits`: absent. The second runtime enforces no step cap it can report. The prompt's step-limit section is therefore omitted for a run on it, and no turn of its roles ends `E-STEP-BUDGET`. The bound that remains is the run's deadline, which `RunDeadlineRuntime` already applies to every turn.
- `modelWindows`: absent. The strategy makes no statement, so the window fit degrades nothing for it. The second runtime compacts its own context; the run does not claim a window it was not told.
- `startEventStream`: absent in the first step (RFC-0020 Q5).

### The platform's provider edge

Two new modules, both HTTP-only:

- `platform/agent-runtime/codex-client.ts`: the raw transport. It posts a turn to the agents container's supervisor and reads its JSONL answer; it creates nothing, and it holds no process. It must not import `child_process`: `no-child-process-outside-launchers` covers `platform/` (`engine/.dependency-cruiser.cjs:98-102`), and the rule is right here — the orchestrator never spawns an agent.
- `platform/agent-runtime/codex-strategy.ts`: `AgentRuntimeStrategy`. `health()` asks the supervisor whether the binary and a login are present and reports `needs_config` otherwise; `listModels()` reads the roster the server lists, as the existing strategy reads its own; `openSession(role, cwd, opts)` returns a session whose `prompt` posts one turn with the role, the model, the directory, the time limit and the submission arming, and whose `dispose` releases it.

What the strategy must carry per turn, and where it comes from:

| Fact | Source |
|---|---|
| The role's prompt | the same `agents/agent/<name>.md` the other runtime uses, composed by the supervisor |
| The role's model | `modelForRole` (`platform/agent-runtime/types.ts:150`), unchanged |
| Whether the role may write | `capabilitiesForRole` (`engine/src/shared-kernel/agent-role.ts:21`), unchanged |
| The turn's time limit | the options the port already passes, `timeoutMs` and `timeLimit` |
| The submission arming | the same `submit` option of `AgentPromptOpts` |
| Which tools the role may call | the roster (below) |

### The agents container

The spawn is the agents container's, as it is today for the runtime server: `agents/agent-supervisor.mjs` gains a turn route that runs one `codex exec` per prompt and answers with the turn's facts. The supervisor owns:

1. **The environment.** The child gets an allowlisted environment, and — the rule the last incident taught — **no API key when a stored login exists**. A provider API key in the child's environment silently outranks the login and bills the wrong path; the strip is by name, `CODEX_API_KEY` and `OPENAI_API_KEY`, and it is a pure function with a unit test.
2. **The configuration.** `$CODEX_HOME/config.toml` holds the MCP server entry (below) and is rewritten when it drifts. It is not the watched repo's: the second runtime reads no project configuration file for its own behaviour, and the repo's `AGENTS.md` stays prompt text, the same trust class as the source the agent reads.
3. **The sandbox.** A role that does not write runs with the runtime's read-only sandbox. A role that writes cannot: the runtime's own sandbox needs a Linux user namespace the agents container does not have, and the container is already the sandbox (unprivileged, egress-filtered, its file boundary proven at boot). The write roles therefore run with the runtime's documented escape for externally sandboxed environments, recorded as a decision in RFC-0020 Q3 and as an invariant with a test. Granting the container the capabilities its in-container sandbox needs is the alternative, and it adds real privilege instead of removing a redundant layer.
4. **The turn's facts.** The turn's token usage, the tool calls it made and how it ended are read from the JSONL answer and reported through the same `AgentTurnEvent` every prompt of every runtime records.

One setting belongs to this container only: the home directory of the second runtime. It is set by compose, never by the orchestrator, which does not read it.

### The tools: one declaration, one server, two renderings

This is where duplication would appear if the change were careless, and where it must not.

Today the tool surface has one owner per concern: `agents/tool/*.ts` declare each tool's arguments and its logic call, `agents/lib/*-client.mjs` hold the calls, and `agents/opencode.json` grants or denies a tool per agent, pinned by `platform/agent-tool-surface.test.ts`. The second runtime needs the same tools as MCP tools, so three things must stay single-owner:

1. **The argument schema.** A submit tool's schema is already one artifact, `agents/lib/submit-contracts.json`, rendered from the wire schemas by `npm run submit-contracts:gen`; the OpenCode side converts it to the runtime's schema shape (`agents/lib/submit-schema.mjs`). An MCP tool takes JSON Schema directly, so the same artifact is passed through, not re-declared. The four other tool families (`run_spec`, `authbrowser_*`, `codegraph_explore`, `set_geolocation`) move their argument declarations into one module both renderings read, so there is one declaration and no second copy.
2. **The call.** Unchanged: one MCP server module in `agents/mcp/` wraps `agents/lib/*-client.mjs`, exactly as the plugin files do. The orchestrator's listener, its token, its per-session binding and its refusals do not change.
3. **Who may call what.** One roster: a small file declaring, per role, the tools the role may call. The OpenCode roster is asserted against it (the tool-surface test derives the resolved rules and fails on drift); the MCP server advertises exactly its role's tools, launched per turn with the role in its environment.

The per-turn role is what makes the MCP shape safe: the server is started for one turn, so it advertises one role's tools, and the session identity it sends to the orchestrator is the one the supervisor gave it — never one the model can name. That is stricter than the current path, where the tool reads a session id from the runtime's tool context.

The answer contract is the last thing that must not fork. A Codex turn delivers its answer by calling the same `submit_*` tool name, with the same arguments, judged by the same reader inside the turn, with the same single continuation ([RFC-0018](./0018-agent-answers-are-submissions.md)). No text is read for a verdict on either runtime.

### Usage, cost and attribution

- The strategy reports a turn's tokens. It reports no money: a run on a subscription bills no per-token price, and a zero is never invented (`platform/agent-runtime/usage.ts:35`).
- `UsageSnapshot.cost` becomes optional and `RunUsage.cost` is present only when a snapshot carried one, so a mixed run states what it knows and nothing else.
- `RunUsage.complete` stops meaning "every role is the first runtime" and starts meaning "every role that ran reported a snapshot".
- `primaryProvider` and `reviewerProvider` are already recorded per role; they become the field that tells two runs apart, and the reviewer-independence warning already reads the provider (`platform/agent-runtime/config.ts:67`).

### What stays retired

Named, so that a future change does not reintroduce them by habit:

1. A mode variable that selects which runtimes the process runs. Two strategies are registered; the assignment picks one.
2. `AGENT_SINGLE_PROVIDER` and the `AGENT_<TIER>_PROVIDER` variables. The provider is one setting, not three.
3. Auto-selection by which provider key happens to be present. A missing configuration is an error the operator sees, never a silent switch of runtime.
4. A per-runtime budget key in an app config. One run's time budget does not depend on which runtime serves it.
5. A second facade, a second port, a second submit registry, a second prompt assembler, a second step-limit reader.
6. Any read of the model's answer text for a verdict, a plan or a result.

### Gates and records that move

- `scripts/check-previous-forms.ts:54` bans the second runtime's name outright. The change that lands this RFC retires that rule, because the name becomes live code again; until then this record and ADR-0027 cite it under the records exemption, like every other retired name a record quotes.
- `platform/settings/compose-parity.test.ts:21` lists the removed runtime's key among the variables the example assigns although nothing reads. If the API-key path returns beside the stored login, that entry moves with it.
- The invariant list in `AGENTS.md` that says the first runtime is the only one, and the paragraph that says a second runtime is added as a strategy, are updated by the same change.

## Patches it supersedes

Nothing is removed by this RFC. One gate rule is retired by the change that lands it (`scripts/check-previous-forms.ts:54`, the banned name), and two documentation statements (`AGENTS.md`, "The agent and its prompts": one runtime today) are rewritten.

## Test plan

Every test is through a public seam, and each guards a rule this design states.

1. **Configuration.** `platform/agent-runtime/config.test.ts`: a configured runtime reaches every assignment; an unknown value is refused; a subscription-authenticated runtime is configured without an API key, and a key-authenticated one without a key is refused. `keyPresence` must stop being the authority for configuration: a stored login has no key.
2. **Dispatch.** `platform/agent-runtime/strategies.test.ts` and `role-session-routing.test.ts`: a role opens on the strategy its assignment names, and a facade with two strategies reads each one's limits only for the roles it runs.
3. **The strategy.** A new test beside the existing strategy test: a role that writes gets the escape sandbox and a role that does not gets the read-only one; a failed turn is classified as the integration error class the run already handles; a turn that states no step limit leaves the role absent from `stepLimits`.
4. **The environment.** A pure-function test: with a stored login present, neither key name reaches the child; without one, a key does.
5. **The tool surface.** `platform/agent-tool-surface.test.ts` derives each role's resolved tools from the one roster and fails when either rendering drifts from it.
6. **The parameter schemas.** `npm run submit-contracts:check`, and a test that the MCP server advertises, for each role, exactly the tools the roster grants.
7. **Usage.** A mixed run records both provider names, tokens for both, and a cost only when one was reported.
8. **The contract.** `npm run contract:check` regenerates the wire, the SDK and the Go types; a run's record names its runtime.
9. **The image.** A smoke beside the four existing ones: the agent binary turns one prompt into one recorded turn with the tool server attached, without spending a real turn.
10. **The gates.** `npm run arch:check` (no spawn outside the launcher, no `platform/` import of a context's internals), `npm run previous-forms:check`, `npm run settings:check`.

## Measurement

The signal that the change is worth having is the run's own graders, not a public index: `mutation_kill_rate`, `change_coverage_ratio`, `branch_coverage_ratio`, `defect_found`, `survivors_routed` and `review_verdict`, read per runtime and never pooled (`gateSignals.usage.primaryProvider` is the field that separates them).

A campaign over one app and one case set, one arm per runtime, answers it. The public capability index is a prior, not a measurement: it scores general engineering tasks, and this engine is scored by whether its suite kills mutants and covers the change.

Two operator-facing facts belong in the record because they bound the experiment:

- A subscription plan's usage is a rolling window shared with the operator's other use of the same account, while a run spends dozens of turns. A plan whose window cannot hold one run ends runs as provider faults (`infra-error`), and that verdict is correct: the runtime was unavailable, not the change.
- A stored login is a rotating credential. Two consumers of the same account — a laptop and a container — invalidate each other, so the account used by the pipeline is used by the pipeline alone.

## Owner decisions needed

- **Q1. The choice's scope: one runtime for the process (recommended) or a provider per tier?** One setting, read where assignments are built, is the smallest change and the only one the owner's words name ("choose between opencode or codex to run qayaba"). A per-tier choice is a later widening of the same code, not a different design.
- **Q2. Authentication: the stored subscription login (recommended, the owner's stated goal), an API key, or both offered with the login as the default?** Both is the same code path plus a setting; the login alone is the smallest surface, and the provider documents the API key as the general recommendation for automation.
- **Q3. The write roles' sandbox: the runtime's documented escape for externally sandboxed environments (recommended), or privileges granted to the agents container so the runtime's own sandbox can start?** The first removes a redundant layer; the second adds real privilege.
- **Q4. The role-to-tool roster: one neutral file both renderings read (recommended), or the existing OpenCode roster as the source with the other runtime reading it?** The neutral file costs one test and stops a provider's config from owning a fact of every runtime.
- **Q5. The console's live activity for a run on the second runtime: absent in the first step (recommended), or a stream from the supervisor?** The run record, its turns and its tool calls carry the facts either way; the live tail is operator comfort and a second streaming surface to keep.

## Out of scope

- A third runtime. The same shape applies, and a third name makes the abstraction falsifiable; it is not part of this change.
- Mixing runtimes inside one run (option B) beyond what the type already allows.
- Per-turn model escalation, a per-runtime step cap the runtime does not enforce, and a cost model for a subscription-billed turn.
- Any change to the run's time budget, to the deploy gate, to the coverage gates or to a grader.
- Validation of the public capability index against this engine's own cases; that is the campaign's job.
