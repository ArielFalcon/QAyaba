# RFC-0007: Charge a DEV write only with evidence the spec caused it (N04)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Code references at 4105c582:** `config/e2e/fixtures.ts`, `qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts`, `qa-engine/src/contexts/test-execution/domain/run-dev-write-ledger.ts`, `qa-engine/src/contexts/test-execution/domain/dev-write-request.ts`, `qa-engine/src/contexts/test-execution/domain/spec-executor.ts`, `qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts`, `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts`, `qa-engine/src/contexts/test-execution/domain/agent-browser-route-guard.ts`, `qa-engine/src/shared-kernel/closed-loop.ts`, `qa-engine/src/shared-kernel/telemetry/attribute-registry.ts`, `qa-engine/src/contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts`, `qa-engine/src/contexts/coordination/application/flow-capacity.ts`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts`, `qa-engine/src/shared-infrastructure/process-sandbox/exec-workdir.ts`, `qa-engine/test/contexts/test-execution/infrastructure/seed-dev-write-counter.test.ts`, `AGENTS.md`, `docs/engine-platform-architecture.md`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0002](./0002-platform-steps-0-1.md), [RFC-0010](./0010-tool-call-record-outcome.md) (hypothesis: the attributes renamed here sit on the `run_spec` span record; RFC-0010 was not written when this record was drafted, so the shared slice is for the owner to settle there), [Rejected explanations](../rejected-explanations.md)

## Summary

1. Cause N04, confirmed by both refuters: the seed's write counter decides who caused a request by its destination (any answered mutating request to a declared DEV origin) and has no notion of cause. On name-webapp the browser session's own token renewal was charged to the spec, about one write per test once the saved session was old, and the per-flow share and the run cap turned 16 charges into `no-writes` refusals in #19, #23 and #24 (epochs O6, O7, O8).
2. Main removed one protocol shape (a form `refresh_token` or `authorization_code` POST to a non-launch origin, `d5ccde3f`). The rule is unchanged. A probe at 4105c582 shows six other shapes of page-sent traffic still charged and one page-sent shape never charged, because the exemption is decided by a body the spec controls.
3. Proposal (O3): define a write the spec caused as one the same session does not send when no spec action runs. The harness observes that counterfactual once per worker (a control load, outside the spec), the seed only records, and one engine function charges the requests that exceed what the control saw. The shape exemption is deleted.
4. Verdict effect of the failure: none (all three runs ended `pass`); the cost was a starved `run_spec` loop for the refused flows. The change touches the cap that bounds agent-authored specs, so it ships alone.
5. Six forks are the owner's (end of the record); the evidence source (control per worker, or a warm-up in each test) is the main one.

## Problem

Evidence labels: a statement without a label is confirmed (the file was opened at 4105c582, or the figure was read from the run records); **hypothesis** is an inference. The figures for #19 and #23 come from the investigation's extraction of the history spans; I re-read #24 and the baseline from the history database for this record and did not re-run the replays.

### The causal chain

| # | What happens | Where |
|---|---|---|
| 1 | The app renews an expired stored session by itself on load (and by a library timer shortly before expiry). Trigger, outside this repository (name-webapp at ed28973, `oidc-client-ts`). | the app |
| 2 | Every `run_spec` spawn gets a fresh copy of the one saved session; nothing a test refreshes is saved back. | `qa-engine/src/shared-infrastructure/process-sandbox/exec-workdir.ts:63-67` (`copyInto`), `:73` (`stageAuthMaterial`) |
| 3 | The seed counts every answered POST, PUT, PATCH or DELETE of the test's page or API client to a declared DEV origin, by destination. | `config/e2e/fixtures.ts:516-524` (`isDevWrite`), `:568-571` (`classifyWrite`), `:573-582` (`noteAnswered`) |
| 4 | One shape is kept apart: a form POST naming `authorization_code` or `refresh_token`, to an origin other than the launch origin. | `config/e2e/fixtures.ts:525-536` (`SESSION_GRANTS`, `isSessionRequest`) |
| 5 | The runner sums the ledgers; the use case charges the capability and the run ledger. | `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:325`, `:477-505`; `qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts:233-234` |
| 6 | Budget: the cap is a constant of 20; a flow's share is `floor(ceiling / flows)` with a minimum. | `qa-engine/src/shared-kernel/closed-loop.ts:14`; `qa-engine/src/contexts/coordination/application/flow-capacity.ts:73-80`; `qa-engine/src/contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts:80` |
| 7 | Refusal `no-writes`, with a message that states a fact the engine does not hold: "the executed specs already sent N write request(s) to DEV". | `qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts:189`, `:207-214` |

### The runs

| Run | Epoch | Counted writes / tests | Refusals | Source of the traffic |
|---|---|---|---|---|
| #19 `run-ed28973-mvq9r6vy-7f454004` | O6 f96f958f | 22 / 22, 6 executed calls | 4 `no-writes` | derived (no request listing existed) |
| #23 `run-ed28973-mvqy1s7l-64c65862` | O7 e4efa50e | 20 / 20, 8 calls | 9 `no-writes` | derived |
| #24 `run-ed28973-mvr4s6br-7cfce5f0` | O8 27238792 | 20 / 21, 6 calls | 3 `no-writes` (1 share, 2 run cap) | listed: all six calls name only `POST <idp>/realms/<realm>/protocol/openid-connect/token` (x4, x3, x4, x4, x4, x1), read from the history spans |

Across the calls before the fix, writes never exceeded tests (63 calls with tests), calls started under 255 s after the last login counted 0 (11 of 11), and 42 of 48 calls older than 300 s counted at least one (130 counted for 144 tests). The six exceptions are one spec whose test installs a native-platform shim, so the app starts a provider that holds no web session (hypothesis: read from test names and code, not executed). The investigation's replay of the three runs through each epoch's capability matched 36 of 36 admit or refuse decisions, and with the counted writes set to 0 all 16 refusals disappeared (not re-run here).

After the shape exemption (baseline `run-ed28973-mvs7oo0f-17041c71`, 4105c582): 9 executed `run_spec` calls, each with `dev_writes` 0 and a `dev_session_requests` list (42 requests in all), and 2 `no-calls` refusals. The traffic did not go away; it is listed apart. In four runs after the fix, 30 of 30 calls older than 300 s list session requests and none was refused for writes.

### Why it is a rule defect, not an app defect

The counter has one producer, one summer and one consumer (rows 3, 5 and 7 above); ownership was never the failure. The rule inside the owner is a proxy ("declared origin") plus one exclusion keyed to a protocol shape. `d5ccde3f` says why it could not be better at the time: the orchestrator never observes the login's requests, the saved session names no issuer, and the login script is agent-written. At least nine commits have since changed this quantity (`c0be9ea6`, `c4d922ac`, `6bcddef0`, `a40a3eb6`, `b7300f2f`, `d5ccde3f`, `35d63661`, `130202f1`, `2d3cdd00`); each fixed one sub-mechanism.

### How the rule misfires on other apps

Probe at 4105c582: the real capture block of `config/e2e/fixtures.ts` driven with request shapes by hand (12 of 12 assertions pass; the shapes are hypotheses about real stacks, the counts are confirmed about the code).

| Request an app's page sends on its own | Counted on main | Stack that plausibly sends it (hypothesis) |
|---|---|---|
| Form `refresh_token` POST to a separate IdP origin | no, listed apart | Keycloak, Okta, Cognito, MSAL (name-webapp is this one) |
| JSON-body refresh at the IdP (`/oauth/token`) | **yes, 1** | Auth0 style SDKs |
| JSON refresh on the app's own origin (`/api/auth/refresh`) | **yes, 1** | a Spring backend issuing its own JWT |
| Form refresh on the app's own origin | **yes, 1** (by design, `config/e2e/fixtures.ts:474-476`) | single-origin apps |
| Cookie-session renewal, POST with no body | **yes, 1** | cookie sessions that renew by call |
| Form refresh whose body Playwright cannot read | **yes, 1** | none known |
| First-party heartbeat or `sendBeacon` event to the app origin, answered | **yes, 1** | analytics or presence |
| Beacon to an undeclared host, or refused by egress | no | Sentry, Mapbox events |
| Page-sent POST to the API origin whose form body names `grant_type=refresh_token`, 50 times | **no, 0 charged, 30 not even recorded** | nothing legitimate: the body is the spec's to set |

The "yes" rows are over-charging (the N04 class); the last row is under-charging. A read sent as POST (a GraphQL query) also charges 1; a spec action triggers it, so it is not autonomous traffic (see Out of scope). A server-side session (cookie renewed by the backend) and Java services (their calls are not in the browser's request stream) never enter the count. Where an app's session traffic is any of the "yes" rows, the same chain applies: one charge per authenticated test once the stored token is old, and a cap of 20 reached in 4 to 10 calls (the investigation's replay of name-webapp's call mix: calls 6, 4, 10, 5; hypothesis for another app). This is the same mechanism with a different trigger shape, which is what the golden rule (`AGENTS.md:3-21`) asks a root-cause fix to cover.

### What the cause does not explain

- #26's two `no-writes` (`run-ed28973-mvra9a3s`): a killed call charged the run's whole remainder (`qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts:233`), a different mechanism, fixed by `130202f1`, which is an ancestor of 4105c582.
- Whether test quality changed: none shown. #19, #23, #24 ended `pass`; the refused flows lost their `run_spec` proof and the final execution judged their bytes.
- The 240 to 300 s age edge: it looks like the token lifetime minus the library's expiry window (hypothesis; the lifetime was not read, a credential rule).
- Whether the agent browser's own renewal is blocked at the route guard (`qa-engine/src/contexts/test-execution/domain/agent-browser-route-guard.ts:144-146`, no session exemption, no span records which methods were blocked): not enough evidence.

## Goals and non-goals

Goals:

- **G1** A request is charged to the spec because the engine holds evidence the spec caused it, not because of where it went or what its body looks like.
- **G2** One rule for every app and stack; nothing in it names a protocol, a header, a body field, a path or the role of an origin.
- **G3** The invariant in the next section holds.
- **G4** The refusal message states only what the engine knows.

Non-goals: changing the cap (20), the share arithmetic, or the call budget; the killed-call charge; counting in the final execution; the agent browser guard.

## What "a write the spec caused" is, and how the engine can know it

A write the spec caused is a mutating request that would not have been sent had the spec stopped before its first action. Its complement, autonomous traffic, is what the page, the browser or the app's session code sends on their own. What the engine can know:

| Source | What it tells the engine | Can the spec set it |
|---|---|---|
| Sender is the spec's API client (`config/e2e/fixtures.ts:622-651`) | Caused by the spec, by construction | no, it is the spec's own call |
| Destination is a declared DEV origin (today's rule, `config/e2e/fixtures.ts:516-524`) | Which system, not who caused it | no, but it says nothing about cause |
| Request shape: body names a grant, origin differs from the launch origin (`config/e2e/fixtures.ts:525-536`) | Nothing about cause; a proxy for one protocol | **yes**: any page-sent POST can carry that body (probe: 50 uncounted) |
| Time window of a spec action (a click, a `goto`) | Nothing: renewal runs on load, inside the `goto` that the spec made | n/a |
| **Counterfactual: the same session and app with no spec action** | What the page sends unprompted, by method, origin and pathname, with multiplicity | not by the spec's text; see the invariant |

Only the last row separates upkeep from writes without a protocol key. It is an observation, so it is evidence of the first kind this engine can hold: a fact measured in a phase the spec did not run.

## The invariant every option must keep

The cap protects DEV's data from what agent-authored specs do (`qa-engine/src/shared-kernel/closed-loop.ts:10`; `AGENTS.md:296-302`). It is held by the orchestrator, not by the agent's say.

| # | Invariant | Where it is held today |
|---|---|---|
| I1 | One run-level cap across all flows, checked and charged under the account lease. | `qa-engine/src/contexts/test-execution/domain/run-dev-write-ledger.ts:8-35`; `qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts:185-195`; `qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts:227-234` |
| I2 | An uncountable call is charged the run's whole remainder: fail closed. | `qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts:233`; `AGENTS.md:298`, `:302` |
| I3 | No exemption rests on text the spec writes (a name, an annotation, a body it composes). | violated today by `config/e2e/fixtures.ts:529-535`: a spec-composed body is the key |
| I4 | A request the spec's API client sent is never exempt. | holds (`config/e2e/fixtures.ts:638`: no body, so never session traffic) |

The counter lives in the spec's process: the ledger is written by fixture code in the process that runs the spec (`config/e2e/fixtures.ts:549-565`), and writes in `beforeAll`, `afterAll` or at module top level are not counted (`AGENTS.md:302`). It bounds an honest spec and resists cheap evasion (`qa-engine/test/contexts/test-execution/infrastructure/seed-dev-write-counter.test.ts:150` pins that rewriting the launch environment does not move a write off DEV). The boundary against a hostile spec is the sandbox, the egress filter and the browser route guard, not this count. No option here changes that, and none may weaken I1 to I4.

## Options

### O0. Leave main as it is

Removes nothing. Adds nothing. Risk: the table above. On name-webapp the instance is gone (the baseline has `dev_writes` 0 on 9 of 9 calls), so no run on this app motivates more; the other rows are code facts with no run behind them. The page-sent grant body keeps the cap open to a one-line bypass (I3).

### O1. Widen the exemption by shape

Add JSON bodies, own-origin token endpoints, bodyless renewals, and so on, to `isSessionRequest`. Removes the listed shapes. Adds one rule per stack, which the golden rule rejects, and widens I3's hole with every shape. Risk: the next stack is the next incident (the pattern behind the nine commits).

### O2. Hand every call a fresh session

Re-login before each call (`qa-engine/src/contexts/agent-tools/infrastructure/adapters/trusted-session-renewal.ts`'s `authSession.prepare` already does it after a loss), so tests start with a token far from expiry. Removes most of the trigger. Adds a DEV login per call (up to 8 per flow) and either a login every time or an age threshold; the engine cannot read a token lifetime from an opaque saved session (hypothesis), and the investigation's age edge is itself a hypothesis. It does not remove the cause: a test that crosses expiry renews mid-test (#28: 6 requests for 3 tests at age 261 s), and the counter still charges it. A complement to O3 at most.

### O3. Observe the counterfactual; the seed records, the engine charges (recommended)

The harness runs a control: once per worker of a `run_spec` spawn, before any spec code, in a context of its own built from the same saved session the tests start from, it loads the launch URL, waits for the network to go idle (bounded by the call's remaining time, no new constant), and writes the mutating requests it saw (method, origin + pathname, count) to a control file in the capture directory. The seed's counter stops classifying: it records every answered mutating request with its sender (page or API client). The runner reads the control beside the ledgers. One engine function charges per test: each recorded page request is exempt up to the count the control saw for the same method, origin and pathname; API-client requests, requests beyond the recorded 20 distinct, and every request when the control is missing, unreadable or oversized are charged in full.

- Removes: the shape exemption and its forgeable key; every over-charge row whose traffic the page also sends in the control, of any shape.
- Adds: a worker-scoped fixture (one extra context and page load per worker, on DEV with the test account), a control file and its reader, one pure function.
- Risk: it misses traffic the control does not repeat (a library timer that fires mid-test, a test that starts long after the control): that traffic is charged, the safe direction, and the double-renewal calls seen after the fix are 2 of 72 (hypothesis: the control is too early for them). Refresh-token rotation with reuse detection at an IdP: one more consumer of the stored refresh token (hypothesis; name-webapp already has every test spend it). A control that cannot run (the launch URL needs interaction) leaves everything charged, which recreates N04 on that app. Feasibility rests on Playwright's documented worker-scoped fixtures and a second browser context from the same storage state; it was not run here (no Playwright in this investigation), so it is a hypothesis until the RED tests and one execution show it.

Variant O3b: the same, with the warm-up in each test's own context (a scratch page before the test body). Smaller code, no key matching, and the traffic leaves the test (the token is refreshed before the spec's page loads, in any app whose session sits in storage the scratch page shares). It changes the spec's starting state, adds a page load per test instead of per worker, and does nothing for session storage that is per page (hypothesis). Not recommended; offered as a fork.

### O4. Charge distinct endpoints, not requests

A renewal repeated per test would cost one charge per run. Rejected: it breaks I1. A spec that POSTs `/orders` 100 times would cost 1.

### O5. Attribute by the time window of spec actions

Rejected: the renewal runs on page load, inside the `goto` the spec made, so it lands in the window (analysis of the app's restore-on-start behaviour, outside this repository; not run).

## Recommendation

**O3**, as one change that also deletes the shape exemption.

- **Why it removes the cause at every site of its class.** The class is "a request charged to the spec without evidence the spec caused it". O3 replaces the proxy by the evidence, so a JSON refresh, a cookie renewal, an own-origin token endpoint and a load-time beacon are exempt for the same reason, and the next shape needs no code.
- **Why it is the smallest change that does it.** It keeps the one producer, one summer and one consumer; it deletes `isSessionRequest` and the `session` kind; it adds one fixture, one file and one pure function. O1 is smaller and does not remove the cause; O2 is a different and partial remedy.
- **Why it is app-agnostic.** The control is the same session and app with no spec action; an app with no autonomous traffic gets an empty control and sees no change; a cookie-renewed session or a backend-only flow sends nothing the control must match. On a Spring app with a JSON refresh at `/api/auth/refresh`, main charges one write per authenticated test once the stored token is old; under O3 the control sees that POST and exempts it. Nothing in the rule names Keycloak, the IdP, an origin role, a path or a body.
- **Invariants.** I1 and I2 are unchanged (the charge goes through `chargeRunWrites` and `chargeRunRemainder` as now). I3 improves: the key becomes an observation made before the spec runs, not a body the spec composes. I4 is explicit (the API client is recorded by sender and never exempt). A spec that forges the control file needs to write the capture directory, the same trust level as forging its own ledger today.
- **Message.** The refusal text (`qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts:189`, `:211`) reports the charged count, and the span records the control requests apart, so the agent is no longer told that its read-only spec wrote.
- **Where it lives.** The charge decision is policy: `qa-engine/src/contexts/test-execution/domain` (row 3 of the placement table in `docs/engine-platform-architecture.md`), a pure function beside `qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts`. The ledger and control readers stay in `test-execution/infrastructure` (row 4). The seed stays in `config/e2e/` as a recorder that decides nothing. No new ownership test (ADR-0002, addition 8): the count already has one owner, and the defect was the rule. The change follows platform steps 0-1 ([RFC-0002](./0002-platform-steps-0-1.md)) in the approved order.
- **Seed rollout.** A change to the capture block needs the outgoing block's hash added to `EARLIER_FAILURE_CAPTURE_BLOCKS` (`qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts:62-72`); an app whose block is not in that set keeps its own (`:136`).
- **Ships alone.** It changes what the write cap charges (agent write authority), so it is its own commit on the working branch (the owner's single-branch rule), as `AGENTS.md:690` asks of governance-sensitive changes (agent write authority).

## Patches it supersedes

| Patch | Where | What goes |
|---|---|---|
| `d5ccde3f` shape exemption | `config/e2e/fixtures.ts:469-476` (comment), `:525-536`, `:568-571` (session branch), `:573-582`, `:589-620` (kinds), `:543` | `SESSION_GRANTS`, `isSessionRequest`, the `session` kind of `sentWrites`, the `sessionRequests` field |
| `35d63661` session-request record | `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:477-505`, `qa-engine/src/contexts/test-execution/domain/spec-executor.ts:28`, `qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts:243-252`, `qa-engine/src/shared-kernel/telemetry/attribute-registry.ts:422`, `AGENTS.md:303-306` | renamed to the control record (fork F4) |
| Shape tests | `qa-engine/test/contexts/test-execution/infrastructure/seed-dev-write-counter.test.ts:163-211`, `:297-308` | replaced by control-based tests (Test plan) |

Guard check (`AGENTS.md:20-21`): `d5ccde3f` is a deliberate guard. Its purpose, a read-only spec does not spend the cap on sign-in traffic, is kept: the form refresh at a separate IdP must still charge 0 when the control saw it (Test plan T1). Only its key is removed. `a40a3eb6`, `b7300f2f` (run ledger, shares kept), `c4d922ac` (answered only) and `6bcddef0` (declared origins) are not superseded: they define the cap and the declared-origin scope, and they stay.

## Test plan

RED first, through public seams (`AGENTS.md:746-760`). The existing rig of `seed-dev-write-counter.test.ts` is the seed seam (the ledger file the block writes); the domain function and the use case are the engine seams. Fakes only for ports; no network, no Playwright.

| # | Test | Fails today because |
|---|---|---|
| T1 | Table-driven, app-free: a control that saw request R and a test that sent R charges 0, for form refresh at a separate origin, JSON refresh, own-origin refresh, bodyless renewal, load-time beacon | 4 of the 5 shapes charge 1 (probe; the form shape is the exempt one) |
| T2 | Multiplicity: the control saw R once, the test sent it 3 times: charged 2 | no multiplicity exists |
| T3 | A page-sent POST whose body names `grant_type=refresh_token` to the API origin, 50 times, with an empty control: charged 50 | charged 0 and 30 unrecorded (probe) |
| T4 | An API-client POST to the token endpoint is charged although the control saw the same endpoint (I4) | holds today; pins the new design |
| T5 | Control file missing, unreadable, oversized or forged: everything charged; the use case charges the run remainder as before when the ledger is unreadable (I2) | n/a, new fail-closed contract |
| T6 | Chain through `RunSpecUseCase` and the capability with fakes: six calls whose ledgers hold four JSON refreshes each and a control holding that endpoint: charged 0 and no `no-writes`; the same calls with an empty control: refused at the cap of 20 | main charges 24 and refuses |
| T7 | The previous behaviour that must hold: a spec write to the app (`POST /api/orders`) is charged once, a write the server did not answer is not counted and leaves nothing pending | passes today; pins it |

Differential check before finishing (`AGENTS.md` ODD policy): every existing command that shares the changed code (`run_spec`, the final execution with counting off) is run against a copy of the base commit and against the change, comparing stdout, stderr and exit code, in a scratch directory.

## Measurement

- **Cause gone, deterministic:** T1 to T3 and T6. One replicate cannot show shape independence: the only app has the form shape, which main already exempts.
- **Record the change adds:** each `run_spec` span lists the control requests apart (renamed attribute, fork F4) and `qayaba.tool.dev_writes` is the charged count. Before (baseline `run-ed28973-mvs7oo0f-17041c71`): charged 0 on 9 of 9 executed calls, 42 requests listed by the shape rule, 2 `no-calls`. After, one replicate: charged 0 on every executed call, the exempt requests of each call equal at most what its control lists, no `no-writes`. Same suite digest and freeze as the baseline ([ADR-0011](../adr/0011-root-cause-fix-policy.md), rule 4). One against one shows a direction only.
- **Falsifiers:** a call with charged writes greater than 0 whose final delivered bytes hold no mutating action (the control missed upkeep: then O3b or O2 is the follow-up), or a call older than 300 s with no control record.
- **Not measurable on one app:** the over-charge rows other than the form shape. Say so in the result; do not report them as removed by the replicate.

## Owner decisions needed

- **F1** Adopt the definition (a write the spec caused is one a no-action control does not send) and delete the shape exemption. Recommended: yes.
- **F2** Evidence source: control per worker (O3), warm-up in each test (O3b), or fresher session first (O2). Recommended: O3; O2 only later if mid-test renewals show in a replicate.
- **F3** Keep the form-grant exemption during the change as a second path? Recommended: no (it keeps the forgeable key, I3); accept that a call whose control cannot run charges its upkeep.
- **F4** Rename `dev_session_requests` and `sessionRequests` to a control name, since the list now holds any autonomous request, not only session traffic. Recommended: yes, one rename.
- **F5** Exempt up to the control's count per test (recommended), or any count of a matching endpoint (spammable), or one per test.
- **F6** Ship as its own commit on the working branch, ahead of any other closed-loop change. Recommended: yes.

## Out of scope

Each is a plausible neighbour, kept open under D12; none is fixed here.

- Method as a proxy for write: a read sent as POST (GraphQL, search with a body) is charged on main and, when a spec action triggers it, rightly so under this definition; whether it should spend a cap meant for data changes is a separate question with no run behind it.
- The agent browser route guard (`qa-engine/src/contexts/test-execution/domain/agent-browser-route-guard.ts:144-146`): no session exemption, and whether renewal is blocked is not known. Any definition of session traffic must not loosen it (`AGENTS.md`: no mutating request through without an `allowMutating` entry).
- Writes in `beforeAll`, `afterAll` or at module top level, which no test ledger counts (`AGENTS.md:302`).
- The per-flow share and call grants (`qa-engine/src/contexts/coordination/application/flow-capacity.ts:73-80`, `qa-engine/src/contexts/coordination/application/lead-plan.ts:304`), the `no-calls` refusal (candidate N07) and the killed-call charge (#26).
- The token lifetime, the 240 to 300 s edge, and the native-shim spec of #17.
- Counting writes in the final execution, which carries no counter.
