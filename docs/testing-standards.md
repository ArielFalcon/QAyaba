# Testing standards

A test earns its place by failing when behavior breaks and staying green when only structure
changes. `npm test` (node:test via tsx) and `cd client && go test ./...` are the suites; mutation
testing (`npm run mutate`) is the objective check that they would catch a bug.

## Principles

1. **Behavior, not implementation.** Assert what a caller can observe: a return value, a state
   change, a thrown error, a recorded side effect at a port. A pure refactor needs zero test edits.
2. **Through the public seam.** Exported functions, use cases and ports — never an unexported
   helper or a private field.
3. **Real code inside the hexagon.** Hand-written fakes for injected `*Deps`/ports; doubles only at
   the process boundary (network, fs, clock, git, LLM, Playwright).
4. **DAMP over DRY.** A reader must see the scenario in the test body.
5. **Deterministic.** No real time, network or iteration-order dependence — inject a clock, bracket
   `Date.now()`, sort before comparing.

## Must / must not

| Must | Must not |
|---|---|
| Name the behavior: `"a deploy exactly cooldownMs ago is past the cooldown"` | Name the process: `"C7:"`, `"J4 fix"`, `"WS1.4(b)"`, `p0_fixes_test.go` |
| Import a constant and assert the boundary around it | Re-type a production literal (`0.7`, `"MULTIPLE"`) |
| Assert that output *carries the data* (a path, a step id) | Assert exact prose, prompt or log wording |
| Destructure the fields the behavior claims | `deepEqual` a whole internal object |
| Record what a port received when that is the behavior | Count calls to an in-process collaborator |
| Write under `os.tmpdir()` | Write anywhere in the tracked tree |
| Build expected values by hand | Build expected values with the function under test |

## Anti-patterns and how to spot them

| Anti-pattern | Detector |
|---|---|
| Literal mirrors a production constant | a bare number/string in an assertion that also appears in the source |
| Exact prose/prompt equality | `strictEqual` against a literal longer than ~80 chars |
| Whole-object `deepEqual` | `deepStrictEqual(result, {...})` with no destructuring first |
| Call counts on internal collaborators | `callCount`, `mock.calls.length` on a non-boundary fake |
| Exact key-set assertions | `Object.keys(` in a test |
| Source read as text | `readFileSync(".../*.ts")` in a test — use `npm run arch:check` for structure rules |
| Tautological fixture | the fixture builder imports the module under test |
| Name promises more than it checks | read each test: one assertion must match its name |
| Go `View()` compared as one raw string | `View() ==` — assert substrings or use a golden file |
| Go `Update()` fed ad hoc structs | drive it with the real `tea.Msg` types a `Program` dispatches |

## Where a test starts

- **A bug fix starts with a test that fails for the bug's reason** — run it, see the failure message
  name the bug, then fix.
- **A test gap starts by showing the mutant survives** — run the module's preset, read the survivor,
  write the behavior test that kills it, re-run.
- A characterization test pins current behavior before a refactor; replace it with a real spec test
  once the behavior is intended.

## The test-write guard

`test-setup.mjs` (preloaded by `npm test` and every mutation run) installs
`scripts/test-write-guard.mjs`: any `fs` write from a test process into the repository's tracked tree
throws `ERR_TEST_TRACKED_TREE_WRITE`. Tests run in parallel, so a planted file would be visible to
every concurrent test. Write fixtures under `mkdtempSync(join(tmpdir(), "…"))` and remove them in a
`finally`. The guard cannot see child processes (git, a spawned node), so point those at a temp dir too.
The history DB and the JSON logs already get a per-process temp dir.

## The web console harness

`src/server/web-console/console-harness.ts` loads `web/public/js` into a `node:vm` context with a
scripted `fetch`, a virtual clock (`advance(ms)`), `sessionStorage` and a string-backed DOM. Tests
talk to the console only through its public seams — `api`, the rendered text of `#app`, `click`,
the login screen — and route requests with `controlApi` / `sseEvent`. Never reach into console
internals; never wait on real time.

## Mutation policy

`npm run mutate -- <preset>` mutates ONE module and runs only the test files that exercise it
(`scripts/mutate.ts` holds the presets; `npm run mutate -- --list`). Runs are full by default:
`--incremental` is safe only while editing the mutated source, because the command runner cannot see
test-file changes.

- **Survivors are triaged, not tolerated.** A real gap gets a behavior test through the public seam.
  An equivalent mutant (no observable difference) gets a `// Stryker disable next-line <Mutator>:
  <reason>` directive — never a test that asserts the mutated literal. Vocabulary data (stopword
  lists) and message-only text are excluded the same way, with the reason.
- **Thresholds are per module, never repo-wide.** A preset starts in signal mode (`break: null`);
  raise its `break` only after it holds above `high` (90) for a few cycles. The keystone keeps
  `break: 80`.

Baseline (2026-09-27; score = killed+timeout over valid mutants; ignored = documented equivalents):

| Preset | Module(s) | Before | After | Ignored | `break` |
|---|---|---|---|---|---|
| keystone | objective-signal decide/assemble/render | 82.76% | 100% | 8 | 80 |
| rule-learning | rule-governance.service, rule-fold | 86.92% | 100% | 13 | — |
| fix-loop | fix-loop.aggregate | 63.78% | 100% | 22 | — |
| coordination | pushback, orchestration-router, delegation-failure-class | 40.50% | 100% | 70 | — |
| merge-guard | src/server/merge-guard.ts | 73.71% | 100% | 27 | — |
| coordination-events | src/server/coordination-events.ts | 63.98% | 100% | 25 | — |
| local-login | src/server/auth.ts (local-login policy range) | 88.41% | 100% | 10 | — |
| write-confinement | write-confinement.service | 74.87% | 100% | 31 | — |
| run-decision | run-decision.service, run-decision | 91.18% | 100% | 3 | — |
