# ADR-0025: Delivered specs do not intercept requests

- **Status:** Accepted, 2026-11-01, owner
- **Decision source:** the owner's words on 2026-11-01 (translated from Spanish): "Qayaba must not be able to make stubs, that covers up errors." (original: "Qayaba no debe poder hacer stubs, eso tapa errores.")
- **Code references at:** cfc69e3b
- **Related:** [RFC-0017](../rfc/0017-defects-from-verified-facts.md), [ADR-0001](0001-design-pillars.md) (P6), [ADR-0023](0023-owner-decisions-rfc-0015.md)

## Context

Until now one exception to real-DEV-first stood: a test could fulfil the GET responses of a state DEV cannot be brought to, beside the live test of the page, titled `[stubbed: <the response it states>]`. The engine detected such tests from the syntax tree and recorded them (`gateSignals.stubbedState`, a span, a PR/Issue section); it never refused them.

Run `run-ed28973-mvx5tf7x-2742c11b` (app name-webapp, commit ed28973) shows what the exception costs. The frontend reads `activeMenuCuisineType` from `GET /restaurants/countries/ES`. The backend maps that value to `cuisineType` and its OpenAPI schema `GeoRestaurantData` declares `cuisineType`, so the field never arrives and every cuisine chip is always disabled: a contract defect. The Context Pack reported it as a possible data contradiction. The author then wrote `[stubbed: geo collection with activeMenuCuisineType]` tests that fulfil that GET with the missing field: the frontend was tested against a contract the backend does not keep, and the defect stayed hidden. P6 of ADR-0001 ("test quality is the product") is the criterion the exception failed.

## Decision

**A delivered spec never intercepts requests.** A test that registers a route handler (`route` with a handler), replays a HAR (`routeFromHAR`), fakes a WebSocket server (`routeWebSocket`), fulfils a route (`fulfill`) or runs an init script that replaces `fetch`, `XMLHttpRequest` or `WebSocket` is refused by the engine, in the family of the refusal of skipped and `test.fail()` tests: `refuseOutright` (first pass, `run_spec`) and `modeRefusals` (regeneration acceptance) take it out of the report as a failing case that says why, whatever it asserts and whether or not it ran, and `verdictAfterRefusal` fails a run that would have passed over it. The author reads it as the failing case the fix loop regenerates and `run_spec` lists; a file whose regeneration still holds one gets its prior bytes back. The interception is read from the spec's syntax tree (`test-execution/domain/intercepted-tests.ts`), because a Playwright report says nothing of it; the caller hands the facts to the kernel rule.

The exception is removed everywhere: the author, reviewer and lead prompts, both skills, the prompt registries, the `[stubbed: ...]` title convention, `gateSignals.stubbedState`, the `qayaba.stubbed_state` span, the PR and Issue section "Tested against a stated response, not DEV", `StubbedTest.fulfils` under the data contradictions, `docs/stubbed-state.md`, the AGENTS.md bullet and invariant. A stored run that carries `stubbedState` is read as before (the field is only no longer typed or written), and `npm run previous-forms:check` bans the retired form.

A state DEV cannot be brought to is not tested: the lead drops its use case with the existing basis `needs-unavailable-state`, which now also covers a response DEV does not return, or the author reports the criterion unmet with the cause `dev-state`. The e2e seed's own fixtures (`config/e2e/fixtures.ts`: the failure capture, the mutation fixture) route requests on purpose and are not read by the rule.

## Assumptions taken (not the owner's words)

1. **All request interception is refused**, not only the fulfilling of a GET: an `abort`, a changed `continue` or a replay also alter what the page sees.
2. **Only what a run delivers is judged.** A stubbed spec already in an app's repository is not touched until a run changes it (the files a run delivers are the files `refuseOutright` judges, as for skipped tests); clearing the existing ones is a separate act.
3. **A helper from another module is not read.** The old detector counted any such call as stubbed; as a refusal that would fail every spec that uses a page object. A flow's author writes no file but its spec, so the module is the suite's own.
4. **The experiment acceptance is unchanged** (`AcceptDeliveredSpecsUseCase`, used by `scripts/baseline-agent.ts`): its seam has no reader of the spec text and a baseline arm is not a qayaba delivery.

## Consequences

- A run that used to publish a stubbed test beside a live one now fails on it until the author removes it; the use case that needed it is dropped or left unmet.
- The reviewer no longer judges stubbed tests; the engine never lets one reach it.

## Enforcement

`engine/test/shared-kernel/case-proof.interception.test.ts` (the kernel rule), `engine/test/contexts/test-execution/domain/intercepted-tests.test.ts` (the reading), `run-spec.use-case.test.ts`, `regeneration-acceptance.test.ts` and `run-qa.intercepted-tests.test.ts` (each refusal site and the run end to end), `platform/persistence/repositories/learning.repository.retired-fields.test.ts` (a stored run with the retired field stays readable) and the `intercepted-requests` rule of `npm run previous-forms:check`.

## Alternatives considered

- Keep the exception and make the detector a gate on its guards: the guards were never the problem; the stub itself replaces the contract the app really keeps.
- Refuse in the static gate: the gate sees the whole suite, so every stubbed spec an app already holds would fail every run, and its lint is the app's own.
