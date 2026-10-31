# Engine and platform: target layout and migration guide

The repository converges on two folders of code that run in the orchestrator container, `engine/` and `platform/`, plus
`agents/`, which runs in its own container. `engine/` decides everything about QA; `platform/` holds what belongs to the
process as a whole and connects the engine to the world. Every module now under `src/` either moves into the engine,
because it decides something or is owned by one context, or into the platform, because the whole process shares it.
This guide states the final architecture, the rule that places every module, and how to migrate without breaking the
gates. It does not list modules one by one: the inventory belongs to the feature document that executes the migration.

## Quick path

1. Read [The target in one picture](#the-target-in-one-picture) and the placement rule in [`AGENTS.md`](../AGENTS.md#placement-rule).
2. Classify a module with the decision table there before you move it.
3. Migrate in the [order below](#migration-order); each step leaves the full CI gate green.
4. The migration is done when the [completion checklist](#completion-checklist) holds.

## The target in one picture

```
orchestrator container                                        agents container
┌───────────────────────────────────────────────────────────┐ ┌──────────────────────────────┐
│ platform/   what the whole process shares                 │ │ agents/  the agent runtime:  │
│   composition/   builds every adapter, wires every context│ │   roster, prompts, tools,    │
│   entrypoints/   HTTP API, webhook, queue, CLI, contract  │ │   the supervisor             │
│   persistence/   the one database: schema, migrations,    │ │                              │
│                  repositories behind engine ports         │◄┼► HTTP only, both ways       │
│   telemetry/     the tracing SDK and its exporters        │ │                              │
│   agent-runtime/ the connection to the agent server       │ └──────────────────────────────┘
│   settings/      the one typed Settings object            │
│        │ depends on                                       │
│        ▼                                                  │
│ engine/     decides                                       │
│   contexts/<context>/{domain,application,infrastructure,  │
│                      composition}                         │
│   shared-kernel/          types and ports of 2+ contexts  │
│   shared-infrastructure/  adapters of 2+ contexts         │
└───────────────────────────────────────────────────────────┘
```

| Folder | One sentence | Today |
|---|---|---|
| `engine/` | Every rule, policy and decision of a QA run, each in the bounded context that owns it. | `qa-engine/` plus the business logic that leaked into `src/` |
| `platform/` | The resources one process owns once (database, tracing SDK, HTTP server, agent-server connection, settings) and the code that builds and starts the engine. | The rest of `src/` |
| `agents/` | The non-deterministic agent, in its own container, configured by data. | Unchanged |

The names carry the decision. `engine` is where things are decided; `platform` is what the engine runs on. A reader who
wonders where a piece of code belongs asks one question: *does it decide, or does it carry?*

## The dependency rule

```
platform  ──imports──►  engine        allowed, through public surfaces only
engine    ──imports──►  platform      forbidden, by construction
agents    ◄──HTTP────►  platform      no imports in either direction
```

- **The engine never imports the platform.** The engine declares a port ("store a run", "emit a span", "send a prompt");
  the platform implements it with SQLite, OpenTelemetry or the agent server and injects it. This keeps every context
  testable with fakes and lets a backend change without touching a rule. It is the rule `no-src-import-in-qa-engine`
  today and keeps its meaning under the new names.
- **The platform reaches a context only through its public surface**, `application/index.ts`, and its composition
  builders only from `platform/composition/`. These are `shell-public-surface` and `composition-only-from-shell-root`
  today.
- **The agents container shares no code with either.** It talks to the platform over HTTP: the agent server's API in
  one direction, the internal tools listener in the other.

Determinism is not the criterion. The platform is as deterministic as the engine; the line between them is ownership,
not behaviour.

## The placement rule

The placement rule and the decision table live in one place, [`AGENTS.md`](../AGENTS.md#placement-rule), so no second copy can drift. Classify a module with that table before you move it. The questions are asked in order, and a module that answers yes to more than one is split first.

## The engine: hexagonal DDD rules

The engine's rules already hold and are enforced; the migration only brings more code under them.

| Layer | Holds | May import |
|---|---|---|
| `domain/` | Entities, value objects, pure rules and services of the context | Its own domain and the shared kernel only |
| `application/` | Use cases, one port per file under `application/ports/`, the public surface `application/index.ts` | Its domain, its ports, other contexts' public surfaces, the shared kernel |
| `infrastructure/` | Adapters that implement this context's ports | Its own layers, shared infrastructure, other contexts' public surfaces |
| `composition/` | `build<Context>(deps)`: wires this context's adapters to its use cases | Everything of its own context; called only from `platform/composition/` |

Rules that matter during the migration:

- **A context is a language, not a folder per file.** Move logic into the context whose vocabulary it speaks. Create a
  new context only when the logic has its own language and none of the existing contexts owns it (operating the product,
  for example campaigns or self-maintenance, may qualify; a single helper never does). Name it by what it does, so the
  tree screams the domain.
- **The shared kernel is for what two or more contexts need.** A type with one owner lives in that context. The wire
  contract of the HTTP API is not kernel: the engine never reads it.
- **Ports are declared by the consumer.** When a policy moves from the platform into a use case, the use case declares
  the port it needs; the platform keeps (or gains) the adapter.
- **The engine reads no environment and knows no process.** Configuration reaches it as typed values through its
  composition builders.

## The platform: rules

| Subfolder | Holds | Must not hold |
|---|---|---|
| `composition/` | The one root that builds every adapter, calls every `build<Context>`, and starts the process (`main`) | Any policy: a branch that changes a run's outcome |
| `entrypoints/` | HTTP routes, the webhook, the queue, CLI commands (the CLI's parsing, `cli-args.ts`; `cli.ts`, which wires and starts the CLI's process, is a second process root in `composition/`, ADR-0022 row 3), the wire contract and its generated OpenAPI | Any decision beyond parsing, authorizing the caller, calling one public use case and mapping its result |
| `persistence/` | The one database: connection, schema, migrations, backup, retention, and the repositories that implement engine ports | Rules about what a record means |
| `telemetry/` | The tracing and metrics SDK, its exporters, its bootstrap; the adapter of the engine's `TelemetryPort` | Engine-specific span names chosen here instead of in the engine |
| `agent-runtime/` | The agent-server client and the provider-agnostic facade behind the engine's agent port | Prompt content, role behaviour |
| `settings/` | The settings registry, `loadSettings(env)`, the store; the only reader of the environment | Defaults that encode a QA policy the engine should own |

Why the repositories live in the platform and not in each context's `infrastructure/`: they are bound to the one
schema and the one connection, and a context may not import the platform. Each repository implements exactly one engine
port and is named after it; the schema stays one, owned by the platform.

Inside the platform, dependencies point toward `composition/`: `entrypoints/`, `persistence/`, `telemetry/` and
`agent-runtime/` do not import each other's internals; `composition/` assembles them.

## What stays where it is

| Path | Why |
|---|---|
| `agents/` | Another container and another trust level; what it produces is untrusted input to the platform. |
| `client/`, `web/`, `packages/sdk` | Consumers of the wire contract; only their generator's input path changes. |
| `config/` | User data and the e2e seed. |
| `scripts/` | Repository tooling (mutation, contract generation, gates). A script that is a product command an operator runs against a live stack is an entry point and moves to `platform/entrypoints/`. |
| `bin/` | Container boot steps and client launchers. |

## Migration order

Each step is a series of work-unit commits on the current branch. Every commit leaves the full CI gate green
(`AGENTS.md`, Commands).

### Step 0: Encode the target before moving code

- Add the placement rule and the decision table to `AGENTS.md` (repo map and boundary sections), so every change made
  during the migration already follows it.
- Write the inventory in the migration's feature document: every module of `src/` with its row of the decision table and
  its owning context. This guide gives the rule; the feature document gives the list.

### Step 1: Delete twins and dead code (rows 1 and 2)

Deleting first shrinks everything that follows. A twin's callers switch to the engine's copy; its parity test is deleted
with it, after the callers' own tests prove the behaviour holds.

### Step 2: Move decisions into the engine (row 3)

The step that matters most and the only one that changes code rather than paths.

- Start from a test through the engine's public seam that pins the current behaviour of the policy; it must pass before
  and after the move.
- Move the policy into the owning context's domain or application, declare the port it needs, and leave the platform
  with the adapter and the call.
- Each move shrinks `qa-engine/.dependency-cruiser-shell-exceptions.json` or leaves it as it was; it never grows.

### Step 3: Move context-owned adapters into the engine (rows 4 and 5)

An adapter that one context owns moves to its `infrastructure/`; one shared by several contexts with no process-wide
state moves to `shared-infrastructure/`. Its composition moves into the context's builder.

### Step 4: Shape what remains into the platform's subfolders

Inside `src/`, regroup the remaining modules into the target subfolders (`composition`, `entrypoints`, `persistence`,
`telemetry`, `agent-runtime`, `settings`), splitting the flat server folder by role. Paths change, behaviour does not.

### Step 5: Rename the roots

Two mechanical commits, each alone: `src/` → `platform/`, then `qa-engine/` → `engine/`. Nothing else changes in them.

### Step 6: Tighten the gates

- The shell exceptions list is empty: delete the file and its loading code.
- Rename the dependency rules to the new vocabulary and add the platform's internal rule (subfolders meet only in
  `composition/`).
- Add the retired roots and folder names to the banned terms of `npm run previous-forms:check`, so no document or comment
  keeps describing the old layout.
- Update `AGENTS.md`'s repo map, boundary section and every doc that names a path.

Where step 6 stands (T13 U8, 2026-10-31): three platform rules hold, with probe tests in
`qa-engine/test/arch/shell-public-surface.test.ts`: no folder but `composition/` imports it
(`platform-composition-is-the-root`), `settings/` imports no other platform folder (`platform-settings-reads-no-other-folder`)
and no production module imports `src/test-support/` (`platform-production-imports-no-test-support`); the composition root may
import a context's infrastructure (`composition-builds-adapters-from-infrastructure`). The shell exceptions list holds 27
entries: the 11 `scripts/` entries, 13 tests of `agent-runtime/`, `persistence/` and `telemetry/` that drive engine adapters, the
agent transport (`src/agent-runtime/opencode-client.ts`), the tools endpoint's test and the composition root's mirror prune
(`wire-app.ts`, ADR-0021's note). Not done: the rule between `entrypoints/`, `persistence/`, `telemetry/` and `agent-runtime/`
(their imports of the loggers, the sanitizer, the stored run shapes and the history; ADR-0022 row 7 leaves open whether those
stay shared leaves or become injected ports), the rule renames and the banned old roots (they follow the root renames of
step 5).

## Rules for every migration commit

| Rule | Why |
|---|---|
| A commit either moves files or changes code, never both. | Git detects a pure move as a rename, so `git log --follow` and blame survive, and a reviewer reads the change without the noise of the move. |
| A move updates every consumer of the path in the same commit. | A half-updated path breaks a gate silently or loudly. See the list below. |
| Tests move with their module and keep testing through the public seam. | A moved test that starts importing an internal file breaks `cross-context-internals` and the testing standards. |
| Governance-sensitive files move in a commit of their own. | Security invariants ship alone (`AGENTS.md`, Invariants): the file-boundary check, the sandbox and egress, the API token, credentials handling. |
| The test count does not drop, and no assertion changes in a move commit. | A pure move proves itself by the same suite passing unchanged. |
| A move that would need an exception in the rules is not a move: classify the module again. | The exceptions list only shrinks. |

Consumers of a path to update with every move:

- TypeScript project files and their path aliases.
- `qa-engine/.dependency-cruiser.cjs` rule regexes and the shell exceptions list.
- Mutation presets (`scripts/mutate.ts`) and their file anchors.
- `scripts/previous-forms.allow.json`.
- The Dockerfiles and `docker-compose.yml` (copies, entrypoint, commands).
- `package.json` scripts, including the settings and contract generators and their output paths.
- Seam-parity and architecture tests that list paths or read `git ls-files` (stage the move first).
- `AGENTS.md`, `docs/`, and the prompts or skills that cite a path.

## Verification

- Per commit: the full CI gate of `AGENTS.md`, plus `npm run arch:check` read for new violations, not only for its exit
  code.
- Per decision moved (step 2): the pinning test passes before the move and after it, unchanged.
- Per step: one live run against a test app on DEV (`npm run qa`) confirms the wired process still starts, runs and
  finalizes; a green suite does not prove the composition root.

## Completion checklist

- [ ] `src/` and `qa-engine/` no longer exist; `platform/`, `engine/` and `agents/` are the code roots.
- [ ] The shell exceptions list is gone and `npm run arch:check` passes with no exception.
- [ ] No module in `platform/` holds a decision about a run: every branch there parses, authorizes, wires, stores or
      transports.
- [ ] Every repository in `platform/persistence/` implements exactly one engine port.
- [ ] No parity test remains: every type, taxonomy and sanitizer has one copy, in the engine.
- [ ] `AGENTS.md` states the placement rule, and its repo map names the new roots.
- [ ] `npm run previous-forms:check` bans the old roots, and passes.

## Related

- [`architecture-remediation.md`](architecture-remediation.md): the review and phases this migration builds on (the
  hexagonal re-cut and the shell debt work it completes).
- [`testing-standards.md`](testing-standards.md): how to pin behaviour through a public seam before moving it.
