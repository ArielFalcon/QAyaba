# Stubbed state

The suite exercises the real DEV. One exception: a state the change handles that DEV cannot be
brought to (the response it needs is not there and no UI step creates it) may be covered by a test
that fulfils the response it states, beside the live test of the same page. This page is the rule,
how the orchestrator detects it, and what it records.

## The rule the agents are given

- **When.** Only for a state DEV cannot reach, the case a `needs-unavailable-state` drop used to leave
  uncovered. Everything else keeps the real-DEV-first rule.
- **How.** Fulfil only the GET responses the state needs, with `page.route` and `route.fulfill`, behind
  an explicit method check (`if (route.request().method() !== "GET") return route.continue();`). The
  response shape comes from the app's contract or a response the grounding captured, never a guess.
- **Never.** Fulfil or alter a write, replay a HAR (it answers every method), `continue` with a changed
  method or body, or write a stubbed test with no live test of the page beside it.
- **Marking.** The title starts `[stubbed: <the response it states>]`. The marker is for the reader: the
  detector classifies from the code, not from the title.
- **Review.** The reviewer judges a stubbed test by what the frontend does with the stated response and
  rejects one that asserts only what it stubbed (`test-value-review`).

A stubbed test can hide a defect of the backend (the field the response lacks on DEV is the very
defect it would stub away). That is why the live test stays and why the PR says so.

## Detection

`qa-engine/src/contexts/test-execution/domain/stubbed-state.ts` reads each delivered spec's syntax tree
(through the confined reader), so a comment or a string that mentions `page.route` is nothing.

A test is stubbed when its body, a `beforeEach`/`beforeAll` hook above it, a function of the same file it
calls, or a helper it takes from another module intercepts requests (`route` with a handler,
`routeFromHAR`, `routeWebSocket`, a script that replaces `fetch`/`XMLHttpRequest`, a bare `fulfill`).
Whatever the detector cannot read is stubbed, never live: a helper imported from a module other than the
suite's fixtures is read as an interception because its body is not in the file. A file that does not
parse contributes nothing (it would not load).

| Violation | Meaning |
|---|---|
| `fulfil-without-get-guard` | a fulfil that no explicit GET check guards (an enclosing `if`/`?:`/`&&` on GET, or an earlier early exit unless GET) would answer a write too |
| `unverifiable-handler` | a route handler that is not a function of the file |
| `override-changes-request` | a `continue` or `fallback` that sets the method or body, or whose override cannot be read and no GET check guards |
| `har-replay` | a HAR replay answers every method it recorded |
| `no-live-test` | every test of a spec file is stubbed |

A route pattern cannot say which method it answers, which is why the guard is an explicit check in the
handler and not a property of the pattern.

### Why a violation is recorded and not a static-gate error

The static gate (`tsc`, ESLint, `playwright --list`) ends a run `invalid` and feeds the repair rounds.
The seed's ESLint `no-restricted-syntax` can ban a call but cannot see whether a check dominates it, and
the unreadable cases (a handler from another module) are ambiguous by construction. A false positive
would discard a green suite, while a missed violation only costs a visible line in the PR. So the
detector is conservative in the direction of the record (ambiguity reads as stubbed, an unguarded fulfil
as a violation) and the verdict never depends on it.

## What is recorded

- `gateSignals.stubbedState { specFiles, tests, violations?: [{ file, kind }] }`, absent when no delivered
  test is stubbed and no guard broke. Persist-only: it reads nothing back into a verdict.
- A `qayaba.stubbed_state` span with `qayaba.stubbed.spec_files`, `.tests`, `.violations` and
  `.violation_kinds` (`kind=count` pairs).
- In the PR and Issue bodies, beside "Possible regressions": **Tested against a stated response, not DEV**
  (each stubbed test with the response it states and the patterns it intercepts; a test stubbed only
  because a helper could not be read says so) and **Guards these tests broke**.
