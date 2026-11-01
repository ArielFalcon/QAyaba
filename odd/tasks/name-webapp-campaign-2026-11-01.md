# name-webapp campaign 2026-11-01 — verdict evolution

Objective: re-run the last two campaigns (the same two commits, the same scope) with 2 replicates each on the current code, and read the verdict evolution from telemetry, not from impressions. Every number here comes from the run history (`runs`, `run_outcomes`, `agent_turns`, `run_spans`), the app mirror's own git, or the campaign runner's log; nothing is estimated.

## 1. What was run

| Campaign | Runs | Scope | Engine label | `engine_version` recorded |
|---|---|---|---|---|
| A (baseline) | 5 | 3 commits per change | `e7adef68` | `0.1.0+46660634` |
| B (first attempt) | 4 | 1 commit per change | `a56d9a64` | `0.1.0+a56d9a64` |
| C (corrected) | 4 | 3 commits per change | `a56d9a64` | `0.1.0+a56d9a64` |

Campaign B was discarded as a comparison: its scope did not match A. It is kept below only because it is the one set that ran on the *same* engine as C with a different scope, which makes the plan-budget observation in §5 engine-scoped rather than campaign-scoped.

Scope verified in the app mirror (`/app/.mirrors/joomeco__name-webapp`):

| Commit | 1 commit | 3 commits |
|---|---|---|
| `2de1f7a7` | 245 files, +3124/−2535 | **281 files, +3788/−2616** |
| `ed28973` | 12 files, +96/−191 | **80 files, +1528/−537** |

Every run used the same suite-store snapshot (`campaign-2026-11-01-a56d9a64-pre`, digest `fc7ad52e…f416`), restored before each replicate, and every run is `arm: B`, `config: alcala`, shadow, frozen (a campaign run learns nothing and writes no store).

## 2. Verdict evolution

### `2de1f7a7`, 281 files — the change neither campaign's baseline survived

| Set | Run | Verdict | Total | Flows | Coverage | Branch | `run_spec` |
|---|---|---|---|---|---|---|---|
| A r1 | `d8j` | `infra-error` `E-NO-AUTHOR` (`plan-rejected:no-plan`) | 2.6 min | 0/0 | — | — | 0 |
| A r2 | `0hp` | `infra-error` `E-NO-AUTHOR` (`plan-rejected:no-plan`) | 2.6 min | 0/0 | — | — | 0 |
| C r1 | `584` | `infra-error` `E-TIME-BUDGET` (fix share) | 39.1 min | 9/9 | — | — | 13 |
| C r2 | `4tz` | `flaky` | 31.0 min | 6/6 | 0.304 | 38/111 | 18 |

The baseline produced nothing twice: the lead's plan was rejected and the run ended in 2.6 minutes. The corrected campaign planned, authored and executed both times — 9 and 6 flows delivered — and both times the run ended on a time limit rather than on a verdict about the change: `584` on the fix purpose's share, `4tz` on flakiness after 31 minutes, with 26 coordinated flows' worth of sessions and 4 DEV writes.

### `ed28973`, 80 files — the change the baseline did measure

| Set | Run | Verdict | Total | Flows | Coverage | Branch | `run_spec` | Reviewer |
|---|---|---|---|---|---|---|---|---|
| A r1 | `pvu` | `fail` (defect, no failing test) | 41.8 min | 5/5 | 0.769 | 53/132 | 16 | approved, 152 s |
| A r2 | `8hz` | `flaky` | 39.0 min | 5/5 | 0.901 | 71/132 | 17 | approved, 8 s |
| A r3 | `73z` | `fail` `E-EXEC-FAIL` | 12.9 min | 4/4 | — | — | 6 | did not reach |
| C r1 | `jtp` | `flaky` | 57.2 min | 4/4 | 0.859 | 58/100 | 15 | **rejected**, 2 rounds, 549 s |
| C r2 | `w6p` | `infra-error` `E-NO-AUTHOR` (`plan-timed-out`) | 4.8 min | 0/0 | — | — | 0 | did not reach |

`jtp` is the only corrected run that went through the whole pipeline on this change. Its coverage (0.859) lands between the two baseline measurements (0.769 and 0.901). Its branch ratio (58/100) is not comparable to theirs (53/132, 71/132): the branch rule this build carries leaves out the decisions the build adds, and each run records a different count of them (`skippedDecisions`: 45, 56 and 15 across the runs that recorded it). The reviewer rejected it after two rounds and 549 s where the baseline was approved in 8 to 152 s — the specs it delivered were judged differently, and that is a change in what the reviewer saw, not a quality score.

## 3. What these numbers support

- **The failure mode moved.** On the 281-file change the pipeline now reaches generation and execution (4 of 4 replicates past `plan`), where its baseline reached neither. On the 80-file change it reaches a full pipeline and a verdict in 1 of 2 replicates instead of 3 of 3 (the other died in planning in 4.8 minutes).
- **Time, not quality, ends the runs.** Of the 8 runs of sets B and C, 5 fired the lead's plan budget, 2 ended `E-NO-AUTHOR` from it, 1 ended on the fix purpose's share with 21 minutes unused, and the only run to finish the whole pipeline used 57.2 of its 60 minutes. No corrected run ended because its suite was judged bad.
- **The defect signal is stable and deterministic.** Every run that read the Context Pack — 4 baseline and 3 corrected — records the same fact: `activeMenuCuisineType` at `/home`, read by the consumer, absent from every live response of `GET …/restaurants/countries/ES`, undeclared by the provider's contract. It survives changes of engine, scope and replicate. `w6p` found it in a run that authored nothing.

## 4. What these numbers do not support

- **No quality comparison.** Two replicates per change and two runs ending on a budget cannot separate a change in quality from a change in luck. `jtp`'s 0.859 inside a baseline range of 0.769–0.901 is the honest summary: no evidence of improvement, no evidence of regression.
- **No attribution of the failure-mode change.** The baseline ran 70 commits behind the corrected set (`46660634..a56d9a64` is 77 commits), and the corrected set itself ran while main moved 4 more commits (`34a98d23`, `66bfd0ac`, `7891827b`, `e1c526aa`). The recorded `engine_version` comes from the image's baked `/app/REVISION`, and the code is bind-mounted, so that field names the image build, not the code the process loaded: set A records `46660634` while its own campaign metadata says `e7adef68`. Treat every cross-set comparison as confounded.
- **No reading of learning.** The lesson slice stays inert for this app: 144 observations, 0 admitted, every one left out under `served-version:undeclared` because the app declares no `dev.versionUrl`. Campaign runs also carry lessons off by design.

## 5. The two limits this cycle exposed

Both are recorded here because they are what the corrected campaign hit, and both were fixed in the code afterwards (`odd/tasks/deadline-reserve-and-reviewer-verdict.md`, commit `12d31926`).

- **The fix purpose's spent share ended the run.** `584` records `limits[0] = { fired: "allotment", role: "acceptance", purpose: "fix" }` at 39.1 of 60 minutes; its trace's `qayaba.phase.fix_loop` allotment reads `ms = 111328`, `reserve_ms = 1258365`, `reserve_source: measured`, `unmeasured: []`. 21 minutes were held for coverage and review on a suite that was red, so coverage could never run. The defect was two-fold: the fix acceptance never caught the share's `AllotmentSpentError` (the step's class made it the run's end), and the reserve was computed from the purpose list rather than from the purposes the run will enter.
- **The lead's plan budget is the most frequent limit and it is fatal.** `plan-budget` fired in 5 of the 8 runs of sets B and C and ended 2 as `E-NO-AUTHOR`: `plan-timed-out` at 3.7, 4.8 and 2.6 minutes. The 281-file `2de1f7a7` baseline died there twice, and one replicate of each corrected change died there too. This one is still open: it is not a defect of a reader or a clock, it is a capacity question (how much planning time a change of this size gets), and no run in this cycle answers it.

## 6. Observations left unconfirmed

- **The control plane stalled for about 4.5 minutes.** During the 281-file run the campaign runner's `GET /api/v1/runs/<id>` poll timed out nine times at 30 s in a row, while the run itself went on and finished. No span explains it: the longest spans in that window are agent turns. Recorded as an observation, not a diagnosis.
- **`run_spec` counts differ by instrument.** `agent_turns.tool_sequence` counts every call the model made (13 for `584`, 15 for `jtp`, 18 for `4tz`); `gateSignals.closedLoop.calls` is 0 to 4 lower (11 for `jtp`), because a call that is refused or never served is not counted there. Use the first for effort, the second for served calls.
- **One full-suite run failed a test this change does not reach.** `agent-browser-port.adapter.test.ts` ("an ended session closes its page and stops its call") failed once under the full parallel suite and passed on a later run of the same code. Load-sensitive, not diagnosed further.

## 7. Where the evidence lives

- Runner: `/private/var/folders/s7/…/opencode/qayaba-campaign-20261101/run-campaigns-b.sh`, logs `runner.log` and `runner-a.log`.
- Campaign ids: `main-a56d9a64-prev3-2026-11-01-b` (`2de1f7a7`), `main-a56d9a64-c3-2026-11-01-b` (`ed28973`).
- Per-run dumps: `results/*.json`, `signals.json` in the same directory.
- Run history: the orchestrator container's `/app/data/qayaba.db`, tables `runs`, `run_outcomes`, `agent_turns`, `run_spans`.
