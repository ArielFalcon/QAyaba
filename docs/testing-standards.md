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
test-file changes. Each run deletes the preset's previous report first, so a failed run never prints
a stale summary.

- **Survivors are triaged, not tolerated.** A real gap gets a behavior test through the public seam.
  An equivalent mutant (no observable difference) is never hidden: restructure the code so the
  mutant cannot exist (drop the redundant guard, the unreachable fallback, the duplicated check), or,
  when it cannot be removed, leave it surviving and list it below as a documented survivor with its
  reason. There are no `// Stryker disable` directives: a mutator-wide directive also excludes the
  non-equivalent mutants on its line, which is how the earlier "100%" hid survivors and kills alike.
- **Message text carries data a test can pin** (the path, the count, the offending question). A
  separator or wording that carries none is a documented survivor, never a test on the prose.
- **Timeouts are reported apart from kills.** A timeout counts as detected (an infinite-loop mutant
  legitimately times out), but the summary prints a killed-only score beside it: a timeout on a
  mutant that cannot loop is load noise. Re-run such a preset with fewer workers
  (`--concurrency=N`); presets whose tests spawn git set a lower `concurrency` of their own. A
  preset's tests run in their own process group (`scripts/run-in-group.mjs`), so a timed-out run's
  test-file processes die with it instead of spinning on the looping mutant.
- **Thresholds are per module, never repo-wide.** A preset starts in signal mode (`break: null`);
  raise its `break` only after it holds above `high` (90) for a few cycles. The keystone keeps
  `break: 80`.

Baseline (2026-09-28). Score = (killed + timeout) / valid mutants; the killed-only score leaves
timeouts out. **Before** is the suite against the code as it stood with every exclusion directive
lifted (the earlier table reported 100% for every preset because directives excluded 3–70 mutants
each, several of them killed and some surviving non-equivalent ones). **After** is the current code
with no directive. Every timeout was checked: in keystone, merge-guard, coordination-events and
coordination each one is an infinite-loop mutant (a loop bound, counter or growth step mutated). In
the two presets with slow tests, fix-loop's two failing-file-filter timeouts and 12 of
write-confinement's 17 are killed within seconds when the preset's tests run directly (they timed out
only under load), 4 of write-confinement's are loops, and one — the `" -> "` literal of the rename
arrow check → `""` — survives when run directly: it is one of write-confinement's documented
equivalents, so that preset really has 20 survivors. Runs used 4 workers (`--concurrency=4`),
write-confinement its preset cap of 2. The coordination and merge-guard rows are full re-runs after
later changes. The write-confinement row is derived, not re-run: the `^` anchor of `isCodeDenied`'s
leading-`./` strip was listed as an equivalent survivor, but a `./` past the start of a path is part
of a directory name (`e2e/.env./secrets` loses its `.env.` segment without the anchor); a test now
kills it, checked by applying the mutant by hand, which moves one survivor to killed.

The merge-guard After column was re-run on 2026-09-30, after the protected-path list grew; its five
survivors are the documented ones below. agent-efficiency (2026-09-30, 4 workers) is a new preset:
**Before** is its first run against the suite as written, **After** the re-run once the 55 survivors
were triaged. Most were real gaps and got behavior tests (which sightings a call sequence counts,
read windows, tool-name anchors, prompt-line indexing and gutters, the coarse call identity and
window steps, the call tracker's per-turn deltas). The equivalents were restructured away instead of
listed: the tracker's event counter became a flag and a tracked call is built from its latest
sighting (no placeholder identity, no sticky path guard); the call fingerprint serializes with the
native JSON serializer and a key-sorting replacer; the read-window and path lookups use optional
chaining instead of a type guard that primitives passed anyway; `sampleReadOutput` ends on its last
line and no longer strips a carriage return the trim already strips. The six timeouts are all
infinite-loop mutants of `sampleReadOutput`'s line scan (the loop body, the newline search, the
break test and the step), so the preset has no documented survivors. Its After column was re-run
after the exhaustion predicate gained the final-step text and the tri-state decision, and again once
the call tracker learned its stream's liveness (gaps, stream tokens, the bounded readiness wait):
301 killed, 14 timeouts, no survivors. The eight new timeouts are all mutants that keep a waiting
attempt from ever being released, so its test never finishes; the four survivors of the first run
were the default timer's two wrapper functions (now the global timer bound directly), an equivalent
guard (restructured away) and a release order the following gap made unobservable (reordered so a
test sees it).

generation-end (2026-09-30, 4 workers) is a new preset over the pure end classification with its
note, the run terminal it maps to and the learning gates. **Before** is its first run; every survivor
was a real gap or dead code: a step count against no limit, an empty tail's dangling label, the
note's lead and the separator before its tail (now pinned as structure — the note opens with text
before its facts and sets the tail apart — never as wording), and the note's bound handling, whose
fallback branches the note's own size made unreachable and which were restructured away instead of
listed. **After** is the re-run; it has no documented survivors.

precondition-verdict (2026-09-30, 4 workers) is a new preset over the typed auth precondition error and
the run terminal it maps to, run against their own tests and the class consumers' (error-class and its
parity, learning-gates, process-audit). **Before** is its first run; the one survivor was the error's
`name` string literal, restructured away (the name is the class's own, `new.target.name`) with the
behavior pinned instead of the literal: an error prints under a name of its own, apart from a generic
one. **After** is the re-run; it has no documented survivors.

login-evidence (2026-09-30, 4 workers) is a new preset over the module that classifies a login attempt,
scrubs credentials out of what a failed login writes and renders the note. **Before** is its first run;
the survivors were real gaps: an authenticated verdict that did not need a submit, an sso-only verdict
that did not need the form to be absent, evidence that contradicts itself (a submit recorded against a
form that was not found or not filled), a challenge read after the password was gone, separators that
fused a note's fields or a status with the next method, a missing status printed as null, and a
removal that could assemble another secret across its seam when the marker was empty. The note's
optional parts were restructured away instead of pinned by their wording: a part with nothing to say
is left out, and a test asserts that no field is rendered empty and no separator dangles. **After** is
the re-run; it has no documented survivors.

| Preset | Module(s) | Before: killed / timeout / survived — score (killed-only) | After: killed / timeout / survived — score (killed-only) | `break` |
|---|---|---|---|---|
| keystone | objective-signal decide/assemble/render | 108 / 5 / 4 — 96.58% (92.31%) | 112 / 1 / 0 — 100% (99.12%) | 80 |
| rule-learning | rule-governance.service, rule-fold | 117 / 4 / 7 — 94.53% (91.41%) | 114 / 0 / 0 — 100% (100%) | — |
| fix-loop | fix-loop.aggregate | 184 / 2 / 15 — 92.54% (91.54%) | 186 / 4 / 10 — 95% (93%) | — |
| coordination | acceptance-report, pushback, orchestration-router, delegation-failure-class | 199 / 20 / 11 — 95.22% (86.52%) | 252 / 1 / 3 — 98.83% (98.44%) | — |
| merge-guard | src/server/merge-guard.ts | 258 / 6 / 12 — 95.65% (93.48%) | 312 / 2 / 5 — 98.43% (97.81%) | — |
| coordination-events | src/server/coordination-events.ts | 156 / 13 / 16 — 91.35% (84.32%) | 132 / 8 / 1 — 99.29% (93.62%) | — |
| local-login | src/server/auth.ts (local-login policy range) | 63 / 2 / 4 — 94.2% (91.3%) | 59 / 0 / 0 — 100% (100%) | — |
| write-confinement | write-confinement.service | 149 / 14 / 20 — 89.07% (81.42%) | 147 / 17 / 19 — 89.62% (80.33%) | — |
| run-decision | run-decision.service, run-decision | 31 / 0 / 2 — 93.94% (93.94%) | 27 / 0 / 0 — 100% (100%) | — |
| agent-efficiency | tool-call-taxonomy, call-sequence, provided-context, step-exhaustion, coarse-run-efficiency, turn-efficiency-summary, call-efficiency-tracker, call-fingerprint | 226 / 7 / 55 — 80.9% (78.47%) | 301 / 14 / 0 — 100% (95.56%) | — |
| generation-end | generation-end, generation-end-terminal, learning-gates | 68 / 0 / 11 — 86.08% (86.08%) | 73 / 0 / 0 — 100% (100%) | — |
| precondition-verdict | auth-precondition, precondition-terminal | 4 / 0 / 1 — 80% (80%) | 4 / 0 / 0 — 100% (100%) | — |
| login-evidence | login-evidence (classifier, scrubber, note) | 79 / 0 / 21 — 79% (79%) | 95 / 0 / 0 — 100% (100%) | — |

### Documented survivors

Each is a genuine equivalent mutant: no test can observe it without asserting the mutated literal.

**merge-guard** (`src/server/merge-guard.ts`)
- `sanitize-text.ts` and `publication-port.adapter.ts` entries → `""` (StringLiteral ×2): both files
  are also covered by a directory prefix entry; they are listed so narrowing that prefix cannot
  unprotect them.
- `assessChange` reasons — the `" | "` and `", "` list separators (StringLiteral ×2): each unreadable
  row and each protected file is still named.
- `quotedLength` — `i < text.length` → `<=` (EqualityOperator): `text[text.length]` is undefined, so
  the extra pass only ends the loop.

**coordination-events** (`src/server/coordination-events.ts`)
- `parseCoordinationLedger` — the `catch` block emptied (BlockStatement): an unparsed line leaves
  `parsed` undefined, which the field checks drop anyway.

**coordination** (`acceptance-report`, `pushback`, `orchestration-router`, `delegation-failure-class`)
- `fingerprintOf` — `.slice(0, 16)` removed (MethodExpression): the truncation changes the stored
  string, never which fingerprints are equal.
- `buildProgressSnapshot` — the absent-failing-names stand-in `[]` (ArrayDeclaration): any constant
  stands for "no failing names".
- `applyPushback` — the `","` separator of the blocked summary's reason list (StringLiteral): every
  reason is still named, and each finding is also its own concern.

**fix-loop** (`fix-loop.aggregate.ts`)
- `allUnique` — the `"MULTIPLE"` marker → `""` (StringLiteral): the selector check reports a
  non-MULTIPLE contradiction only together with an absent key, which already clears `allUnique`.
- the missing-detail fallback `c.detail ?? ""` → a placeholder (StringLiteral): any placeholder text
  classifies the same ("other", not infra).
- the regeneration's `selectorContradictions` spread — condition forced true / `>= 0`
  (ConditionalExpression, EqualityOperator): the generation adapter treats an empty list like an
  absent one.
- `revalidate(input.specDir ?? "")` → a placeholder (StringLiteral): unreachable, the only caller
  always passes `specDir`.
- `canFilter`'s `failedSpecFiles.length > 0` — forced true / `>= 0` (ConditionalExpression,
  EqualityOperator): with no failing file every (non-empty) regeneration spec is an outsider, so the
  retry is never filtered anyway.
- the best-run update's `run.verdict !== "infra-error"` forced true (ConditionalExpression): an
  infra-error run ends the loop and the restore skips infra-error.
- the restore's `failCount(bestRunSoFar) < failCount(run)` — forced true / `<=`
  (ConditionalExpression, EqualityOperator): `bestRunSoFar` already includes every executed
  non-infra run, ties going to the later one.

**write-confinement** (`write-confinement.service.ts`)
All rest on git's own status/quoting invariants; the module is a protected security surface, so its
logic is left unchanged rather than restructured.
- the `".env"` denylist entry → `""` (StringLiteral): `"*.env"` denies `.env` as well.
- `decodeQuotedSegment` — `inner[i] ?? ""` → a placeholder (StringLiteral): `i < inner.length`, so
  `inner[i]` is always defined; the `^` or `$` anchor of `/^[0-7]{3}$/` dropped (Regex): `octal`
  holds at most three characters; the error message's escape excerpt (MethodExpression,
  ArithmeticOperator): the message always carries the whole quoted segment too.
- `decodeGitPath` — either quote check alone (LogicalOperator, MethodExpression, StringLiteral):
  git quotes every path containing `"`, so a raw path has a quote at both ends or at neither.
- `parseStatusOutput` — the quoted-old-path branch forced true, its scan bound `<=`, and the
  closing-quote/arrow check forced true or loosened (ConditionalExpression, EqualityOperator,
  LogicalOperator, StringLiteral): an unquoted path never contains `"` or `\`, and a quoted old
  path's closing quote is always followed by `" -> "`; `l.length > 3` → `>= 3`: git never emits an
  empty path; the R/C arrow check forced true: an R/C line always carries the arrow.
