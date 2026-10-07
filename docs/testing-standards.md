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

## Named pipes

A test that makes a named pipe, to show that code leaves it alone, must not be able to hang. Opening a
pipe for reading waits for a writer, and a thread waiting inside a system call cannot be timed out from
the test it runs on (the timer that would do it runs on that thread), so a run against code that does
open the pipe, such as a test written first and run against the code it replaces, or a regression, would
never end and its process would stay behind. Run the call under
`withoutWaitingOnNamedPipe(path, run)` (`qa-engine/test/support/named-pipe-watch.ts`): a second thread
opens the pipe for writing, without waiting, as soon as anything has it open for reading, which releases
the reader and records that it was there, so the test fails on its assertion within a fraction of a
second. The code under test is protected in its own right: it opens a path an agent can plant with
`O_NONBLOCK`, as the confined reader does, or judges it by lstat before opening it, so a single
regression does not block either. Skip a pipe case, and say why, where `mkfifo` is missing. Anything that
kills a test command (a RED probe, a hand-mutation script) runs it through `scripts/run-in-group.mjs`,
so that the file processes `node --test` starts die with it.

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

spec-path-confinement (2026-10-07, 3 workers on a loaded machine, 71 mutants, 34 of them compile errors)
is a new preset over the one reader of a path an agent reported: the real-path anchor on the mirror, the
refusal of a symlinked spec directory and of one that leaves the mirror, of an empty, absolute or
parent-bearing path, of a symlink or a path that leaves the spec directory, of a directory or a named
pipe, the size cap and the descriptor a read releases. It runs against its own tests and the tests of the
three sites that read a delivered spec through it (the generation port's reader for Lever-2, the
reviewer's inlining and the review DOM grounding). **Before** is its first run: 36 killed, 1 survived, and
the survivor was a real gap: the reason given for a spec directory that cannot be resolved was never read
by a test, because the test that tells the reasons apart did not exercise that class. It does now.
**After** is the re-run: 37 killed, no timeouts, no survivors. What Stryker does not mutate here (the
conditions of the ternaries, the call that drops a trailing separator, which backslashes are replaced, the
separator of the prefix check, the arguments of the two containment checks, the open flags, and what each
site passes as the root) was broken by hand, 24 mutants: 14 of the module and 10 of the wiring at the
sites. 21 died and 3 survived (the one on the open flags is killed since, as the next paragraph says; the
other two are documented below). The first batch showed one real gap: a review DOM adapter
anchored on its spec directory instead of the mirror survived all its tests, because every case that left
the mirror did so through a symlink in the last segment, which a separate rule refuses. Each site now has
a case that leaves the mirror through a symlinked parent, and the composition root has one that reads
through the adapter it wires. Two more were found by reading the code rather than by a mutant, and each
has a case: a path with a trailing separator makes lstat follow a symlinked spec directory, so the
separator is dropped first, and a path with two backslashes must have both read as separators, not only
the first.

The preset was then widened (2026-10-07, 3 workers on a loaded machine, 126 mutants, 57 of them compile
errors) when the reader's descriptor was tied to the file it validated and three more sites went through
it; a review of that found a window that stayed open and a read that could truncate. O_NOFOLLOW covers
only the last component, so a directory above the file swapped for a symlink between the check and the
open made the open read a file outside the spec directory: reproduced against the earlier reader, which
returned the outside file's bytes. The read now opens through a seam (the open, the judgement of the
descriptor, the read, and the kernel's own path of the descriptor), validates the path again after the
open, and requires a regular file whose device and inode are those of the file validated before the open
and of the one validated after it. That is not enough against a process that loops: each lstat follows
the directories above the file, so an attacker that alternates the path between two states can have the
realpath see one state and the lstats, the open and the second look the other, and every identity then
agrees on a file outside the spec directory. A scripted run of exactly that interleaving returned the
outside file's bytes from the reader that had only the identities, and still returns them where there is
no kernel path. Where there is one (Linux, through procfs) the descriptor's own path must lie inside the
spec directory, which no walk of a path can fake, and the same run is refused: for every file the agent
cannot move into the spec directory, that is every file outside the volume it shares with the
orchestrator, the window is closed. Where Node cannot ask (macOS has no F_GETPATH) the identities are all
there is, and the window is narrowed to a process that flips the path at exactly the right instants, not
closed. The read is also a loop now, up to the size judged on the descriptor, and a file that ends
earlier is refused as a short read instead of being returned truncated. The preset gained the seam tests,
which make each swap and each partial read at the seam with real files, and the tests of three more
sites: the manifest's file hashes, the sidekick's claimed files and the pre-exec capture (it still
mutates only the reader). **After** is this run: 66 killed, 3 timeouts and no survivors, so the table's
row is it; the timeouts are the infinite-loop mutants of the read loop (its body emptied, and the test
for the end of the file disabled or inverted). 49 mutants were broken by hand (the new conditions and
flags, the earlier ones against the new code, and the wiring of the three sites): 48 die and 1 survives,
documented below. A second one survived the first batch, a kernel-path check judged against the whole
mirror instead of the spec directory, because the paths the cases gave as the kernel's answer were spelled
through os.tmpdir(), behind a symlink on macOS, and were refused for their spelling and not for lying
outside; they are built from real paths now, and one case puts the kernel's answer inside the mirror and
outside the spec directory. The open flags are no longer survivors: one test records the flags the open
receives, and the case that swaps a named pipe in checks the non-blocking flag before it puts the pipe in
place, so that a reader that would wait on it fails there instead of hanging the run. The Linux branch
cannot run on the machine that recorded these results: the factory that builds it is tested with an
injected readlink on every platform, and two cases that open real descriptors (the kernel path is the
real path; a real swap is refused for it) are skipped off Linux and run in CI.

The preset was widened once more (2026-10-07, 3 workers, 361 mutants, 188 of them compile errors) for the
files the orchestrator keeps in the spec directory. The manifest, `.qa/manifest.json`, is its own file in a
directory the agent writes into, and everything that reached it followed whatever had been planted there.
`reconcileManifest` checked, read, made the directory and wrote with calls that follow links, so a symlink at
the file made the write replace any file the orchestrator can write (reproduced against the earlier code: a
file outside the mirror came out holding the manifest) and one at `.qa` put the manifest in a directory of
the agent's choosing; `readManifest` returned what a link pointed at and opened a named pipe, which waits for
a writer that never comes; the read gate's manifest check did the same and, since its output goes back to the
agent as validation feedback, quoted the first characters of the linked file in its JSON error; and the
listing of the existing specs followed a symlinked directory, so it listed names outside the spec directory,
listed one twice and ran away along a link back up (fifteen levels in the reproduction). The module gained a
strict read and a strict write for such files. The path is walked one lstat at a time, so no link anywhere
below the spec directory is followed whatever it points at, and the file is a regular file or absent; the
bytes then come through the confined reader, so a swap after the check is refused too; and a write goes into
a temporary file made exclusively and without following a link, in the same directory, and is renamed over
the target, which replaces a link and never writes through another name for the same inode. Where the
platform can say where a descriptor is, the temporary file must be there, the path is walked again once the
file exists, and what was made is removed on every failure, a failure to close its descriptor included: the
close is part of the write seam, and one that fails neither skips the removal nor replaces the failure in
flight, and a file whose close failed is removed, never put in place. What an interrupted write leaves in
`e2e/.qa` is kept out of the publish, which stages the whole `e2e/` tree (a test with a real repository and
the real writer shows it). A manifest that cannot be read strictly is no
manifest, said aloud, for a read; the write throws instead of merging into it or replacing it. The preset
now also mutates the manifest's file hash, load, read and write, the read gate's manifest check and the
listing, against their own tests and the new ones, which use real links, a real second name for an inode,
real pipes and real directory modes, and make each swap themselves at the seam of the write. **Before** of
this widening is its first run: 389 mutants, 166 killed, 3 timeouts and 23 survivors, and they were real
gaps. A path that cannot be examined (a directory whose mode forbids the search) was never exercised, so the
reason of its refusal and its difference from an absence went unread. The second look of a write was never
shown to make nothing, nor to compare the directory it finds with the one it validated (an ancestor of the
spec directory swapped for a link to another directory of the mirror). A refusal was never required to say
anything, and neither was the gate's output, nor to put each violation on a line of its own. An entry of an
on-disk manifest that has no id, or is not an object, was never shown to be dropped when the manifest is
rewritten. Machinery that no input could tell from nothing was removed instead of covered: the filter of
empty and dot segments of a path (`join` drops them), the look at a link before a directory (by lstat a link
is neither one), the look again after a directory is made, the refusal of an unreadable directory above the
file (the file's own check refuses the same path for the same reason), and a catch whose empty body returned
what the function returns anyway. **After** is the re-run: 161 killed, 12 timeouts and no survivors, so the
table's row is it. Three of the timeouts are the infinite-loop mutants of the read loop, as before; the other
nine are mutants of the walk that outran the time limit on a loaded machine (the limit follows the dry run,
and other work started after it), and each of them is killed when its tests run alone. 45 mutants of what
Stryker does not produce (the flags and the mode of the temporary file, the arguments handed to the seam, the
second look, the close, the cap, the pattern that keeps a temporary file out of the publish, and the wiring of
the manifest, the gate and the listing) were broken by hand. The first batch left
three alive and each was real: the write of the manifest through a followed path survived because the strict
read refuses every plant before the write is reached, so only a second name for another file's inode tells
the two apart (a test with a real hard link does now); a listing that aborts on a directory it cannot read
(a test with a real mode does now); and a branch of the write that only a directory vanishing between its
creation and the next look could reach, which the walk no longer has (a walk that makes the directories finds
none absent, and its type says so). With them all 45 die. Tests that make named pipes run under a watch (see
Named pipes), and a preset run and the hand mutants run in their own process group.

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

The lint then gained four single-source facts (the step limit, the listing of the existing suite, the
learned rules and the exemplars) and the artifact references that point at them (2026-10-06, default
workers, 745 mutants, 244 of them compile errors): 491 killed, 6 timeouts, 4 survivors, the same four
documented below, and none in the lint. A fact id and the step-limit section id are typed as facts, so
the mutants that empty them cannot compile and there is no wording to pin. The table of artifact
references is not in the preset, so it was broken by hand against the lint's tests, together with the
builder's listing guard, its three provider claims and the guard on the manual suite read, against the
builder's: 53 mutants (a pattern short of a word, a flag, a boundary or an alternative, or matching more
than it should; a provider swapped; a fact dropped from the single-source list; the facts-only rule made
blind to fenced text). The first tests killed 51. The two that survived were the case-insensitive flag of
the suite-listing and exemplar patterns, because no phrase of theirs began with a capital; each now has
one, and both are killed.

The lint then learned that a structural signal with symbol blocks is the blast radius (R3 counts it as
meeting a read or an orientation of it, never a consult) and gained a fact of its own for the
co-change files a signal can hold alone (2026-10-06, default workers, 753 mutants, 249 of them compile
errors, 17 minutes on a loaded machine): 494 killed, 6 timeouts, 4 survivors, the same four documented
below, and none in the lint (298 killed, 1 timeout). The equivalence is one table that only R3's read
and orientation branch reads, so its mutants die on what it must not do: a consult is not met by the
signal, co-change files meet nothing, the table is one way, and a section that provides both facts is
reported once per provider. What decides whether a prompt claims a blast radius sits outside the
preset, so it was broken by hand against its own tests, 87 mutants in all: the builder's (the flag
read as always or never true, or true without a signal; the claims swapped or unframed; grounding by
the old rule, by the brief alone, by the signal alone or by both; the lookup's text and its claim
ungated, dropped or inverted; a signal rendered beside a brief's blast radius), the renderer's (the
title, the introduction and the truncation marker of each shape taken always, never or swapped;
call-graph or blast-radius words in the co-change introduction; the symbol predicate read from one
list or with the co-change files counted), the reference table's and the artifact names' (the name of
the co-change block included), the flag's two hops from the port to the prompt input (never sent,
always sent, sent as false, sent without its signal), the symbol predicate's (the wrong connective,
either list alone), the provider claims of the listing, the exemplars and the rules, and the matrix's
(each condition of the co-change shape, the flag, the bucket). Five survived at first. Three were real
gaps: the lookup's text was gated by nothing a test could see, only its claim (two mutants), so the
size of the task now has to follow the grounding; and the heading constant of the listing could be
renamed without a test noticing, so it is pinned to the id of its section. The other two are
equivalents of code outside any preset and are not on the list below: the adapter's symbol flag read
from the impacted list alone (callers are only queried for an impacted anchor, so the two lists cannot
differ), and the matrix's exclusion of any signal from the context run (the co-change shape is already
limited to diff runs).

A review of the first version found that a block of co-change files alone was still titled "Structural
blast radius" and introduced as derived from the call graph: words a model reads as a finished
exploration, in a prompt whose claims keep the lookup, and block text the lint cannot see. The block
now carries a title and an introduction of its own and a truncation marker that names the co-change
list; the rendering of a block that names symbols is byte-identical (1,440 inputs compared with the
earlier renderer). The lint source is unchanged, so the preset run above stands, and the 18 mutants of
the new code all died on the first run.

The scope budget of a diff first pass then learned the effort its size asks for (2026-10-07, default
workers, 770 mutants, 254 of them compile errors, 12 minutes on a loaded machine): 506 killed, 6
timeouts, 4 survivors, the same four documented below, and none in the diff size (43 killed, 8 compile
errors) or in the lint. A change is tiny, focused or broad by two named limits that `diffTier` reads, so
its mutants die on the boundary tests: a change at both limits, one file or one line past either, each
limit on its own, the two sides of a change counted together and an empty diff. What the prompt then
carries sits outside the preset, so it was broken by hand against its own tests, 49 mutants in all: the
tier taken as always tiny, focused or broad, dropped, or read from a size that ignores the reported
files, the diff's lines, the changed lines or the file count; the read of the existing specs ungated,
always dropped or inverted, and its claim ungated, dropped, inverted, aimed at another fact or turned
into a consult; the bound to the affected pages dropped, gated by the map, the blast radius or the
listing, reverted to a verb of exploration or given a navigate directive; the authoring-skill line
restored; the conventions read of a code run taken always, never, or dropped by one regeneration signal
only, with the framework detection dropped beside it; and the effort data (a zero or fractional ceiling,
a text with a figure, a directive word, a trust word or a minimum, a tier that does not admit the no-op,
two tiers saying the same, the no-op clause or the ceiling's lead dropped or reworded, a claim declared
for one tier only). The count is 49 because the first batch of 43 was followed by a second of six,
written for the fixes it prompted: the no-op clause and the ceiling's lead turned into a floor or a
neutral word, the clause reworded, a text that states a minimum, and a regeneration that keeps only the
match clause. The first batch left five alive. Three shared one real gap: the bound gated by the map,
the blast radius or the listing survived because the pins ran only on prompts that supplied none of
them, so a loop now builds the prompt with each, and with all at once. One was the no-op clause of one
tier's text drifting from the data that declares it, so the three texts are built from one clause that
the test imports, and pins hold its wording and the ceiling's lead. The last was the words that follow
the conventions read, which got a pin of their own. All 49 die after those changes.

A review then found that, with a listing, the diff task no longer mentioned reading the one spec a run
updates (the listing carries paths, a flow and an objective, never a spec's content). Protocol 2 of the
shared layer now says to read the existing spec before it updates it, nine bytes more in each static
layer, recorded as a raise. A pin holds it once per runtime in the shared layer, and a test holds it in
that protocol in both mirrors; its four mutants (the read dropped in either mirror, reworded, or stated
a second time in the generator role) all die, which makes 53 hand mutants for the slice. The diff
size's tiers count raw files and changed lines, so generated files and lockfiles inflate a tier and a
one-line change can have a wide blast radius: a limitation declared beside `DIFF_TIERS`, and harmless
because a tier is only an upper bound on the effort and always admits the no-op.

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

The preset was then extended (2026-10-07, 4 workers) with `route-ranking.ts` whole, which decides which
of the map's routes the changed files point at (the three link fields, how a declared path meets a
changed file, and the staged roots of a cross-repo run), and with the lines of the pack that call it,
run against the ranking's own tests and the pack's. **Before** is its first run: 211 mutants, 68 of them
compile errors, 137 killed and 6 survived. Four were gaps in the tests: the filter that drops a changed
file naming nothing (three mutants: every route of the fixture was linked alike, so promoting all of
them left the order as it was, which no assertion could see) and the default of the routes input (a
stray route is dropped as free text before the cut, so only the list of routes left out and its log show
it; the first test written for it looked at the capture alone, and the re-run showed it still survived).
Two were default empty arrays no test could tell from any other value, so they were restructured away:
the list-of-paths guard has no fallback list now, and the pack skips the ranking when there are no
changed files. **After** is the re-run once those were fixed: 209 mutants, 67 of them compile errors, 142
killed, none survived or timed out. A review then found three things in the ranking, each given a failing
test before its fix: across repos a route's own files and its declaring source ranked it when they lay
under a staged root, though they belong to the other repo; a path the map lists twice kept only its last
entry, so a bare later one erased the links of an earlier one; and a changed file or staged root that was
not text threw. The re-run after those fixes: 215 mutants, 66 of them compile errors, 149 killed, none
survived or timed out.

redirect-advisory (2026-10-06, default workers) is a new preset over the lines that say why a route
degraded and where a redirect led (`route-catalog.ts`: the degrade reasons, the redirect target, the
catalog and the two log warnings; `dom-snapshot.ts`: the state line of a degraded route, the advisory
block and the capture that joins it to the grounded routes) and the split that keeps the block out of
the pack's live DOM section (`context-pack.ts`), run against their own tests. **Before** is its first
run: 173 mutants, 38 of them compile errors, 127 killed and 8 survived. All 8 are string literals: the
separator between the routes a warning, a note or the advisory block names, the one between a degrade
reason and the path it names, the one that tells two lists of nodes apart in the key that groups the
routes reaching one page, the one between several advisory sections of a split capture, and the default
of the first part of that split (a split always yields one part). They were triaged on 2026-10-07 (4
workers), after the pack's lines moved and the preset's ranges were re-anchored: a run before any test
changed reproduced the same 173 / 127 / 8 / 38. Two were behaviors and got tests: the key that groups the
routes reaching one page now has a pair of trees that read alike once their nodes are joined without a
separator, and the pack's split has a capture with two advisory sections that must come out as they
went in. The other six are the separators of log and prompt text and the default no split can read, and
are listed under the documented survivors. **After** is the re-run: 173 mutants, 38 of them compile
errors, 129 killed, 6 survived (all documented), none timed out.

step-limit (2026-10-07, default workers, 73 mutants, 26 of them compile errors, 45 seconds) is a new preset
over the lines that read a step limit and the lines that route it: `enforcedStepLimit` (a safe positive
integer, else none), the agent-list read of `listAgentCaps` (the request for a directory, the order of a
cap's two names, what a failed read or a reply that is no list throws), the two lines of the baked config
reader that choose between the same two names, the OpenCode strategy's mapping of each role to its agent
with the warning for a role left without a limit, and the two facades' routing of each role to the provider
it is assigned to. It runs against their own tests and the config reader's; the agent-list read is driven
through the real v2 SDK client with only the network faked. **Before** is its first run: 43 killed and 4
survived, all four in what a failure or a warning says rather than in what it decides: the text for a role
listed without a cap (dropped, or told as an unusable cap) and the status of a failed reply (made up for a
reply that never came). Each is data a test can pin, so none was listed: the warning carries its agent's
name and never a value for a missing cap, and a read that never got a reply carries no status. **After** is
the re-run; it has no documented survivors. The compile errors are mutants the type system refuses, such as
a dropped optional chain on a value that can be absent. Nothing else of the slice is outside the preset
except the wiring that picks the real read when no test supplies one, a deliberately uncovered boundary
(it would reach the network).

The preset then took the per-run memo that hands each role its limit (2026-10-07, default workers, 85 mutants,
36 of them compile errors, one to two minutes): 48 killed, no timeouts, 1 survivor, documented below, and none
outside the memo (the 47 earlier mutants die again). The memo is the one read of a run's directory that every prompt of the run
shares, with its deadline and its one warning. Stryker reaches little of it: the role table, the signatures and the
blocks are typed, so most of its mutants do not compile, and it makes none for the choice between `??=` and `=`,
for a dropped call or for the deadline's number. Those lines, and the lines that carry the limit onward (the
generation port's, the review port's and the explorer's inputs, the in-generate reviewer's input, the composition
root's hand-over and the factory's wiring of the resolver and of the explorer), sit outside the preset and were
broken by hand against their own tests, 37 mutants in all, every one killed: the read made twice, held across runs
or started before anyone asks; a number that is no positive whole count passed on as a limit; the generator, the
reviewer and the explorer swapped, or each asked for another's limit; the deadline doubled or halved; another
directory read; the warning dropped, or without its directory or its cause (an `Error`, or any other value thrown);
a resolver composed for a host with no facade, or its key left in when absent; the explorer given no resolver, or
resolving its limit after its session is open; each input's limit dropped, or left as a key with no value; the
reviewer's limit put on the generator's field; and the reviewer's limit asked for by a generation that runs no
reviewer. The memo's own tests sit in a file of their own, apart from the factory's whole test file, which would
run once per mutant and not fit the mutation timeout.

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
| spec-path-confinement | spec-path-confinement (the reader of an agent-reported path, the strict read and write of the orchestrator's own files), manifest-fs (file hash, load, read, write), the read gate's manifest check, the listing of the existing specs | 36 / 0 / 1 — 97.3% (97.3%) | 161 / 12 / 0 — 100% (93.06%) | — |
| run-decision | run-decision.service, run-decision | 31 / 0 / 2 — 93.94% (93.94%) | 27 / 0 / 0 — 100% (100%) | — |
| agent-efficiency | tool-call-taxonomy, call-sequence, provided-context, step-exhaustion, coarse-run-efficiency, turn-efficiency-summary, call-efficiency-tracker, call-fingerprint | 226 / 7 / 55 — 80.9% (78.47%) | 306 / 14 / 0 — 100% (95.63%) | — |
| generation-end | generation-end, generation-end-terminal, learning-gates | 68 / 0 / 11 — 86.08% (86.08%) | 73 / 0 / 0 — 100% (100%) | — |
| precondition-verdict | auth-precondition, precondition-terminal, error-class (class entries and resolution), process-audit (precondition finding) | 4 / 0 / 1 — 80% (80%) | 9 / 0 / 0 — 100% (100%) | — |
| login-evidence | login-evidence (classifier, scrubber, note) | 79 / 0 / 21 — 79% (79%) | 141 / 0 / 0 — 100% (100%) | — |
| route-capturability | route-capturability, route-ranking (link fields, path matching, staged roots), the context pack's ranking call, candidate filter and list of routes left out | 67 / 0 / 15 — 81.71% (81.71%) | 149 / 0 / 0 — 100% (100%) | — |
| redirect-advisory | route-catalog (degrade reason, redirect target, warnings), dom-snapshot (state line, advisory block, capture), the context pack's split of the advisory block | 127 / 0 / 8 — 94.07% (94.07%) | 129 / 0 / 6 — 95.56% (95.56%) | — |
| patch-app-yaml | patch-app-yaml | 181 / 2 / 42 — 81.33% (80.44%) | 203 / 0 / 1 — 99.51% (99.51%) | — |
| prompt-contract | prompt-contract-lint, regen-turn, diff-stat, harness-facts, the fixtures reader | 259 / 5 / 60 — 81.48% (79.94%) | 506 / 6 / 4 — 99.22% (98.06%) | — |
| step-limit | step-limit, the agent-list read and the baked reader's two names (opencode-client), the OpenCode strategy's limits and warning, the facades' limits, the factory's per-run memo | 43 / 0 / 4 — 91.49% (91.49%) | 48 / 0 / 1 — 97.96% (97.96%) | — |

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

**redirect-advisory** (`route-catalog.ts`, `dom-snapshot.ts`, the split in `context-pack.ts`)
- `splitRedirectSection` — the default of the first part of the split, `""` → another string
  (StringLiteral): a split always yields at least one part, so the default is never read.
- `degradedRouteWarning` — the `" "` between a degrade reason and the path a redirect led to, and the
  `", "` between the routes the warning names (StringLiteral ×2): every route, reason and path is still
  named; the separator is log text.
- `gatedAppAdvisory` — the `", "` between the routes that reached a page and the `"; "` between the
  pages the note names (StringLiteral ×2): the same, log text.
- `formatRedirectAdvisory` — the `", "` between the routes a block says were asked for (StringLiteral):
  every route is still named; the separator is wording, not data.

**step-limit** (`src/server/rewritten-engine-factory.ts`, the per-run memo)
- `readStepLimits` — the label of the deadline's message, `"step limit read"` → `""` (StringLiteral): the
  warning still names the directory, the deadline and the cause; the label is log text.

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

**spec-path-confinement** (`spec-path-confinement.ts` and the composition root's wiring, broken by hand: Stryker generates no mutants for some of what it holds, and the wiring is outside the preset)
- `readConfinedSpecBytes` — the check that the second look found a file (`!("file" in rechecked)`)
  removed: it does not compile, because the identity is read from a result that is a union, and at run
  time the operand after it refuses on the same input, since a refused look has no identity for the
  descriptor's to equal.
- the composition root's review DOM grounding anchored on the e2e directory instead of the mirror: the
  only target that builds that adapter is the e2e one, whose spec directory is that directory, so both
  anchors name the same place.

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
