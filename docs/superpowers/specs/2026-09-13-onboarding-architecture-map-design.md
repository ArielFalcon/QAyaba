# Onboarding architecture map (`e2e/.qa/context.json`)

**Date:** 2026-09-13
**Status:** Approved — implement
**Topic:** After boundary confirm (and after a no-profile propose), enqueue a `mode: context` QA run so the FE↔BE map lands in the app git via PR. The TUI stays on the propose screen through a new non-terminal `mapping` state.

## Problem

`context.json` is the durable FE↔BE map later runs read into `GroundingResult.contextMap`. It is **not** written during onboarding today. Onboarding only: provisions mirrors, proposes/scores `boundaries[]`, splices YAML, then optionally indexes into the `codebase-memory` volume.

The map is produced by a QA run (`--mode context`). The agent writes `e2e/.qa/context.json`; publish stages **only** that file. The next `git checkout -f` on the shared `mirrors` volume wipes any uncommitted copy.

Apps onboarded with `qa.shadow: true` never open that PR, so the map never survives. Operators must remember `npm run qa -- --mode context` after the wizard.

## Goal

Confirming a winning boundary profile (and finishing a no-profile propose on an e2e app) automatically enqueues one `mode: context` run through `enqueueTrackedRun`. The TUI keeps polling on the propose screen until that run is terminal. Failures never undo a written `boundaries[]` block. This onboarding run opens the `context.json` PR even when the app YAML has `qa.shadow: true`.

## Non-goals

- Generating the map inside the onboarding job (inline agent session). That fights the sequential QA queue and `isOnboardingActive`.
- Navigating the TUI to the live QA screen for this step.
- Persisting `context.json` in `qa-data` / Docker volumes.
- Forcing `shadow: false` on later spec/Issue publishes.
- Changing CLI `scripts/onboard-app.ts` (it does not use `OnboardingJob`; TUI/API `confirm()` is the shared path).
- Holding the onboarding `busy` mutex during the context run.

## Approach (A)

New non-terminal onboard state `mapping`, same screen-lifecycle as `indexing`.

1. Confirm writes YAML (unchanged).
2. If `indexRepo` is wired, run indexing with `busy` held (unchanged torn-index guard).
3. Release `busy`.
4. If the app is e2e (`code` is not true) and `enqueueContextRun` is wired, set `state: mapping` **before** any await that could let the TUI observe `done`, enqueue `{ mode: "context", target: "e2e", source: "manual", shadow: false }` at `git rev-parse HEAD` of the **primary** mirror, poll `getContextRun` until the record is `done`.
5. Transition to `done`. Outcome stays `winner` or `no-profile`. Mapping failure sets `error` as a warning; it never sets `failed`.

No-profile: there is no confirm. When propose finishes with `no-profile` and mapping is eligible, set `state: mapping` (outcome already `no-profile`) **before** `run()` returns, then map after `busy` is released. The TUI never sees a premature `done`.

## Sequencing and mutex

| Phase | `state` | `isActive()` / `busy` | `propose()` |
|---|---|---|---|
| propose / score / mirrors | resolvingMirrors / proposing / scoring | true | reject |
| indexing | indexing | true | reject (via busy) |
| mapping | mapping | **false** | **reject** (`state === mapping`) |
| done / failed | done / failed | false | accept |

`busy` must be false during mapping: `enqueueTrackedRun` parks on `isOnboardingActive()` which reads `isActive()`. Holding `busy` would deadlock the context run behind the job that is waiting for it.

`propose()` must still reject during mapping so a second wizard cannot overwrite `status` while the poll loop runs.

Do **not** extend `ONBOARDING_WAIT_MAX_MS`. Mapping does not hold `busy`.

Enqueue **before** any other work that yields, after `busy` is already false. A webhook that arrives after enqueue waits behind this run on the sequential queue.

Never pass `triggerRepo`. Context mode throws if triggered from a service repo.

## Contract

`OnboardStateSchema` gains `"mapping"` (non-terminal; terminal remains `done` \| `failed`).

`OnboardingJobStatus.mappingProgress?`:

| Field | Rule |
|---|---|
| `runId` | Present once enqueue returns a non-empty id |
| `step` | Copied from the run record while polling |
| `verdict` | Copied from the run record when present |

Regenerate `contract/openapi.json`, `packages/sdk/src/types.gen.ts`, `client/internal/contract/types.gen.go`.

## Job deps (additive-optional)

Mirror `indexRepo?`. A job without `enqueueContextRun` is byte-identical to today after indexing (or after confirm if indexing is also absent).

- `enqueueContextRun({ app, mirrorDir })` → `runId` (string or Promise). Composition: `git rev-parse HEAD` in `mirrorDir`, then `enqueueTrackedRun` with `shadow: false`.
- `getContextRun(runId)` → `{ runId, status, step?, verdict? } | undefined`
- `isCodeApp?(app)` → true skips mapping. Missing dep ⇒ treat as e2e. Throw ⇒ skip mapping (fail-open).
- `mappingPollMs` default 1500. `mappingTimeoutMs` default 60 minutes (fail-open ceiling; the QA run has its own timeouts).

SHA comes from the **front** entry of `lastRepoRefs` (primary mirror already provisioned at `baseBranch`). Empty `lastRepoRefs` ⇒ skip mapping.

## Skip and fail-open

Skip mapping when:

- `enqueueContextRun` is not wired
- `isCodeApp(app)` is true
- `lastRepoRefs` is empty
- enqueue returns `""` (shutdown)

Fail-open (state `done`, outcome unchanged, `error` warning, never `failed`):

- enqueue throws
- `getContextRun` is missing or stays `undefined`
- poll exceeds `mappingTimeoutMs` (leave the QA run running; do not cancel)
- any unexpected throw in the mapping loop

A completed map with verdict `invalid` / `infra-error` / `fail` is still a successful onboarding. Surface the verdict via `mappingProgress`; do not put it in `error`.

## TUI

`isTerminalOnboardState` stays `done` \| `failed`. `mapping` is non-terminal by omission (same as `indexing`). `confirmedBoundariesMsg` already stays on the propose screen when `jobState` is non-terminal — a confirm that re-polls `mapping` (or `indexing`) keeps the screen alive.

- Badge: `MAPPING`
- Body: “building FE↔BE architecture map…” plus `runId` / `step` / `verdict` when present
- Footer: `esc back`
- Winner card confirm hint: writes `boundaries[]`, indexes the repos, **and opens a PR for `e2e/.qa/context.json`**

## Composition (`src/index.ts`)

Wire `enqueueContextRun` / `getContextRun` / `isCodeApp` next to `indexRepo`. `getContextRun` reads `getRecord`. `isCodeApp` is `Boolean(loadAppConfig(app).code)`.

`shadow: false` on this RunRequest only. `req.shadow` already overrides YAML (`runner.ts`). Context mode publishes only `e2e/.qa/context.json`, so this does not open spec PRs or Issues.

## Tests (minimum)

Job:

- Confirm + index + map: `indexing` → `mapping` → `done`, outcome `winner`, `isActive()` false during mapping
- Mapping never observes `done` between indexing and mapping (coordinator must not set `done` until the tail finishes)
- No `enqueueContextRun`: indexing still ends `done` (S1.1 unchanged)
- `isCodeApp: true`: skip map, `done` after indexing, enqueue never called
- Enqueue throws: `done` + `winner` + `error`, not `failed`
- `propose()` while `mapping` returns `{ ok: false }`
- No-profile + map: propose ends `mapping` then `done` / `no-profile`

Contract: `mapping` in `OnboardStateSchema`; `mappingProgress` parses.

TUI: mapping badge + copy; `isTerminalOnboardState(mapping) === false`; tick reschedules; winner hint mentions `context.json`.

## Invariants

- Agent stays read-only on watched repos; only the orchestrator publishes.
- `qa-engine` does not import `src/`.
- Sequential queue: one QA run at a time.
- Fail-open: mapping never undoes boundaries.
- App-agnostic: no branches on named apps.
