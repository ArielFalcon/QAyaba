# RFC-0003: Harvest coverage dumps off the event loop (H06)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Implementation:** work unit 1 (the harvest) landed on `fix/root-cause-t5` and was integrated on the root-cause branch as `59196a16` (picked from `147ff534`), 2026-10-30, with its verifier's correction `1e962563` (loader flags only, a typed executor failure) and checkpoint 3's `86f903e3`; its replicate ran (`run-ed28973-mvv7lrgu-65aff66e` on b900bc7e, feature document L28); work unit 2 (the read) landed on `fix/root-cause-t5u2` and was integrated, 2026-10-30.
- **Code references at 4105c582:** `qa-engine/src/contexts/test-execution/infrastructure/run-dump-bridge.ts`, `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts`, `qa-engine/src/shared-infrastructure/run-output-reader.ts`, `qa-engine/src/contexts/objective-signal/domain/dump-sanitizers.ts`, `qa-engine/src/contexts/objective-signal/infrastructure/coverage-dump-reader.ts`, `qa-engine/src/contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts`, `qa-engine/src/contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts`, `qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts`, `qa-engine/src/contexts/test-execution/infrastructure/observation-reader.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/run-flow.ts`, `src/server/run-engine-factory.ts`, `src/telemetry/host-health.ts`, `config/e2e/fixtures.ts`, `AGENTS.md`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0005](../adr/0005-coverage-enforce-activation.md), [ADR-0006](../adr/0006-bundle-mutation-switch.md), [ADR-0007](../adr/0007-code-target-removal.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0002](./0002-platform-steps-0-1.md), [Rejected explanations](../rejected-explanations.md)

## Summary

1. The orchestrator sanitizes and re-parses every V8 coverage dump on its single event loop: `harvest()` returns `void` and runs inside the child's `close` handler, and `readV8Coverage` is `async` with no `await`.
2. Cause H06, confirmed by an independent refutation (the growth with each feature and the magnitude per byte stay hypothesis): 72 stall events on run root spans (63 distinct stalls of 1.0 to 10.6 s) in 18 runs; 56 of the 63 align with coverage executions, and 0 of 192 `run_spec` executions (coverage off) stall.
3. Main patched the evidence starvation (`11d111db`, one check time per dump kind) and not the stall: four later runs on the same code show 6 to 13 events and up to 10,863 ms.
4. Proposal: run the two pure CPU steps (sanitize on harvest, parse on read) in a per-call worker thread behind an async seam, harvest first and read second; the byte caps stay as the bound on one dump. O4 (skip coverage on the unmutated `-obs`/`-obs2` re-runs) is not proposed: its risk to the paired-run comparison is unchecked.
5. This reopens the decision of `48f26eaa` (a worker thread was rejected); the owner decides that and four smaller forks, listed at the end.

## Problem

### The causal chain, checked at 4105c582

| # | What happens | Where |
|---|---|---|
| 1 | Every suite execution carries coverage except the ones that count writes. `PW_COVERAGE` is set to `"0"` only inside `countWrites`, which only the closed loop (`run_spec`) passes. The mutation re-runs, including the observation re-runs `-obs` and `-obs2`, are wired without it. | `e2e-execution.runner.ts:943`, `closed-loop-port.adapter.ts:279`, `run-engine-factory.ts:1001-1002`, `bundle-mutation-oracle.adapter.ts:66,113` |
| 2 | The seed fixture turns coverage on unless `PW_COVERAGE` is `"0"` and writes one whole dump per test, with every script's source map attached. | `fixtures.ts:219,235,240` |
| 3 | When the child closes, the handler reads the report and then calls `closeDumps(!settled && !stopping)`, which calls `dumps.harvest()` on the same stack. | `e2e-execution.runner.ts:990-993`, `e2e-execution.runner.ts:924-928` |
| 4 | `harvest()` is typed `void`. For each dump kind it scans the folder, and for each file reads it, runs `sanitizeV8Dump` (`JSON.parse`, rebuild, `JSON.stringify`) and later writes it, all synchronously. | `run-dump-bridge.ts:53`, `run-dump-bridge.ts:111-143`, `run-output-reader.ts:59-75`, `dump-sanitizers.ts:18-27` |
| 5 | Each measurement then calls `readV8Coverage`, declared `async` but with no `await` in the file; it `JSON.parse`s the same bytes again and decodes them. The adapter already awaits it, so the asynchronous seam exists. | `coverage-dump-reader.ts:33,43-57`, `v8-browser-coverage.adapter.ts:50` |
| 6 | The only bounds are a byte cap of 96 MiB per dump and two wall-clock budgets of 10 s, each read between dumps. Neither interrupts a dump in flight, and nothing bounds how long the loop is held. | `dump-sanitizers.ts:6`, `run-dump-bridge.ts:26,124`, `coverage-dump-reader.ts:17,35-42` |
| 7 | HostHealth sees the block only afterwards: a 5 s heartbeat that arrives more than 2 s late, or a 10 s delay sample whose maximum is over 1 s. | `host-health.ts:20-26`, `host-listeners.ts:47`, `run-trace.ts:166` |

The chain was re-read at 4105c582 and held at each step. Line numbers differ from the refutation, which read older heads: `harvest()` is called at `e2e-execution.runner.ts:928`, and the budget start is at `run-dump-bridge.ts:117`, inside the per-kind loop (see "Why main's patch is not the fix").

### What the runs show

`#N` is the investigation's run number, in timeline order. Epoch heads are the checkout a run loaded. Event counts and maxima were recounted from the history database (`run_spans`, events named `event_loop_blocked` on the `qayaba.run` span). The per-stall alignment comes from the independent refutation of H06.

| Run | Code head | Root events | Longest | What the raw spans show |
|---|---|---|---|---|
| #10 `run-ed28973-mvpnptj0-f49cfd71` | 94f2b45e | 4 | 3,290 ms | First run with a stall. One block of 3.26 s from the end of a suite execution to the start of the first mutant execution. |
| #14 `run-ed28973-mvptrv69-d4f52b7e` | f96f958f | 2 | 5,528 ms | A 3-test coverage-phase execution ends; the block starts within 3 ms of that end, and the measurement ends 5.5 s after it. |
| #20 `run-ed28973-mvqb6uob-69a66ac0` | f96f958f | 5 | 8,884 ms | The time from the execution end to the next recorded span is 8,873 ms. |
| #24 `run-ed28973-mvr4s6br-7cfce5f0` | 27238792 | 9 | 7,877 ms | 6 of 7 distinct stalls aligned with a coverage execution. |
| #26 `run-ed28973-mvra9a3s-09df0987` | 58151b36 | 2 | 5,662 ms | A 17-test final suite execution ends; the block starts within 14 ms of that end. The run failed, so no measurement followed. |
| #29 `run-ed28973-mvrxb30p-ecfe944b` | bd1d2e46 | 11 | 10,603 ms | See the next paragraph. |

#29 ran the version with one budget shared by both dump kinds (`run-dump-bridge.ts:116` at bd1d2e46). The closure execution ended at 10:28:04.931Z. At 10:28:15.412Z the log says "the fault-injection dumps of this run: 5 file(s) not usable (its content could not be used ×5)", 10.48 s after the end and inside the block, and the log then reports the mutant as "reached no page" and "not judged" (`ce6ce2ac` later separated unreadable counters from a mutant that reached no page). The refutation reads this as the harvest of the coverage dumps spending the whole shared budget, so the five small counter files were never checked; the timing supports it. The survivor recheck of that run records `survivors_rechecked=2 judged=1 closed=0`.

Controls, from the refutation:

- 0 stalls in 192 `run_spec` executions (`PW_COVERAGE=0`), 93 of them with at least one test. The gap after the execution closes has a median of 5 to 6 ms.
- 68 of 71 coverage-carrying executions with at least one test are followed by a silent gap of at least 200 ms. Each of the 3 exceptions is a set in which the dump cap of that epoch (32 MiB; 96 MiB since `45d26244`, `dump-sanitizers.ts:6`) refused the large dumps and what was left to parse was small: #4 (2 tests, one file refused) 14 ms, #6 (5 tests, 4 files refused) 36 to 37 ms, #11 at 20:08:22 (one file refused) 10 ms.
  - `openDumpBridge` parses the files under the cap: the reader goes on to the next file after a refused one (`run-output-reader.ts:59-75`) and the set is left out only after the scan (`run-dump-bridge.ts:136-139`). The control therefore supports "the block follows the dumps actually sanitized", not "nothing was parsed".
  - Two measurements agree. #13, with one refused file among parsed ones, shows the other side: a gap of 851 ms and a root maximum of 878 ms, just under the 1 s threshold. In the refutation's probe, 5 dumps alone harvest in 396 ms and the same 5 plus one oversize file in 348 ms, and the set is left out.
- Dose by tests per execution (stall of at least 1 s): 4/12 for 1 to 3 tests, 16/23 for 4 to 8, 34/36 for 9 or more.
- Alignment: 56 of 63 stalls start near a coverage execution end or a measure start, against a chance level of 2.6% for the same window.
- Probe on the engine's own functions: 8 dumps of 153 MiB block the loop for 555 ms in `harvest()` and 937 ms in `readV8Coverage`, with a heartbeat gap equal to the call. For 8 dumps of 19.9 MiB the split is read 25 ms, sanitize 552 ms, write 27 ms in total, so the work is CPU-bound.

### The same code, after the window

The chain files have no commit between `40513c1e` and 4105c582, and `11d111db` is in both. These four runs therefore ran the chain code that main holds today.

| Run | Code | Events | Aligned with a Playwright execution end | `qayaba.host.event_loop.max_ms` |
|---|---|---|---|---|
| `run-ed28973-mvs0onsn-6ad17f30` | 40513c1e | 6 | 4 | 8,074 |
| `run-ed28973-mvs2ukug-c82da7be` | 40513c1e | 9 | 7 | 10,863 |
| `run-ed28973-mvs49h5y-acdab309` | 40513c1e | 13 | 10 | 7,348 |
| `run-ed28973-mvs7oo0f-17041c71` (the before) | 4105c582 | 9 | 7 | 5,662 |

Aligned means that a `playwright-test` execution of over 20 s ended between 10.5 s before the block started and 1.5 s after it (block start is the event time minus `blocked_ms`). The criterion can over-count (execution spans do not record whether coverage was on) and under-count (executions of 20 s or less are left out). The block in `mvs2ukug` of 10,863 ms starts at the end of a 162 s execution, and it is the longest in the history.

### Why main's patch is not the fix

`11d111db` moved the start of the budget inside the per-kind loop (`run-dump-bridge.ts:117`), with a test that the counters are no longer starved (`run-dump-bridge.test.ts:187,199`). That removes the evidence loss that #29 showed. It leaves the work on the loop and allows a 10 s harvest of one kind, a 10 s harvest of the other and a 10 s decode back to back. The two longest stalls in the history, 10,603 and 10,863 ms, sit just above the 10 s constants. Hypothesis: the budget, not the work, is the ceiling of the stall. `mvs2ukug` is consistent with the prediction that per-kind budgets allow more than the 10.6 s of the shared version, but it is one run and not a controlled test.

### What H06 does not explain

- 7 of the 63 stalls (1.1 to 3.1 s: #23 three times, #24 at classify, #27 to #29 at the lead's first turn) are not tied to coverage. Same class of cause, other site.
- The spread inside one code epoch: #27 and #29 ran the same chain; #27 stalled 1.0 to 2.1 s, #29 up to 10.6 s. Host CPU was not recorded, and dump bytes are not either, so "proportional to bytes" cannot be checked. Hypothesis: host CPU on 2 vCPUs shared with Chromium and the agents.
- Loop work that is not coverage evidence and runs after the unmutated re-runs: the parse of each `observed-*.json` (`observation-reader.ts:54,83`) and the comparison of the observations (`bundle-mutation-oracle.adapter.ts:112-122`). The alternatives refutation finds that the 10.36 s stall of #29 after `-obs` ends with `coverage.measure` and so includes this tail with the decode of a killed mutant's dumps. Goal 1 does not cover it.
- Any verdict, pull request or Issue. The longest stall is 10.9 s against run deadlines of tens of minutes. No change of verdict is shown.
- Which share of the 56 aligned stalls is harvest and which is decode. Probes put the decode at about 1.7 times the harvest for the same dumps (937 vs 555 ms), but the traces separate them in only a few runs (#14, #11).

### Why it matters

- **Evidence admission rides a wall clock that the work itself inflates.** In #29 a mutant went unjudged because of it. In `enforce` mode a refused measurement is `unknown`, and `unknown` never blocks (AGENTS.md), so host load can become a way past the gate. [ADR-0005](../adr/0005-coverage-enforce-activation.md) makes a trustworthy measurement a precondition of `enforce`. Evidence of the consequence: one run.
- **Each feature that adds a coverage-carrying execution adds a stall.** The refutation counts 4 to 5 such executions per passing 3-commit run in the epoch ending at f96f958f and 8 to 9 in the one ending at bd1d2e46. Range, models and limits changed too, so the growth is a hypothesis.
- **It is not an ownership defect.** The harvest, the reader and the caps each already have one owner. The decision that matters is where the work runs, taken in `48f26eaa` ("the smaller cap is the whole defense", a worker thread rejected), plus a clock inside synchronous work. The refutation classifies the family as mixed.

## Goals and non-goals

**Goals**

1. No coverage-evidence CPU work holds the loop. Measured as no `event_loop_blocked` event aligned with a coverage execution in the after replicate (HostHealth reports blocks of 1 s and more).
2. Every way the off-loop work can fail (deadline, heap limit, crash) has a typed outcome that leaves the set out through the existing path. None is swallowed.
3. The trust boundary stays where it is: confined reads and writes on the main thread, the set whole or nothing (`run-dump-bridge.ts:1-12`, `run-output-reader.ts:2`).

**Non-goals**

- Changing which evidence is admitted: the caps and the whole-or-nothing rule stay.
- Making dumps smaller at the source, changing verdicts, or the 7 non-coverage stalls.

## Options

Probe prepared for this record, to price the options. Synthetic dumps of about 90 scripts each with source, function ranges and a source map (8 dumps of 20.1 MiB), the real `sanitizeV8Dump` of `dump-sanitizers.ts`, a 5 ms heartbeat measuring its worst lateness. It ran on a laptop with 10 cores and Node v24.11.0; the orchestrator container has 2 vCPUs and Node v24.20.0, so absolute numbers are lower than production and only the relations transfer.

| Probe | Wall | Worst loop gap |
|---|---|---|
| A. Sanitize in the loop (today) | 502 ms | 498 ms |
| B. Sanitize in the loop, yielding after each dump | 487 ms | 59 ms |
| C. Worker, buffers transferred in and out; worker start 86 ms | 613 ms | 13 ms |
| D. Worker, buffers copied in; worker start 103 ms, 78 ms of copying | 797 ms | 149 ms |
| E. `terminate()` on a worker in a `for(;;)` loop, asked at +300 ms | exit at 302 ms | 1 ms |
| F. Worker with a 64 MB heap limit given an allocation loop | error `ERR_WORKER_OUT_OF_MEMORY`, main thread alive | n/a |
| G. One 114 MiB document of empty arrays: parse in the loop / in a worker with `terminate()` asked at +150 ms | 3,956 ms in the loop; the worker exited at 5,378 ms | 7 ms with the worker |

G shows two things. A single large dump holds the loop for seconds if it is parsed there. And `terminate()` does not interrupt a `JSON.parse` that is already running, so the byte cap stays the only bound on the CPU of one dump. One document shape was tried.

### O0. Keep main as it is

- **Removes:** evidence starvation by the coverage kind (`11d111db`).
- **Adds:** nothing.
- **Risk:** the stall stays and grows with every coverage-carrying execution.

### O1. Yield to the loop between dumps

- **Removes:** any block longer than one dump (probe B: 59 ms against 498 ms).
- **Adds:** `harvest()` and `closeDumps` become asynchronous. The shared reader needs an asynchronous scan beside the synchronous one, which has six call sites (`run-dump-bridge.ts:119`, `e2e-execution.runner.ts:480,658`, `observation-reader.ts:83`, `fault-injection-counter-reader.ts:13`, `coverage-dump-reader.ts:43`).
- **Risk:** a dump in flight still holds the loop for its whole parse (probe G: 3,956 ms), which matters because the fixtures are agent-editable. The harvest becomes asynchronous here as in O2, so the run's timer and abort listener are no longer cleared in the same tick as the harvest (rule in "Behavior the change must keep").

### O2. Per-call worker thread for the pure CPU steps

- **Removes:** the stall for any dump size (probe C: 13 ms against 498 ms) and the loop's exposure to memory or time of a hostile dump (probes F, G).
- **Adds:** the first use of `worker_threads` in `qa-engine/src` or `src` (none today). The asynchronous `harvest()` of O1. One module that starts a worker for one call, moves buffers by transfer and maps its failures to typed outcomes. No pool, no shared state, no new process, no new setting.
- **Risk:**
  - Handing bytes over by copy costs about 10 ms per 20 MiB dump (probe D). By transfer it costs nothing (probe C). Whether the confined reader's buffer can be transferred without an extra copy is not verified; the probe copied it.
  - `48f26eaa` rejected a worker because it "would bound the heap and not the cost of handing the result back". Probe C answers the second half, and probe F shows the heap bound holds without taking the process down.
  - The worker loads TypeScript through the process's `tsx`. It worked with the inherited loader flags in the probe; not verified under `tsx src/index.ts`.
  - Correction 2026-10-30 (work unit 1): verified under the `tsx` CLI and under `node --import tsx`. A worker loads `.ts` files through the inherited loader but resolves no tsconfig path alias (`@contexts/*`, `@kernel/*`): its module graph must be closed and imported by relative path. The harvest's worker module (`test-execution/infrastructure/dump-sanitize.worker.ts`) imports the pure sanitizer of objective-signal by relative path, with one named exemption, the rule `dump-worker-cross-context-import`, which admits that one edge and no other cross-context import of the worker module. Work unit 2 meets the same limit: the decoder's module graph (`coverage-dump-reader.ts` and what it imports) must be alias-free to run in a worker. A worker started under `tsx` costs about 0.6 s of wall time (the loader is registered and the module transformed again), against 86 to 103 ms in probe C; the loop gap of 8 dumps of 20 MiB measured 38 ms in the worker against 369 ms inline. Under a heap limit of 64 MiB a worker cannot even load its module under `tsx` (`ERR_WORKER_OUT_OF_MEMORY`); 128 MiB loads it.
  - Correction 2026-10-30 (checkpoint 3, A-J2, A-J4, A-m1, A-m3): the comment of `dump-sanitizers.ts` that said a dump is parsed in the orchestrator's one thread now says that the harvest sanitizes in a worker and the decoder reads the sanitized dumps in the orchestrator's thread. The test that each kind of dump has its own check time now moves the clock while the coverage job runs in the executor (the earlier test advanced it only by reading, so it kept passing with the guard removed), and fails when the counters' start time is taken before the first kind's check. A test pins that an aborted worker is ended and writes nothing more. `OutOfTimeError`, which nothing threw, is removed from the reader (`OUT_OF_TIME` stays: the bridge uses it).
  - Correction 2026-10-30 (T5 unit 1, after verification): a worker is given the module loader flags of its process (`--import`, `--require`/`-r`, `--loader`, `--experimental-loader`, `--conditions`/`-C`, with their values) and no other flag (`workerExecArgv`). Under `node --test` isolation the process carries per-process flags a Worker refuses (`ERR_WORKER_INVALID_EXEC_ARGV`: `--stack-trace-limit`, `--tls-cipher-list`, `--secure-heap*`, `--v8-pool-size`, `--node-snapshot`, ...). A worker that cannot be created, or an executor that rejects, is the typed failure `unavailable` for the coverage set (the counters are still harvested); a deadline does not stop a `JSON.parse` already running in the worker (the byte cap is its bound).
  - The parse half needs more than a function call: `BranchSink` accumulates across dumps in place (`v8-branch-coverage.ts:227-240`), so a dump must yield plain data that the main thread merges. The size of that change is not measured.
  - Correction 2026-10-30 (work unit 2, the read): the plain-data contract is `DecodedDump` (`objective-signal/infrastructure/coverage-decode.ts`): for one dump, whether it was `refused`, the lines it covers of the changed files, the lines its scripts hold code for, the scripts it counts, and the scripts' decisions and mutation sites as an ordered list of events (`ScriptBranchRead`, or `abandon`). `BranchSink` is split into a reader that finds what a script says (`ScriptBranchReader`, plain data, no sink) and a sink that merges it (`apply`, `replay`), so the worker records and the orchestrator's thread merges in the order of the dumps; the sink's bound on the decisions of a collection, its abandonment and the dumps a mutation site records are decided on the merging side, where the collection lives. A refused dump carries what it had added before it was found out (the scripts it counted, the code lines and branch events up to the bad script), because the in-thread decoding left them in the collection. One worker serves one `readV8Coverage` call: the reader scans and reads the files confined, hands their bytes over in one job together with a context (the changed files, a mutant's edit, whether code lines and branches are wanted), waits at most `V8_DECODE_BUDGET_MS`, and merges the answers. `OffLoopExecutor.run` takes that context as an optional third argument (`serveBytesWith` opens the per-call function in the worker), and `runWithin` is the wait-then-end helper the harvest already had inline. A worker loads its `.ts` modules through Node's own type stripping, not through the `tsx` loader, so a module a worker imports must use erasable syntax only (the adapter's constructor parameter properties became declared fields). Superseded with this unit: the cooperative time checks (`TimeSpent`, the 4,096-segment looks of the decoding and of the branch placement, `V8DecodeTime`): the budget is a wait deadline, and a decoding in the worker is ended by `terminate()`, which interrupts JavaScript loops and not a `JSON.parse` already running (the byte cap bounds that). Behavior that differs from the in-thread read, all in failure paths that leave the set unused: a call that runs out of its time adds nothing to the collection (the dumps decoded before the deadline used to be counted in `scripts`), and the bound on covered lines per file across the dumps of a collection is checked when the dump is merged. Measured on 8 synthetic dumps of 18 MiB (90 scripts each, two mapped to changed files), `tsx` CLI: the worst event-loop gap 370-400 ms in the thread against 68-72 ms with the worker (the rest is the confined reads, which stay on the main thread); wall 360-400 ms in the thread against 1.5 s with the worker, a fixed cost of about 1.05 s per call (worker start under `tsx` and the load of `typescript`) beside the decode itself.

### O3. Parse once

- **Removes:** one of the two `JSON.parse` passes over the same bytes. The refutation's judgement is that this halves the block and does not remove it (hypothesis).
- **Adds:** a change to what reaches the mirror, which today is only rebuilt files (`run-dump-bridge.ts:1-12`).
- **Risk:** it touches the sanitizer's security contract, and every later measurement still parses the dumps again.

### O4. Stop harvesting dumps nobody reads

- **Removes:** the harvest, and the browser's coverage overhead, of the `-obs` and `-obs2` re-runs. No reader takes their namespaces. The readers take the base namespace and the spec-file re-runs (`latestDumpsOf`, `qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts:135-143`, read at `:164-165`) and the namespaces of killed mutants (added as proof sources at `:245-246` and `:272-273`; a proof is pushed only for a killed mutant, `qa-engine/src/contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts:93`). The fixture gates coverage on `PW_COVERAGE` (and the cleanup pass) and observation on `PW_OBSERVE`, independently (`config/e2e/fixtures.ts:219,685`).
- **How much stall follows them:** in the four replicates of the table above, 9 of the 28 aligned events follow `-obs` or `-obs2` (2 of 4, 2 of 7, 3 of 10 and 2 of 7 per replicate; the longest, 7,348 ms, follows an `-obs2`). Execution spans carry no namespace, so the two are identified by position (hypothesis): each replicate has five executions inside `qayaba.coverage.measure`, the first and the last being the unmutated re-runs and the three between them the mutants.
- **Adds:** an explicit coverage option on the execution. Today coverage is switched off only as a side effect of `countWrites` (`e2e-execution.runner.ts:943`).
- **Risk: not low, and not checked.** The unmutated re-runs exist so that "only the paired runs differ in the mutation alone" (`AGENTS.md:855-858`): what a survivor moved is read against the disagreement of the two unmutated re-runs (`bundle-mutation-oracle.adapter.ts:66,70,113,118`). Mutant re-runs must keep coverage, because whether a mutant is killed is known only after it ran, and the fixture starts V8 JS coverage unless `PW_COVERAGE` is `"0"` (`config/e2e/fixtures.ts:219-222`). O4 would make the unmutated pair differ from the mutant runs in instrumentation as well as in the mutation. Instrumentation changes timing, which can change the requests a page makes and the tree lines it ends on; this record does not show that it cannot. A check that would: observed (`PW_OBSERVE=1`) unmutated re-runs of the same tests, two with coverage and one without; coverage moves the observations if the third differs from the first two by more than they differ from each other.
- **Beside O2:** once unit 1 of O2 lands, O4 removes no stall that O2 has not removed (hypothesis: nothing decodes the dumps of these two re-runs, so what follows their close is the harvest and the observation tail named under "What H06 does not explain"). What it would still save is the browser's coverage overhead on two executions, which no run measured.

Not considered further: a separate process through the execution launcher (a new spawn profile, a uid and IPC; `.dependency-cruiser.cjs:96-108` exists to keep new spawn sites rare), and smaller dumps at the source (the dump format is shared with the seed copies in apps' repositories, so changing it is a contract change).

### What each option does to the time budgets and to completeness

| Option | Time budgets | Completeness of the measurement |
|---|---|---|
| O0 | Two 10 s wall-clock budgets on the loop; each is also the ceiling of the stall it governs, and a dump in flight is never interrupted. | Whole or nothing; a kind can no longer starve the other. Dropped for time under load, and the work inflates its own clock. |
| O1 | Must be re-based on the work's own time. With wall-clock, the callbacks that run between yields spend the budget. | Unchanged if re-based; sets are dropped more often under load if not. |
| O2 | The same two constants become "stop waiting" deadlines on a free loop. The worker is terminated on expiry, which works between JavaScript operations but not inside a running `JSON.parse` (probe G); the byte cap bounds that. The run deadline is unaffected (it wraps agent turns only). | Same rule, whole or nothing. New failure modes (deadline, heap limit, crash) leave the set out through the existing path with their own reason. Still host-dependent: a starved worker can miss a deadline on 2 vCPUs. |
| O3 | Half the CPU under the same budgets. | Unchanged. |
| O4 | Unchanged. | The coverage measurement loses nothing (nobody reads these dumps). The "what a survivor moved" signal is not shown to stay unchanged (risk above). |

## Recommendation

**O2 in two work units.** One root cause: where the CPU work runs. O4 is not part of the recommendation (item 3).

1. **Harvest.** `harvest()` becomes `Promise<void>`. `sanitizeV8Dump` (pure, no imports) runs in a per-call worker: the main thread lists and reads through the confined reader, transfers each buffer, and writes the returned bytes through the confined writer. Worker heap limit: a constant chosen with the cap (`dump-sanitizers.ts:5` sizes a worst-shape dump at the cap at 1.4 GB of heap), not a new setting. Correction 2026-10-30: one worker per `harvest()` call serves the coverage kind's dumps as one batch (one start per harvest, about 9 per run); the fault-injection counters (a few bytes each, `sanitizeFaultCounter`) are rebuilt in place, because a worker start costs more than the work; the heap limit is `DUMP_WORKER_HEAP_MB` = 2,048 MiB, the process default heap, so it admits what the cap admits. The result must be byte-identical to today's, and the set stays whole or nothing.
2. **Read.** The parse step of `readV8Coverage` gets the same treatment once a dump yields plain data (lines, script counts, executable lines, decisions, sites, who ran what) that the main thread merges. It is a separate work unit because that contract is the largest unknown. The cooperative time checks inside the parse could then go.
3. **Not O4.** `-obs` and `-obs2` keep coverage until a pair of runs shows that coverage does not move the requests and tree lines they observe (the check under O4). Once unit 1 lands, O4 would remove no stall that O2 has not removed. If the owner takes O4 (decision 4), the lambda at `run-engine-factory.ts:1002` also carries `retries: 0`, a decision about a run; the oracle should pass it, leaving the factory as wiring.

**Behavior the change must keep: the timeout and the cancel bound the child, not the evidence work.**

- **Rule.** When the child closes, the run's timer and abort listener are disarmed at both layers that hold them: the timer and listener of `runSuite` (armed at `e2e-execution.runner.ts:977-983`, cleared in `settle`, `:955-956`) and the race that `runE2E` runs over the whole `runSuite` promise with a timer and a listener of its own (`:296-318`). `runSuite` tells `runE2E` that the child closed through one callback in its arguments, as `onEvent` is passed today, and `runE2E` clears its race. After that point no timeout or cancel can turn a finished run into a stopped one.
- **Why it is needed.** Today neither layer can end a finished run only because the harvest is synchronous: the close handler reads the report, harvests and settles on one stack (`:990-998`), so no timer gets a turn in between. An asynchronous harvest removes that accident. With both layers still armed, a healthy run that closes shortly before its timeout would end as "timed out ... killed" while its dumps are harvested.
- **A cancel during the harvest** is not acted on by the runner, deliberately and as today: with a synchronous harvest the listener is also gone before any cancel can be delivered. The wait is bounded by the harvest's own deadlines (the two 10 s "stop waiting" bounds, decision 3), and the run asks whether it was cancelled before its next step (`qa-engine/src/contexts/run-orchestration/application/run-flow/run-flow.ts:4,94`).

**Why the smallest change that removes the cause.** The cause is where the work runs. O1 keeps it on the loop, so any large dump still blocks for its parse, and it changes the budget semantics anyway. O3 does not remove the stall and touches a security contract. O4 removes the harvest stall only after `-obs` and `-obs2`, and puts the paired-run comparison at risk. O2 adds one adapter module and the asynchronous harvest, and no pool, process or setting.

**Why app-agnostic.** Confirmed by the code: the path does not depend on the framework. The fixture starts coverage for any Chromium page (`config/e2e/fixtures.ts:219`) and the dump handover treats every dump the same way (`run-dump-bridge.ts:111-143`). What the work costs follows the bytes of the dumps (probe: 8 dumps of 19.9 MiB sanitize in 552 ms) and the tests per execution (the dose above). What sets the bytes is a hypothesis, because dump bytes were never recorded for a run: bundle size, minification, pages per test and executions per run. Two further hypotheses: a small minified app blocks for under 1 s, so the defect stays invisible there; a large unminified app exceeds the 10 s budgets and loses evidence depending on host CPU. Every analyzed run tested one app, name-webapp, and nothing here is shaped by it.

**Where it lives.** The pure functions stay where they are. The harvest stays in the test-execution context (decision-table row 4 of `docs/engine-platform-architecture.md`). The executor serves two contexts (the harvest and the read) and holds no process-wide state, because each call starts and ends its own worker: shared infrastructure of the engine (row 5). HostHealth stays in the platform (row 6). The worker is injected as a default dependency, as the other process boundaries of the runner are, so tests use a fake.

Per the owner's pillars (2026-10-28, translated): "a good architecture is rigid at the base and flexible at the edges" and "if it is not something that brings real value, do not do it". The new piece is justified by an evidenced need (63 stalls, 7 of 9 events aligned in the latest replicate), and it is one module, not a pool or a framework.

## Patches it supersedes

| What | Where | Effect |
|---|---|---|
| The decision that caps are the whole defense and a worker is rejected | `48f26eaa` (message) | Superseded for CPU work. The caps stay as the bound on one dump. |
| `harvest(): void` and its synchronous call | `run-dump-bridge.ts:53`, `e2e-execution.runner.ts:928` | Become asynchronous. |
| Comments that say the parse happens in the one thread | `dump-sanitizers.ts:4`, `coverage-dump-reader.ts:26` | Rewritten to the final state. |
| Cooperative time checks inside the parse | `v8-browser-coverage.adapter.ts:142,191`, `coverage-dump-reader.ts:35-42` | Candidate for removal with work unit 2, if the owner takes it. |
| Timer and abort listener cleared in `settle`, after the synchronous harvest, with the outer race of `runE2E` armed over the whole `runSuite` promise | `e2e-execution.runner.ts:955-956`, `e2e-execution.runner.ts:296-318` | Both layers disarmed when the child closes. |

Not superseded: `11d111db` keeps guarding evidence and its tests stay; `ce6ce2ac` is labelling only. Coverage on by default for the observation re-runs (`bundle-mutation-oracle.adapter.ts:66,113`) stays unless the owner takes O4.

## Test plan

Rules named first; one test per rule, through the public seam, with no real time (`AGENTS.md`, Testing standards).

**The seam.** The off-loop executor is the one dependency through which `openDumpBridge` and `readV8Coverage` run their pure CPU step: it takes a dump's bytes and answers with a promise of the result (the sanitized bytes, or for the read the plain data of the dump) or a typed failure. It touches no file. The handover keeps the confined reads and writes. A test injects a fake executor whose job a gate holds open, so the cause itself is observable: whether the CPU step is done by the executor or on the calling stack.

**The fixture.** A dump file whose bytes are not JSON, which the real `sanitizeV8Dump` refuses (`dump-sanitizers.ts:21-24`) and so does the real decoder (`coverage-dump-reader.ts:50`), and a fake executor that answers with a marker neither could produce. The code under test cannot reach the marker by sanitizing or decoding anywhere itself, before or after a yield; only an executor-driven call yields it.

| # | Rule | Seam | Fails today because |
|---|---|---|---|
| T1 (RED) | The harvest does its CPU step in the executor and not on the calling stack. | `openDumpBridge({ ..., executor: fake }).harvest()` with the fixture and the gate closed. Assert (a) the fake received exactly the file's bytes; (b) a `setImmediate` registered before the call has run while the job is pending and the `harvest()` promise is still pending; (c) after the gate opens, the file in the mirror holds the marker. | `harvest()` takes no executor and sanitizes on the calling stack: the real function refuses the fixture, the set is left out, the fake is never called and nothing pends. It fails because the CPU work is on the loop, not because the call does not yield. |
| T2 (guard) | A timeout or a cancel that arrives after the child closed leaves the finished run's result intact. | `runE2E` over `createDefaultE2eExecuteDeps` with the fake launcher of `e2e-execution.runner.test.ts:1433-1438`, `readReport` returning a report, the fake executor held by a gate. After the child's `close` and before the gate opens: `t.mock.timers` ticks past `timeoutMs` and `controller.abort()` is called. Then open the gate. Assert the result is the report's (`ran` true, the report's verdict, no "timed out" or "aborted by operator cancel" in the logs), the executor's job ran once and the dump root is removed once. | Not RED today: the harvest is synchronous, so no timer can fire during it. The path becomes reachable with the change, and the test fails for any implementation that leaves the timer or the abort listener armed after the close, in `runSuite` or in the outer race of `runE2E`. |
| T3 | A job that fails or outlasts its deadline leaves that kind out with its own reason, and the count of counters is unknown. | `openDumpBridge` with a failing fake, and with a fake held past the kind's budget by `t.mock.timers` (as `code-setup.test.ts:23-34` does) (Correction 2026-10-30: `code-setup.test.ts` was deleted with the code target in `b3deb252`, so the held fake is written new with `t.mock.timers`); the injected `now` as in `run-dump-bridge.test.ts:199`. The `harvest()` promise settles at the deadline. | New failure modes. |
| T4 (RED, work unit 2) | The read does its CPU step in the executor and not on the calling stack. | `readV8Coverage` over several dumps of the fixture kind with the gate closed. Assert (a) the fake received each dump's bytes; (b) a `setImmediate` registered before the call has run while the jobs are pending and the promise is still pending; (c) after the gate opens, the covered lines are exactly those of the plain data the fake returned. | `readV8Coverage` is `async` without an `await` and decodes on the calling stack (`coverage-dump-reader.ts:47-55`): the real decoder refuses the fixture and the fake is never called. |
| T5 | The real worker returns exactly the bytes `sanitizeV8Dump` returns, and maps a worker that exceeds its heap limit to the typed failure. | The worker adapter, the one boundary where a real worker is used: a real dump fixture, then a job given a tiny heap limit. | New adapter. |
| T6 (only if the owner takes O4) | `-obs` and `-obs2` are requested without coverage, mutant re-runs with it. | `BundleMutationOracleAdapter.measure` with a fake `runMutant` recording its options. | New option. |
| Guard | Previous behavior holds. | The existing dump-handover tests (`run-dump-bridge.test.ts:34-199`), the reader (`coverage-dump-reader.test.ts:32-98`) and the runner, including its timeout and abort tests (`e2e-execution.runner.test.ts:338-359`, `:1433-1461`), pass with only `await` added. | n/a |

Fitness check: a dependency rule that only the executor imports `node:worker_threads`, with the shape of `no-child-process-outside-launchers` (`.dependency-cruiser.cjs:96-108`).

Break proof: running the sanitize inline in the call path makes T1 fail, and so does yielding once after an inline sanitize: the real function refuses the fixture, so the marker never reaches the mirror and the fake is never called. The same holds for T4 and the decode.

## Measurement

The signal for this cause is the count of root-span `event_loop_blocked` events aligned with a Playwright execution end (definition above). The before is ONE replicate, `run-ed28973-mvs7oo0f-17041c71` on 4105c582: 9 events, 7 aligned, longest 5,662 ms, run time 3,361 s, line coverage 0.630 marked stale, branch 55/126, bundle mutation 0 of 3 killed. The three runs of cycle 3 on identical input spread from 6 to 13 events and 7,348 to 10,863 ms, so a one-against-one comparison shows a direction, not proof.

| Signal | Before | Expected after |
|---|---|---|
| Aligned `event_loop_blocked` events | 7 of 9 | 0 |
| Unaligned events | 2: one of 1,346 ms at 85 s, in the grounding before the lead's first turn (the class of the 7 non-coverage stalls, hypothesis); one of 4,450 ms at 1,745 s, 2.3 s after `coverage.measure` started and 8 s after a 13 s execution ended (not classified) | the first unchanged, not part of H06; the second may fall |
| Dump warnings caused by time ("the time to check the files of this directory ran out", "not all decoded") | not counted in the before | none; warnings about content can remain |

- One replicate on the fixed version (the recommended count; [ADR-0011](../adr/0011-root-cause-fix-policy.md) leaves the count of after-measurements to be confirmed; Correction 2026-10-29: decided as recommended in ADR-0013, one per version), from the same 12-entry snapshot with the freeze off (D13). The owner's words on the count concern the baseline (2026-10-28 15:52Z, translated): "we had agreed on 1 single replicate, why did you launch 3?"
- If only work unit 1 lands, expect the aligned events to fall to those that start with `coverage.measure`, `coverage.recount` or `coverage.survivor_recheck`.
- The line, branch and mutation numbers are not a signal for this fix. They spread from 0.63 to 0.90 on identical inputs. A change in them is no evidence for or against this record.
- Without this measurement the fix is reported as unproven (the brief: "A fix without measured improvement is reported as unproven").

## Owner decisions needed

1. Reopen `48f26eaa` and allow the first `worker_threads` use in the engine, as a per-call worker in shared infrastructure with a heap limit. Recommended: yes. Fallback if refused: O1, accepting that a large dump still blocks for its parse.
2. Order of the two work units. Recommended: harvest first, one replicate, then the read, because the read needs a plain-data contract for what a dump yields.
3. Deadlines after the move. Recommended: keep the two 10 s wall-clock budgets as "stop waiting" bounds in this change. Replacing them with deterministic bounds changes which evidence is admitted and belongs with [ADR-0005](../adr/0005-coverage-enforce-activation.md).
4. O4 (no coverage on `-obs` and `-obs2`). Recommended: not in this change. It puts the paired-run comparison at risk and, once unit 1 lands, removes no stall that O2 has not removed (hypothesis). If the owner wants it: first the check under O4 on observed re-runs with and without coverage, then its own commit, moving `retries: 0` into the oracle with it.
5. Worker lifetime. Recommended: one worker per call, no pool; a pool in the platform only if worker start (86 to 103 ms in the probe, about 9 per run) shows up in a measurement.

The authority to fix H06 at all is D12, approved by the owner on 2026-10-28 (translated): "Regarding the 13 recommendations I agree with everything". The brief fixes the rule for the fork above: "If a fix needs a product or architecture decision, STOP and ask me — do not choose."

## Out of scope

- The 7 stalls not tied to coverage.
- The observation read and comparison after the unmutated re-runs (see "What H06 does not explain").
- The native-report parse of the code target (`coverage-dump-reader.ts:82-92`, `target-coverage-collector.ts:25`): it goes with the target if [ADR-0007](../adr/0007-code-target-removal.md) is executed as approved.
- Smaller dumps at the source (`fixtures.ts:235-240`) and any change to which evidence is admitted.
- The quality signals themselves (coverage ratio, kills); the stall did not change a verdict in any run examined.
