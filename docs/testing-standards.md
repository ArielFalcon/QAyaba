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
test sees it). It was re-run once more after the tracker took the prompt's provided paths: 306
killed, 14 timeouts, no survivors. The one survivor of that run was the default of the new argument,
an empty list no test could tell from any other, so the argument is optional now and its absence
reads as no listed paths. A last re-run, after the prompt-contract judgment round and with 8 workers,
gave the same 306 killed, 14 timeouts and no survivors.

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
one. **After** is the re-run; it has no documented survivors. The preset was later widened to mutate the
lines of `error-class.ts` that name the class and resolve it and the lines of `process-audit.ts` that
turn it into an observe-only finding (line ranges, so the neighboring classes' logic is not measured
here): its After column is that widened run. The first widened run had one survivor, the condition of
the branch that follows the finding, which the range had swept in; the range now stops at the
finding.

login-evidence (2026-09-30, 4 workers) is a new preset over the module that classifies a login attempt,
scrubs credentials out of what a failed login writes and renders the note. **Before** is its first run;
the survivors were real gaps: an authenticated verdict that did not need a submit, an sso-only verdict
that did not need the form to be absent, evidence that contradicts itself (a submit recorded against a
form that was not found or not filled), a challenge read after the password was gone, separators that
fused a note's fields or a status with the next method, a missing status printed as null, and a
removal that could assemble another secret across its seam when the marker was empty. The note's
optional parts were restructured away instead of pinned by their wording: a part with nothing to say
is left out, and a test asserts that no field is rendered empty and no separator dangles. **After** is
the re-run; it has no documented survivors. It was re-run once more after the classifier and the
scrubber were corrected: a second-factor step, a captcha and an unpersistable session are read only
on positive evidence (the step on screen after the submit, nothing in flight, a fresh context that
was actually read), a recorded submit is always an attempt so the stock seed does not submit again,
and the scrubber locates every spelling of every secret on the original text without regard to case
and replaces the merged stretches once. The four survivors of that first re-run were a fallback that
capture group 1 makes unreachable (now an assertion), two comparisons on the merge boundaries (pinned
with a stretch that touches another and a secret inside a longer one, and the update of the covered
end now takes the larger end instead of testing for it) and an unpinned marker at the very start of a
text. The After column is the final re-run; it has no documented survivors. It was re-run once more
when the classifier learned the submit that threw in the page and sent nothing (a new exception, with
no request and nothing in flight, is a login that cannot complete; a recurring one, plain console text
or a request sent leaves the outcome to the request rules), and the note began to name that
exception: 129 killed, no survivors. It was re-run a last time after that rule began to need the
form's own submit event, a session was no longer called unpersistable while the login was still in
flight or with no request of the login seen, and the scrubber learned the `encodeURI` spelling and a
backslash read as a slash in a path: 141 killed, no survivors.

patch-app-yaml (2026-09-30, 4 workers) is a new preset over the module that edits an app's YAML in
place, run against its own tests and the update use case that drives it. **Before** is its first run;
the survivors were real gaps: the refusal of a document that is not a mapping and the message that
comes with a refusal, long values folded across lines, a block added or changed without the blank line
that sets it apart (or with one where it was already set apart), the keys of the other kind dropped on
a patch that does not change the kind, an empty variable name written over the one on disk, a shorter
supplied list leaving the services it does not name, a list holding an item that is not a mapping, an
alias in the first position of a list, a key removed under a block with nothing under it, and an alias
removed or replaced as a value. Machinery for paths deeper than one block was restructured away (no
path here has more) and a guard that the first write already performs was removed. **After** is the
re-run; its one survivor is documented below.

prompt-contract (2026-09-30, 4 workers) is a new preset over the prompt-contract lint (its claims, its
fourteen rules and its lexicons), the single regeneration predicate, the diff size, the harness-facts
export scan and the reader that feeds it (`readFixtureFacts` and `readHarnessFacts`, a line range of the
grounding adapter), run against their own tests, the prompt-builder seam tests that drive the
predicate, the size line and the facts section, and a sample of the matrix that lints the reachable
generator prompts. **Before** is its first run, over the lint, the predicate and the diff size. Most of
its 60 survivors were the free-text `detail` string of a finding, which a test could only pin as
prose, so a finding now carries structured numbers instead (the bytes a pair duplicates; what a budget
measured against its limit). The real gaps got behavior tests: the sections of a finding named sorted,
the minimum duplicate line and fences that name their language or are indented, the login rule's three
conditions, a facts-only section that also carries a plain claim, a hunk header with trailing context,
findings ordered by key as text. The equivalents were restructured away: pair loops became pair
generators, the guards that skipped work with no effect were dropped, a reference to a heading is
split out of the text instead of glued shut, and the harness-facts section id is typed as a fact so
the mutant that empties it cannot compile. The export scan joined the preset later and its first run
left 49 survivors of its own (367 killed, 14 timeouts, 49 survived over the extended preset). They
were real gaps (whitespace between the tokens of a declaration, an export list or a namespace
re-export written without spaces, a type-only entry with an alias, a malformed entry, the order of
names across the three kinds of export, a comment or literal that is never closed, an escaped
backslash before a closing quote, a comment standing between two tokens, the length bound of an
attribute name) or equivalents that were restructured away: the hand-rolled scanner for comments and
literals became one regular expression, an export entry is matched by a single pattern that leaves a
type-only entry out by construction, and source order comes from match positions rather than a
seeded list.

The lint later gained the artifact-reference rule, the trust-polarity rule, indented duplicate lines
(the rows of a captured DOM tree excluded) and a byte budget for the static layers, and the preset
gained the fixtures reader. Its first run over that (747 mutants, 73 minutes) had 22 survivors and
109 timeouts: the exhaustive matrix, now 13,882 combinations against two static layers, no longer fits
the 15 second mutation timeout, so most mutants were classed as timeouts and a survivor could hide
among them. The preset now runs a deterministic sample of the matrix (every 23rd combination, each
value the stride skipped, and the brief-and-pack shapes; the exhaustive test stays in the suite and
lints the combinations once) and a run takes under eight minutes. The real gaps got behavior tests: a
fixtures file of exactly the size cap, a named pipe that must not be opened, a plain attribute name
that redaction would change, an attribute with no fixtures file, a negated-trust phrase without its
suffix, a section that frames a tree without providing one, fences with a language, an indent or a
label, the shapes of a markdown title, a hash inside a line and a phrase broken across lines. The
equivalents were restructured away: the reader's size check on the path before it opens the file, the
descriptor's second regular-file check, the attribute's redaction test folded into one condition and
the prose scan's initial array. **After** is the final run over the extended preset with the machine
default of 8 workers: 491 killed, 6 timeouts, 4 survivors, all documented below.

route-capturability (2026-10-04, default workers) is a new preset over the pure classification of a route
string (a template, free text, an interpolation or another host names no page a browser can open) and the
lines of the context pack that filter the candidates before the capture slice, log and list what was left
out. **Before** is its first run; the 15 survivors were all in the pack: the bound of the list and the
newline between its lines, the log when nothing was left out, a stray blank section after the last one,
and three header fragments and a list separator that no test could tell apart because the header's words
are prose. The real gaps got behavior tests (the list is the heading and one line per route, a pack with
nothing left out has no trailing section, nothing is logged when every candidate can be captured). The
header fragments were restructured away: each section now carries the words that name it in the header, so
there is no per-section fallback to mutate. The classification module had no survivor. **After** is the
re-run; it has no documented survivors. The adapter test that hands the routes to the login discovery is
not in the preset: it needs the stock seed from `config/`, which the mutation sandbox does not copy.
The pack's line ranges were corrected later: code added above them had moved the statements they name
(the candidate filter, the cut and the log now sit at lines 199-201, the sections block and the list of
routes left out at 238-247), so the ranges had come to mutate other lines of the pack. The After column
is the re-run over the corrected ranges (2026-10-06, default workers, 87 mutants, 24 of them compile
errors): no survivors. The sections block now also holds the row of the pages a redirect reached, and
its mutants are killed too.

redirect-advisory (2026-10-06, default workers) is a new preset over the lines that say why a route
degraded and where a redirect led (`route-catalog.ts`: the degrade reasons, the redirect target, the
catalog and the two log warnings; `dom-snapshot.ts`: the state line of a degraded route, the advisory
block and the capture that joins it to the grounded routes) and the split that keeps the block out of
the pack's live DOM section (`context-pack.ts`), run against their own tests. **Before** is its first
run: 173 mutants, 38 of them compile errors, 127 killed and 8 survived. All 8 are string literals: the
separator between the routes a warning, a note or the advisory block names, the one between a degrade
reason and the path it names, the one that tells two lists of nodes apart in the key that groups the
routes reaching one page, the one between several advisory sections of a split capture, and the default
of the first part of that split (a split always yields one part). No test pins them and none is
triaged yet, so none is listed as a documented survivor. **After** is pending that triage.

| Preset | Module(s) | Before: killed / timeout / survived — score (killed-only) | After: killed / timeout / survived — score (killed-only) | `break` |
|---|---|---|---|---|
| keystone | objective-signal decide/assemble/render | 108 / 5 / 4 — 96.58% (92.31%) | 112 / 1 / 0 — 100% (99.12%) | 80 |
| rule-learning | rule-governance.service, rule-fold | 117 / 4 / 7 — 94.53% (91.41%) | 114 / 0 / 0 — 100% (100%) | — |
| fix-loop | fix-loop.aggregate | 184 / 2 / 15 — 92.54% (91.54%) | 186 / 4 / 10 — 95% (93%) | — |
| coordination | acceptance-report, pushback, orchestration-router, delegation-failure-class | 199 / 20 / 11 — 95.22% (86.52%) | 252 / 1 / 3 — 98.83% (98.44%) | — |
| merge-guard | src/server/merge-guard.ts | 258 / 6 / 12 — 95.65% (93.48%) | 314 / 2 / 5 — 98.44% (97.82%) | — |
| coordination-events | src/server/coordination-events.ts | 156 / 13 / 16 — 91.35% (84.32%) | 132 / 8 / 1 — 99.29% (93.62%) | — |
| local-login | src/server/auth.ts (local-login policy range) | 63 / 2 / 4 — 94.2% (91.3%) | 59 / 0 / 0 — 100% (100%) | — |
| write-confinement | write-confinement.service | 149 / 14 / 20 — 89.07% (81.42%) | 147 / 17 / 19 — 89.62% (80.33%) | — |
| run-decision | run-decision.service, run-decision | 31 / 0 / 2 — 93.94% (93.94%) | 27 / 0 / 0 — 100% (100%) | — |
| agent-efficiency | tool-call-taxonomy, call-sequence, provided-context, step-exhaustion, coarse-run-efficiency, turn-efficiency-summary, call-efficiency-tracker, call-fingerprint | 226 / 7 / 55 — 80.9% (78.47%) | 306 / 14 / 0 — 100% (95.63%) | — |
| generation-end | generation-end, generation-end-terminal, learning-gates | 68 / 0 / 11 — 86.08% (86.08%) | 73 / 0 / 0 — 100% (100%) | — |
| precondition-verdict | auth-precondition, precondition-terminal, error-class (class entries and resolution), process-audit (precondition finding) | 4 / 0 / 1 — 80% (80%) | 9 / 0 / 0 — 100% (100%) | — |
| login-evidence | login-evidence (classifier, scrubber, note) | 79 / 0 / 21 — 79% (79%) | 141 / 0 / 0 — 100% (100%) | — |
| route-capturability | route-capturability, the context pack's candidate filter and list of routes left out | 67 / 0 / 15 — 81.71% (81.71%) | 63 / 0 / 0 — 100% (100%) | — |
| redirect-advisory | route-catalog (degrade reason, redirect target, warnings), dom-snapshot (state line, advisory block, capture), the context pack's split of the advisory block | 127 / 0 / 8 — 94.07% (94.07%) | — | — |
| patch-app-yaml | patch-app-yaml | 181 / 2 / 42 — 81.33% (80.44%) | 203 / 0 / 1 — 99.51% (99.51%) | — |
| prompt-contract | prompt-contract-lint, regen-turn, diff-stat, harness-facts, the fixtures reader | 259 / 5 / 60 — 81.48% (79.94%) | 491 / 6 / 4 — 99.2% (98%) | — |

### Login discovery script (manual triangulation)

The discovery child (`login-discovery.script.ts`) and the in-page readers (`login-discovery.page-readers.ts`)
are generated source, so no preset can mutate them. They are triangulated by hand instead: each behavior
is broken in a scratch copy of the tree (never the repository) and the discovery tests must fail. The
last full run covered the origin checks, request attribution, the submit event and exception signatures,
the wait for a login in flight, the session check and its deadline, the scrub of every text that leaves the
child, and the captcha rule; every mutant was killed except the two equivalents listed under the
documented survivors. Every survivor of an earlier pass was killed with a behavior test, not by
asserting a literal. The request attribution was re-run alone after it began to need the password (a
user name is often short or common, so a request that only names the user is the app's own traffic):
18 mutants, all killed. The one survivor of the first pass of 17 was a redundant early return for an
unattributed GET, which the list's own guard made unobservable; it was restructured away.

### Documented survivors

Each is a genuine equivalent mutant: no test can observe it without asserting the mutated literal.

**patch-app-yaml** (`src/server/onboarding/patch-app-yaml.ts`)
- `alreadyReads` — the `catch` block emptied (BlockStatement): a placeholder whose variable is unset
  reads as no value, and a callback that returns nothing is read the same by `some`.

**login discovery script** (`login-discovery.script.ts`, triangulated by hand)
- `submitOnce` — the guard `submitCount >= 1` → `>= 2`: the ladder stops at the first login form, so a
  second submit cannot be reached; the guard stays as defense in depth.
- `watch` — the console error's phase read when its answer arrives instead of when it was raised: the
  child waits for every pending answer before it switches to the after-submit phase, so no answer can
  arrive in the wrong phase.

**prompt-contract** (the fixtures reader in `pre-generation-grounding-port.adapter.ts`)
- the skip reasons of `readFixtureFacts` — `"not a regular file"`, `` `larger than ${MAX_FIXTURES_FILE_BYTES} bytes` ``
  and `"no exports found"` → `""` (StringLiteral ×3): the warning still names the fixtures file and the
  run still yields no fixture facts; the reason is log text.
- `readFixtureFacts` — the `finally` block that closes the descriptor emptied (BlockStatement): a
  leaked descriptor is not observable from a test.

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
