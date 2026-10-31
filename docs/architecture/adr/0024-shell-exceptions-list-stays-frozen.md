# ADR-0024: The shell exceptions list stays frozen at 27 and only shrinks (CP4 C-B2)

- **Status:** Accepted, 2026-10-31, under the owner's standing instructions (quoted below); the answer is the recommended one, chosen by the agent under them, not words of the owner on this question
- **Decision source:** the owner's standing instructions, recorded in `odd/tasks/root-cause-2026-10-28.md` (L4, L26) and [ADR-0015](0015-owner-decisions-2026-10-30.md) point 2:
  - 2026-10-28 (L4), verbatim: "Las decisiones pendientes no bloqueantes también resuelvelas con tus recomendaciones. Deja todo listo para empezar a implementar" (translated: "Also resolve the non-blocking pending decisions with your recommendations. Leave everything ready to start implementing").
  - 2026-10-30 (L26), verbatim: "No te detengas más a preguntarme" (translated: "Do not stop to ask me any more").
- **Code references at:** 3ee3235d
- **Related:** [ADR-0021](0021-owner-decisions-platform-step-3.md) (row 7: the list cannot reach zero by moves; U8 was to decide the rule that replaces it), [ADR-0022](0022-owner-decisions-platform-step-4.md) (row 13, row 14), [ADR-0002](0002-architecture-direction.md), `docs/engine-platform-architecture.md` (step 6, first bullet; the completion checklist), `engine/.dependency-cruiser-shell-exceptions.json`, `engine/test/arch/platform-public-surface.test.ts` (`SHELL_INFRASTRUCTURE_EXCEPTIONS_CEILING`)

**In one line:** step 6 of the migration plan said "the shell exceptions list is empty: delete the file and its loading code"; at 3ee3235d the list holds 27 entries and none of them can leave by a move or by a change no record asks for, so the list stays, frozen, and each group below leaves it when its own condition is met.

## Context

[ADR-0021](0021-owner-decisions-platform-step-3.md) row 7 measured that the list cannot reach zero by moves and left the rule that replaces it to U8 (T13, platform step 6). U8 (feature document L80) took 35 entries to 27 with the composition rule `composition-builds-adapters-from-infrastructure` (the composition root may import a context's infrastructure) and by moving one test into the composition it wires; it found no record that decides the rest. The migration plan's first step-6 bullet and its completion checklist still read as if the list ends empty, and the CP4 records review (C-B2) found that contradiction.

What is on the list at 3ee3235d, by what the entry imports (a context file that is neither `application/index.ts` nor a composition builder; checked against `platform-public-surface`):

| Group | Entries | What each imports and why it has no public surface |
|---|---|---|
| Scripts | 11: `agent-browser-smoke`, `baseline-agent`, `campaign`, `harness-auth`, `model-agnostic-prompts.test`, `onboard-app`, `prompt-contract-matrix`, `prompt-contract-matrix.sample.test`, `prompt-contract-matrix.test`, `sandbox-smoke`, `warm-suite` | Operator tooling and prompt lints that construct an adapter or render a prompt without a run: the e2e runner (`e2e-execution.runner`, three scripts), the agent-browser host and launcher, the auth-session and login-discovery adapters, the onboarding adapters and resolver factory, the suite store adapter, and the prompt builders and sections (`prompts`, `task-builders`, `review-render`, `generator-sections`) |
| Tests that drive engine adapters | 13: `agent-runtime/agents-prompts.test`, `agent-runtime/opencode-client.test`, `agent-runtime/role-session-routing.test`, `persistence/agent-efficiency-contract.test`, `persistence/spec-snapshot.test`, and the eight `telemetry/*-trace.test` and `evaluation-span-shapes.test` files | Each wires a real engine adapter (the prompt builders, the SSE and turn-trace modules of generation's transport, the span-emitting trace adapters of generation, coordination, objective-signal, test-execution and workspace-and-publication, the spec-snapshot validation adapter) to the platform's telemetry or store and asserts what comes out; no public surface exports an adapter |
| The agent transport | 1: `platform/agent-runtime/opencode-client.ts` | The OpenCode strategy builds prompts and reads the event stream with generation's own modules: nine imports of `generation/infrastructure` (the transport policy, the prompt builders, the SSE tracker and parser, the circuit breaker, the turn-trace registry) |
| The tools endpoint's test | 1: `platform/entrypoints/tools-endpoint.test.ts` | Binds the real agent-tools registries (closed loop, agent browser, geolocation, code graph); the endpoint itself declares its session lookups (53fce1b5) and imports none |
| The composition root's mirror prune | 1: `platform/composition/wire-app.ts` | Imports `workspace-and-publication/application/prune-mirrors` and `domain/active-repo-slugs`, which are neither the public index nor an adapter (ADR-0021's note: the index is a security allowlist surface and the prune rule deletes directories) |

## Decision

| # | Question | Answer | Why |
|---|---|---|---|
| 1 | Does step 6 empty the list? | No. The list stays, frozen: no entry is added, entries leave one at a time when the condition of their group (row 2) holds, and `SHELL_INFRASTRUCTURE_EXCEPTIONS_CEILING` is lowered in the commit that removes one (27 today; the arch test fails on an entry that no longer imports an infrastructure file and on growth past the ceiling). The plan's first step-6 bullet and its checklist item are corrected to say so | Emptying it needs a public surface that exports adapters, a prompt-building facade, or a change of what a test may import. Each of those widens a context's public surface, which `application-not-infrastructure` and `workspace-public-surface-carries-no-write-seam` forbid on purpose, or moves tests away from the folder they pin (ADR-0022 row 14), and no failure family is recorded that the list causes ([ADR-0001](0001-design-pillars.md) P7 asks for one before a restructure). A frozen list that only shrinks already stops new debt, which is what the plan wanted the empty list for |
| 2 | When does each group leave it? | See the table below | A condition per group makes the list's shrinking a task someone can pick up, not a hope |
| 3 | Does anything new join it? | Never. A new shell module or script that needs an engine adapter receives it injected as a port, goes through a context's builder, or lives in `platform/composition/` where the composition rule already allows infrastructure imports | `docs/engine-platform-architecture.md`, "Rules for every migration commit": a move that would need an exception is not a move; the arch test's ceiling makes growth a visible review event |
| 4 | Is the plan's checklist item "the shell exceptions list is gone" kept? | Replaced by "the list is frozen at its ceiling, every entry has a group and a removal condition (ADR-0024)", checked | The original item cannot be met by decision; leaving it unchecked would read as unfinished work nobody can finish |

Removal conditions (hypotheses about what works, none tried; each is a change of its own with the full gate):

| Group | Leaves when |
|---|---|
| The 11 scripts | The context exports the operation the script performs through `application/index.ts` (a facade for running a suite, for opening an agent-browser session, for rendering a prompt for a lint), or the script moves under `platform/composition/` (the composition rule allows infrastructure), or the script is deleted. Scripts leave one at a time; `baseline-agent` and `campaign` leave together with whatever facade runs a suite |
| The 13 tests | The span shape (or the prompt, or the snapshot validation) each pins is asserted in `engine/test/` through a recording `TelemetryPort` or the context's own seam, and the platform keeps only the test of what is platform's (the OpenTelemetry adapter); or the test moves into `platform/composition/` where it wires what it exercises, as the webhook routing test did (465aba79). Moving a test only to leave the list is not enough: it must still sit with the thing it pins (ADR-0022 row 14) |
| `opencode-client.ts` | Generation exposes the prompt assembly and the transport policy (circuit breaker, stall watchdog, turn tracing) through its public index, so the client keeps only HTTP and event-stream I/O. This is the largest entry (nine imports) and has no owner task yet |
| `tools-endpoint.test.ts` | The test binds fakes of the session lookups the endpoint declares, with the registries' own behaviour asserted in `engine/test/`; or it moves into `platform/composition/` |
| `wire-app.ts` | The prune is built by `workspace-and-publication`'s composition builder and handed to the root through the engine root (only `engine-root.ts` may import a builder), or a separately guarded public entry for destructive seams is created with its own rule and probe test. Neither is a move |

## Consequences

- `docs/engine-platform-architecture.md` step 6, its status paragraph and its completion checklist say the list is frozen at 27 with these groups; the first checklist item no longer claims the list is gone.
- `engine/test/arch/platform-public-surface.test.ts` points at this record next to the ceiling.
- Nothing in code changes: the list, the rule and the ceiling are as U8 left them (27).
- The group conditions are not scheduled. They become tasks when a record of their own picks one up (the first candidates are the scripts that need the e2e runner, which a facade for running a suite would remove together).
