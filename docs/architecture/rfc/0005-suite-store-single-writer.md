# RFC-0005: One writer for the suite store (H20)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Code references at 4105c582:** `qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts`, `qa-engine/src/shared-kernel/ports/suite-store.port.ts`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/suite-store-trace.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/setup.steps.ts`, `scripts/warm-suite.ts`, `scripts/campaign.ts`, `scripts/campaign-report.ts`, `scripts/campaign-compare.ts`, `src/server/run-engine-factory.ts`, `src/server/merge-guard.ts`, `odd/tasks/campaign-loop.md`, `docs/efficiency-benchmark.md`, `AGENTS.md`, `qa-engine/test/contexts/workspace-and-publication/infrastructure/suite-store.adapter.test.ts`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0009](../adr/0009-campaign-freeze-on-server.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0002](./0002-platform-steps-0-1.md), [RFC-0004](./0004-log-level-from-outcome.md), [Rejected explanations](../rejected-explanations.md)

## Summary

1. Cause H20, confirmed in its narrowed form: the suite store is two artifacts that only the adapter keeps consistent (it removes every blob a new manifest does not name, `suite-store.adapter.ts:513-516`), and the campaign skill's replicate reset is a second writer that copies the manifest alone.
2. Effect, on measurement validity only: two triggers (run #11 in O4, run #29 in O10) left 8 runs logging "cannot be read"; every replicate since cycle 3, the baseline included, restored 12 of 13 entries (digest fc7ad52e against a17480c9), and the validity check never fired. No verdict effect is shown.
3. Proposal (O3): the adapter owns snapshot and restore of the manifest and its blobs together, the operator tooling calls it, and the reset rule stays the skill's. A restore verifies the snapshot whole before it touches the store, reads the store back afterwards and fails unless the digest matches.
4. Plus one additive field on the restore result, "named but not restored", the choice ADR-0002 leaves to this RFC.
5. Five forks are the owner's (F1 to F5). Nothing is patched on main.

## Problem

### The cause, in the form that was confirmed

H20 as proposed had three parts. Confirmed: the two-writer chain below, with two independent triggers. Not causal (adjudication, disputed points 3 and 4): the missing typed outcome (every one of the 8 runs logged an error line naming the path, and the restored count fell) and the "blind" digest (its value did move, from a17480c9 to fc7ad52e; what is blind is the scope of the comparison). Corrected (disputed point 2): the engine does have one-writer paths, a read-only store under the freeze and `seed()` through `warm-suite seed-store`; the reset used neither.

The two refuters located the defect differently. The alternatives refuter called it a local bug in an operator script outside the repository and judged the structural-defect framing refuted. The adjudication kept the chain and placed the defect in the replicate-reset procedure, which writes into the engine's private store and bypasses its API. That procedure is not wholly outside the repository: the loop charter prescribes it (`odd/tasks/campaign-loop.md:8`, unchanged on main). The ownership reading recorded in ADR-0002 (addition 8) comes from the alternatives refuter: one owner would have prevented the failures, and that owner already existed. The adjudication found the adapter's blob removal correct under the contract it states.

### The causal chain, checked at 4105c582

| # | What happens | Where |
|---|---|---|
| 1 | The store is two artifacts: `manifest.json` names entries by content hash, `blobs/<sha256>` holds the bytes. Consistency rests on one writer: "the queue runs one run at a time". | `suite-store.adapter.ts:5-9` |
| 2 | `writeStore` writes the blobs, swaps the manifest, then removes every blob the new manifest does not name. | `suite-store.adapter.ts:504-517` (removal `:513-516`) |
| 3 | A capture that admits new bytes at a path the store already holds gives the entry a new hash, so the old blob is unreferenced and removed. Only an accepted run captures; a read-only (frozen) store returns first. | `suite-store.adapter.ts:346-352`, `:375-377`, `:284` |
| 4 | The second writer is the campaign skill's reset script (operator tooling outside the repository, last written 2026-10-26 20:32 local). Its snapshot is a `cat` of `manifest.json` into a file; its restore copies that file back into the container and sets owner and mode. It copies no blob and does not check that the queue is idle. | `odd/tasks/campaign-loop.md:8` prescribes it |
| 5 | A restore of a manifest that names a removed blob: `readBlob` fails with ENOENT, logs, returns `undefined`, and the entry is skipped. The result has no field for it; the setup step announces "restored N" at info. | `suite-store.adapter.ts:262-263`, `:471-481`; `suite-store.port.ts:16-30`; `setup.steps.ts:28-31` |
| 6 | The next capture reads the missing entry as a deletion and drops it; a snapshot retaken from that store keeps the loss. | `suite-store.adapter.ts:360-367`; `suite-store.port.ts:73` |
| 7 | Nothing sees it. The digest covers only the files laid down; the validity check compares each replicate with replicate 1 of its own group, so a loss common to a whole campaign passes. | `suite-store.adapter.ts:233-236`, `:267-270`; `campaign-report.ts:105-118`; `campaign-compare.ts:96` |

Epoch check: the adapter is byte-identical at O4 (94f2b45e) and O5 (f96f958f), and again byte-identical at O7 (e4efa50e), O10 (bd1d2e46), cycle 3 (40513c1e) and 4105c582; the only change between the two versions is the digest (`582c5349`). The blob removal is in every version. Steps 1 to 7 are therefore the same code in every epoch that showed the symptom.

**Where the reset comes from.** The owner's instruction of 2026-10-26 (translated; as recorded in the owner's notes): "between executions of the same commit you must delete the generated tests so that each one starts from 0 and can be measured idempotently". The notes record it as a rule of the campaign skill that the operator runs as part of testing, "never engine code". The skill's script is the answer to that rule. Its own header says it snapshots or restores "an app's suite store manifest" and that the engine never does this itself: it is a campaign step the operator runs. No source records why it copies the manifest alone.

### What the runs show

Runs are numbered by start time from 2026-10-26 18:00Z, as in the investigation's timeline. Code epochs: O4 `94f2b45e`, O5 `f96f958f`, O7 `e4efa50e`, O10 `bd1d2e46`, O11 and cycle 3 `40513c1e`, the baseline `4105c582`.

Per capture, from the history database: changed = admitted minus new, where new = entries after minus kept, and kept = entries named at restore minus dropped (an unreadable entry counts as named: that capture drops it; no restore span has overlaid or tracked wins above 0). Of the 17 captures between #4 and #33, exactly two changed an existing entry.

| Trigger capture (epoch) | Restore, capture | What follows |
|---|---|---|
| #11 `run-ed28973-mvpoel1j-e5a7cee8` (O4) | restored 14; entries 15, admitted 2: one entry replaced | #12 `run-ed28973-mvpoyt4e-6b1ff206` restores 8.6 s after that capture ended: restored 13, "cannot be read" on `.qa/manifest.json`, capture dropped 1. #13 `run-ed28973-mvptanac-2600fbd4`, #14 `run-ed28973-mvptrv69-d4f52b7e`, #15 `run-ed28973-mvpu85em-1b65ceb1` (O5): the same. |
| #29 `run-ed28973-mvrxb30p-ecfe944b` (O10) | restored 13, digest a17480c9; entries 16, admitted 4: one entry replaced | #30 `run-ed28973-mvs0onsn-6ad17f30` restores 39 min later: restored 12, digest fc7ad52e, "cannot be read" on `flows/user-account.spec.ts`. #31 `run-ed28973-mvs2ukug-c82da7be`, #32 `run-ed28973-mvs49h5y-acdab309` (O11, 40513c1e) and the baseline `run-ed28973-mvs7oo0f-17041c71` (4105c582): the same; #31 and the baseline dropped 1. |

- **The lines.** The refutation's Loki search over 30 days found exactly 8 "cannot be read" lines: #12 to #15, #30 to #32 and the baseline. All are ENOENT, each on the path the preceding trigger had replaced. Tempo was down during the refutation, so the span facts above are from the history database; the Loki lines are the refutation's read and were not re-read here.
- **The writer.** No engine path replaces the manifest between a trigger and the next restore (the refutation searched `src`, `qa-engine/src` and `scripts`); the manifest #12 read named 14 entries while #11's capture had written 15. That an operator reset did it is inferred from the script's behavior and the timing, not from a log of the invocation (hypothesis, consistent with all 8 occurrences).
- **The controls.** Ten runs (#17, #19, #21, #23 to #29) restored from a manifest-only reset with no replaced entry before them and logged no line; no line appears without a trigger (refutation). The restore carried no digest before O7, and the isolation check arrived with it (`582c5349`, 2026-10-27), so it could not have fired in #12 to #15.
- **The loss became permanent.** None of the five operator snapshot files (untracked, in the benchmarks config folder) names `.qa/manifest.json`; checked. Runs #17 to #29 restored every entry they named (13 of 13, #20 aside, which was not reset) and still started without it. After #29 the same happened to `flows/user-account.spec.ts`: snapshot -d names it at 6aa379ad and, per the refutation's read-only listing, its blob is gone.
- **Excluded.** Run #34 `run-ed28973-mvs9yzjd-bf4eb95c` also restored 12; the operator cancelled it and ADR-0011 excludes it.

### What H20 does not explain

- Any verdict or plan effect: #12 to #15 passed and there are no paired runs. The lead's existing-suite section shrank from 296 B to 136 B with no annotation in #12 (refutation); whether that changed a plan is not enough evidence.
- The runs where the store was not reset (#7, #8, #9, #16, #20 restored more files than the baseline): the opposite direction. It shares the procedural root, not this mechanism.
- The coverage spread of identical inputs in cycle 3; the hash-mismatch branch (`suite-store.adapter.ts:476`, never logged); anything in production. A webhook-triggered run has one writer, and the mechanism was never observed outside campaigns.

### Why it matters

The owner's goal (translated, 2026-10-28 13:36Z): "for several identical runs, qayaba behaves similarly, predictably and stably". A replicate that starts from another suite is not an identical run, and nothing recorded it:

- Campaign `validation-2026-10-28-a` (#27 to #29) started from a17480c9; `-b` (#30 to #32) and `-c` (the baseline) from fc7ad52e. Each campaign's own check passes. A cross-cycle comparison carries a suite difference nobody recorded (confirmed by both refuters).
- ADR-0011 (D13) fixes the after-measurement to the baseline's 12-entry suite, "via a new 12-entry snapshot with its blobs". The procedure that fails is the one that would build it.

## Goals and non-goals

**Goals**

- A reset puts back every entry its snapshot names, or fails before it touches the store.
- A restore says what it laid down and proves the set.
- The store's files have one writer in the repository, with one supported route for the operator.
- The after-replicate (D13) starts from a whole 12-entry suite.

**Non-goals**

- When a campaign resets, and which entries it drops: the skill's rule.
- The freeze ([ADR-0009](../adr/0009-campaign-freeze-on-server.md)), the campaign contract, the level of the store's log line ([RFC-0004](./0004-log-level-from-outcome.md)).

## Options

### O0. Mend the operator's reset; change nothing in the repository

Either the script copies the whole store directory (the investigation's probe found no warning and the same digest), or it calls the existing `warm-suite seed-store`, which `docs/efficiency-benchmark.md:462-464` already prescribes for a hand-launched replicate and `scripts/campaign.ts:403` runs before every arm-run.

- **Removes:** the trigger at this script.
- **Adds:** nothing in the repository.
- **Risk:** the second writer stays outside the repository, where no test, gate or review sees it, and the charter keeps prescribing it. A directory copy has no idle check (`warm-suite` refuses unless the queue is idle, `scripts/warm-suite.ts:335-337`, `:414-415`) and no proof. `seed-store` is not the same store: it restamps every entry with `admittedBy` `seed:<label>` and `pinned: true` (`suite-store.adapter.ts:423`, `:433`), and a pinned entry wins over git (`:258`, `:365`). For the baseline's app this shows nothing (restore: overlaid 0, tracked wins 0); for an app with tracked e2e files it would. Its snapshot is also the mirror's `e2e/` working copy (`scripts/warm-suite.ts:13`), not the store.

### O1. Rely on the freeze (ADR-0009)

Under the freeze `capture` returns before `writeStore` (`suite-store.adapter.ts:284`; `run-engine-factory.ts:1522-1526`), so nothing is replaced or collected and a campaign needs no reset.

- **Removes:** the trigger for every frozen campaign run.
- **Adds:** nothing here; ADR-0009 moves the default to the server.
- **Risk:** it leaves out what D13 holds constant. The baseline and the after-replicate run with the freeze off (ADR-0011), the learning arm is unfrozen by declaration (ADR-0009, decision 2; whether a declared learning arm also lifts the store's read-only mode is open in ADR-0009, "Not decided here"), and a manifest-only snapshot still dangles after any unfrozen capture of a changed entry between snapshot and restore (by the code; no such run was observed).

### O2. Stop removing blobs at capture

Delete `suite-store.adapter.ts:513-516`; the store keeps every blob it ever wrote.

- **Removes:** the dangling reference for any older manifest, whoever restores it.
- **Adds:** a directory that only grows, and a prune that must know every root. The roots include snapshot files the store cannot see, so the dangling moves into the prune. The limits bound the live manifest, not the directory (`suite-store.adapter.ts:461-465`).
- **Risk:** it removes a deliberate invariant, stated in the header (`:7`) and pinned by `suite-store.adapter.test.ts:367` ("no temporary file or unreferenced blob is left behind"), and it keeps the second writer (`AGENTS.md:20-21`).

### O3. One writer: the adapter owns snapshot and restore (recommended)

The adapter gains two verbs beside `seed()`: one exports the store to a self-contained snapshot, one restores a snapshot into the store, with the proof under Recommendation. The operator tooling calls them; the reset rule stays the skill's.

- **Removes:** the second writer. There is no manifest-only snapshot to restore, and the one route is tested and gated in the repository.
- **Adds:** two adapter methods built from `readManifestFile`, the manifest parser and `writeStore` (all existing); two command verbs; tests. Hypothesis, not counted: well under 400 authored changed lines with tests.
- **Risk:** the adapter is on the merge guard's protected list (`src/server/merge-guard.ts:173`), so the change ships as its own commit (`AGENTS.md:690`). The persisted store format is untouched: a snapshot uses the store's layout, schema 1.

### O4. Detect only

Add the typed outcome and compare each replicate with a digest declared outside its campaign.

- **Removes:** the invisibility.
- **Adds:** a result field, a span attribute and a reference in the campaign record (`src/contract/commands.ts:669-670` is the contract that would grow).
- **Risk:** the entry is still lost. The run measures another suite and the next capture drops the entry (`suite-store.adapter.ts:360-367`). `docs/efficiency-benchmark.md:464` already calls the digest comparison the check that "reveals the contamination, after the fact".

## Recommendation

**O3, plus the typed field from O4 (F2).** The reset rule stays the skill's (F1).

**The change**

1. **Export.** The adapter writes the store's whole state to a directory in the store's own layout (`manifest.json`, `blobs/`). It reads every selected entry's blob through the hash check; one unreadable blob fails the export and leaves nothing behind. The caller names paths to leave out: the D13 snapshot is the live store minus `flows/user-account.spec.ts`. Provenance (`admittedBy`, `gitBaseBlob`, the auth record) is copied as is.
2. **Restore.** The adapter replaces the store from such a directory through `writeStore` (blobs, manifest swap, removal of the unreferenced), with `generation` one above the store's. It keeps the snapshot's provenance and adds no `pinned`, which is the reason it is not `seed()`: `seed()` takes files, and a file carries no provenance (`suite-store.adapter.ts:415-441`).
3. **Command.** Next to `seed-store` in `scripts/warm-suite.ts`: it runs in the orchestrator container, refuses unless the queue is idle (`:335-337`, `:414-415`) and builds the adapter as `seedSuiteStore` does (`:452-466`). The files are written by the process that owns them, mode 0600 (`suite-store.adapter.ts:197-205`), so the skill needs no copy and no chown. The skill's two actions become calls to these two verbs.
4. **Typed outcome.** `SuiteRestoreResult` gains the paths the manifest named and the restore could not lay down; the restore span carries their count; the setup announcement says so. `readBlob` returns the miss instead of `undefined` (`suite-store.adapter.ts:471-481`).
5. **Text.** The adapter header names the verbs; `odd/tasks/campaign-loop.md:8` and `docs/efficiency-benchmark.md:462-464` name the verb for returning the store to a recorded state and keep `seed-store` for a warm start from files.

**How a restore proves it laid down the whole snapshot**

| # | Check | When | If it fails |
|---|---|---|---|
| 1 | The snapshot is whole: its manifest parses with the store's parser, and every entry's blob is in the snapshot and hashes to its name. This is what `loadSnapshot` already requires of a warm snapshot (`scripts/warm-suite.ts:185-196`). | before the store is touched | throws, names the missing or altered blob; the store is unchanged |
| 2 | The store is written in the adapter's one order, so a crash leaves the previous manifest whole (`suite-store.adapter.ts:504`). | during | as a capture today |
| 3 | The store reads back: every entry is read through the reader a run uses, and the digest of what was read equals the digest of the names in the snapshot's manifest. The proof is not new in kind: `restoreSuite` compares once more after writing (`scripts/warm-suite.ts:303-306`). | after the swap | throws; the command exits non-zero and lists the entries it could not read |
| 4 | The command prints the entry count and the digest. A run's restore span carries the same quantity, computed by the same function (`restoredSetDigest`, `suite-store.adapter.ts:233`); an entry git wins or a demoted login is left out of a run's digest by design (`suite-store.adapter.ts:256-260`); no recorded restore has tracked wins above 0. | at the next run | a run that laid down less than the snapshot named shows another digest and a non-empty typed field |

A subset of a whole snapshot is whole, so the skill may still drop entries from a snapshot's manifest by its own rule; adding an entry whose blob the snapshot lacks is refused at check 1.

**Why it is the smallest change that removes the cause.** The cause is a second writer to a private two-artifact format. O0 removes the instance and keeps the writer; O1 is decided and covers frozen runs only; O2 is fewer lines but removes a deliberate invariant and moves the problem to a prune; O4 detects after the loss. O3 reuses the parser, `writeStore`, the idle check and the digest, adds no port method (`seed()` is not on the port either) and no pattern. It meets the owner's test for added complexity (translated, 2026-10-28): "each decision must be grounded and any added complexity (logical or cognitive) must be justified". The ground is two triggers of the second writer in two epochs, 8 runs that logged the loss, and campaigns -b and -c, whose own check passed.

**Why it is app-agnostic.** The verbs act on the store's layout and name no app, framework, route or path. Entries are opaque relative paths. The mechanism fired on `.qa/manifest.json`, which the engine's authors write for every app (`AGENTS.md:132`), and on a spec file. The evidence is one app's (name-webapp, as ADR-0011 notes); that the trigger needs only an accepted run that rewrites an entry the snapshot names, then a manifest-only reset, is shown on an app-free fixture by the investigation's probe (4/4 at db041567; the adapter, the port and the campaign scripts are unchanged between db041567 and 4105c582, checked).

**Where it lives.** The adapter stays engine, in `workspace-and-publication/infrastructure` (decision-table row 4 of `docs/engine-platform-architecture.md`); the typed field is on the kernel's port. The command is an entry point (row 7): in `scripts/warm-suite.ts` now, in the platform's entry points when step 4 moves product commands there. `appSuiteStoreDir` stays composition (row 8). The reset rule stays outside the repository, in the skill. The change follows platform steps 0-1 ([RFC-0002](./0002-platform-steps-0-1.md)) in the approved order.

**Ownership test (ADR-0002, addition 8).** A text scan in `qa-engine/test/arch/` with a frozen allow-list of the modules that derive the store directory with `appSuiteStoreDir(`: `src/server/run-engine-factory.ts`, `src/server/wire-app.ts`, `src/server/login-bootstrap-wiring.ts`, `scripts/warm-suite.ts`. A new caller fails it; the list may only shrink. It is the weakest guard, a text scan like the one RFC-0004 names, and it confines writers inside the repository only. Added in this change, not at platform step 6. A writer outside the repository cannot be confined by any repository test; what holds it there is the one supported route, the proof, and the typed field that shows the damage on the next run.

## Patches it supersedes

No past commit targeted the cause and none becomes redundant. `f11b2abf` (the format), `8662924d` (heals a stored copy that no longer matches its hash on a capture that holds the bytes, `suite-store.adapter.ts:353-357`), `582c5349` and `87c5f184` (the digest and its check, `campaign-report.ts:105-118`) do what they say and stay. What the fix removes or rewrites:

- the manifest-only restore step the charter prescribes: `odd/tasks/campaign-loop.md:8`
- the hand-launched-replicate instruction that names `seed-store` for a return to a recorded state: `docs/efficiency-benchmark.md:462-464`
- the sentence that makes "the queue runs one run at a time" the whole contract: `suite-store.adapter.ts:9`
- the miss that carries no outcome: `suite-store.adapter.ts:262-263`, `:471-481`
- outside the repository: the skill's snapshot and restore actions, replaced by calls to the verbs

## Test plan

Per the testing standards, through the public seam (`SuiteStoreAdapter` on a temporary directory, the `rig` of `suite-store.adapter.test.ts:41-86`). Written first; the existing assertions stay except the ones named.

| Rule | Test | Fails today because |
|---|---|---|
| A restore reports the entries its manifest names and could not lay down | capture x and y; keep a copy of `manifest.json`; rewrite x and capture (x's old blob is removed); put the copy back; restore. The result lists x and counts y. A clean store lists none. | the result has no such field; its keys are `restored`, `trackedWins`, `overlaid`, `authRestored`, `digest` (`suite-store.port.ts:16-30`). The same sequence is the investigation's probe, which loses x with the ENOENT line. |
| A snapshot taken before a capture that rewrote an entry restores whole | capture x and y; export; rewrite x and capture; restore the snapshot; clear the working copy; restore. x has its first content, the digest equals the digest before the rewrite, the typed list is empty, the blob set equals the snapshot's. | there is no verb, and the only route (the manifest copy above) loses x |
| A snapshot that is not whole is refused and the store is untouched | delete one blob from the snapshot; and a manifest-only snapshot (the shape of the five operator files). The restore rejects naming the blob; the store's manifest bytes and blob set are unchanged. | no verb |
| Export refuses a store it cannot read whole | remove one blob; export rejects and leaves no directory. | no verb |
| Restore keeps provenance and adds no pin | after restore, the entries equal the snapshot's; a tracked path whose git blob differs goes to `trackedWins` as in `restore` today. | no verb |

- **Existing tests that change:** the whole-result assertion at `suite-store.adapter.test.ts:102` gains the new field; the hash-mismatch test at `:391-407` also asserts the typed list.
- **Differential check:** `seed-store`, a capture and a restore are run against a copy of the base commit in a scratch directory and compared (stdout, stderr, exit code). The expected difference is the added field and its announcement text, nothing else.
- **Ownership test:** the scan above, with a synthetic tree that fails it.

## Measurement

The signal that shows the cause gone, on a run: the restore span's typed list is empty, its digest equals the one the restore verb printed for the snapshot, and no "cannot be read" line appears. Conditions are ADR-0011's: the baseline's launch parameters, the freeze off, the 12-entry suite, and one replicate (the recommended count; the owner has not confirmed it for after-measurements). Correction 2026-10-30: the count is decided, one replicate per version ([ADR-0013](../adr/0013-owner-decisions-remaining-questions.md)).

| | Restore span | Capture span | Source |
|---|---|---|---|
| Before: baseline `run-ed28973-mvs7oo0f-17041c71` (4105c582, pass), from a snapshot naming 13 | restored 12, digest fc7ad52e; 13 named (a17480c9 when all are laid down, #29), so 1 not laid down; 1 "cannot be read" line (Loki, refutation) | entries 15, admitted 3, dropped 1 | history database |
| After: one replicate on the fix, started from the new 12-entry snapshot put back by the restore verb | restored 12, digest fc7ad52e, typed list empty, no line | dropped 0 for this cause (hypothesis) | to be measured |

The 12-entry snapshot is taken from the live store by the export verb, with `flows/user-account.spec.ts` left out. Its digest must print as fc7ad52e before the run; that is the proof it is the baseline's suite. Precondition, from the refutation's read-only listing on 2026-10-28 (manifest generation 7, 13 entries, one blob missing) and not re-read here: the 12 blobs are still intact. The export checks it and fails if not.

- **Unproven on a run, by design.** The trigger needs a second replicate after an accepted capture that replaces an entry. With one replicate the after-run shows only that the start is whole. The tests carry the proof of the trigger; the run is reported as a direction, never proof (ADR-0011, rule 3).
- **No verdict or coverage effect is expected.** Do not read a coverage difference between the two replicates as this fix. Identical inputs spread widely (cycle 3: line coverage 0.738 to 0.904).
- **The before is the baseline** unless the owner makes the replicate after platform step 1 the new before (ADR-0011, not decided there; Correction 2026-10-29: decided as recommended in ADR-0013, the replicate after step 1 is the new before). Either way the start is the 12-entry set.

## Owner decisions needed

- **F1. The write of the reset moves into the adapter; the rule stays the skill's** (the 2026-10-26 instruction above says "never engine code"). Recommended: yes. What to drop and when stays the skill's; how the store's files are written is the adapter's, as `seed()` already is for the experiment harness (`scripts/warm-suite.ts:452-466`). If no: O0 with a whole-directory copy, accepting that the repository can neither test nor gate it.
- **F2. The restore result carries "named but not restored".** ADR-0002 leaves this to this RFC. Recommended: yes, one additive list of paths, a count on the restore span, a line in the setup announcement; no union and no run-ending outcome, because store faults stay off-path (`AGENTS.md:608`). If no: rely on the verbs' proof alone.
- **F3. Where a self-contained snapshot lives.** Recommended: the data volume beside the store, which the agents container never mounts. It is not the untracked benchmarks folder in the working tree, where the five manifest-only files sit one `git add` from the repository. Those five stay as a record and are refused by the restore.
- **F4. Order.** The approved order is H06, H11, H20 ([ADR-0002](../adr/0002-architecture-direction.md), Decision 2). Recommended: move this change ahead of the after-replicates of [RFC-0003](./0003-coverage-dump-harvest.md) and [RFC-0004](./0004-log-level-from-outcome.md). Each needs the 12-entry snapshot with its blobs (D13). Today the only route the loop charter prescribes (`odd/tasks/campaign-loop.md:8`) is the manifest-only procedure that fails. A whole-directory copy or `seed-store` also puts a 12-entry set back (O0), but neither is tested or proven in the repository. The reason is therefore a proven, gated route before the replicates that depend on it, not necessity. If no: keep the approved order and use O0 for the interim replicates, accepting that its result is unproven.
- **F5. A replicate checked against a digest outside its campaign.** Recommended: not in this change. The verb prints the digest and each run records its own, so the comparison for the one after-replicate is by eye. Revisit if a campaign again starts from a suite nobody intended.

The authority to fix H20 at all is D12, approved on 2026-10-28 (translated): "Regarding the 13 recommendations I agree with everything". The brief fixes the rule for the forks above: "If a fix needs a product or architecture decision, STOP and ask me — do not choose."

## Out of scope

- The reset rule: which entries a campaign drops, and when it resets.
- The freeze and the campaign contract ([ADR-0009](../adr/0009-campaign-freeze-on-server.md)); a digest declared in the campaign record (F5).
- A capture that drops an entry whose blob could not be read at restore (`suite-store.adapter.ts:360-367`). With one writer it needs disk damage or a hand edit, never observed; the typed field makes it visible.
- Whether the lost annotations or the lost spec changed any plan or verdict: not enough evidence.
- The contamination direction (#7, #8, #9, #16, #20), the engine campaign runner's `seed()` path, and the level of the store's log line ([RFC-0004](./0004-log-level-from-outcome.md), which edits the same two lines, `suite-store.adapter.ts:476` and `:478`; the order is free).
