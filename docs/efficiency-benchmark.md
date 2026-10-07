# Efficiency benchmark: operator note

Run the same real cases against `main` and against a candidate, three times each, then compare what
the agent did (calls before its first write, steps used against its step limit, sessions) and whether
quality held (verdict, specs, gates). It is **telemetry only**: it never gates a run, never changes a
verdict, never alters an exit status, is not run by CI and never blocks applying or merging a change.
A person reads the report and decides.

## Quick path

1. Once per OpenCode pin, re-record the `GET /agent` fixture on the pinned build
   ([Before the first run](#before-the-first-run-on-an-opencode-pin)).
2. Copy `config/benchmarks/efficiency-cases.example.json` to `config/benchmarks/efficiency-cases.json`
   (gitignored: it names real commits) and fill in the cases ([Cases](#cases)).
3. On `main`, three times with three labels: `run`, then `snapshot`.
4. On the candidate, the same, with three other labels and the **same cases file**.
5. `report` each main/candidate pair and read it against [the criteria](#success-criteria-and-guardrails).

Every command runs inside the orchestrator container, which holds the service's control API and the
run history. `config/` is bind-mounted there, so the cases file and the snapshots survive the rebuild
between the two sides.

```bash
docker compose exec orchestrator npm run efficiency-benchmark -- run main-1
docker compose exec orchestrator npm run efficiency-benchmark -- snapshot main-1
# ... main-2, main-3, then rebuild on the candidate and repeat as cand-1, cand-2, cand-3 ...
docker compose exec orchestrator npm run efficiency-benchmark -- report main-1 cand-1
```

| Command | Does |
|---|---|
| `run <label> [--timeout-minutes N]` | submits every case through the service's queue, one at a time; stops at the first case that outlives N minutes (default 30) |
| `register <label> <case> <runId>` | attaches a run you already have to a case of the label |
| `snapshot <label>` | freezes the label's runs, and each case's declared tier, into `config/benchmarks/efficiency-results/<label>.snapshot.json` |
| `report <labelA> <labelB>` | compares two snapshots, case by case, then prints the step use of each label |

The queue must be idle before every case (a benchmark must be the only work against DEV): `run` refuses
to submit while anything is running or pending. Take the snapshot soon after: the runs' own records
are pruned after 30 days, and a snapshot never overwrites one that would lose measurements. Labels use
letters, digits, `.`, `_` and `-`.

## Before the first run on an OpenCode pin

The candidate's prompts state the step limit their runtime enforces, read live from the OpenCode server
(`GET /agent`, the agent's `steps`; a configured `maxSteps` comes back as `steps`). The reader is tested
against a recording of that answer, `src/integrations/fixtures/opencode-agent-list.json`, and the
recording comes from an older build than the one `agents/Dockerfile` pins (`OPENCODE_VERSION`); the
fixture's README names both. Until it is re-recorded on the pinned build, nothing shows that the pinned
server answers the way the reader expects, and a different answer would leave every prompt without a
limit, which the benchmark would then report as an efficiency change.

1. Run the pinned `opencode serve` in isolation: throwaway HOME and XDG directories, an empty
   environment, no credentials, loopback only, `OPENCODE_CONFIG` pointing at a throwaway config with the
   agents the README lists (one configured with `maxSteps`, one with `steps`, one with both, one with
   no cap).
2. Request `GET /agent?directory=<dir>`, apply the edits the README lists (prompts removed, the data
   directory scrubbed, native agents dropped, one permission rule per line) and replace the fixture.
3. Update the README's version line and run `npm test`. A failing parser test means the pinned build
   answers differently from the recording: settle that before the benchmark.
4. Stop the server before moving on.

## Cases

| Need | How the cases file expresses it |
|---|---|
| At least 2 apps, in shadow mode | cases for two apps; `qa.shadow: true` in each `config/apps/<app>.yaml`, so no PR or Issue is opened |
| At least 3 tiny single-commit diffs | three `diff` cases, each with its own `sha`, no `baseSha`, and `"tier": "tiny"` |
| The deliberate no-op | a `manual` case whose guidance names a change with no user-visible behavior; the right outcome is `skipped` |
| One code case | `"target": "code"` |
| One complete case | `"mode": "complete"` |

`name`, `app` and `sha` are required; `baseSha`, `mode`, `target`, `guidance` and `tier` are optional.
`tier` is one of `tiny`, `focused`, `broad`: the size class **you declare** for the case's diff, using
the boundaries in `DIFF_TIERS` (`qa-engine/src/contexts/generation/domain/diff-stat.ts`: tiny is at
most 2 files and 40 changed lines, focused at most 8 files and 400, broad above). The benchmark does
not measure the diff and never sends the tier to the service; it only groups the report. A value that
is not a size class fails the load, naming the case. A case with no tier reads `undeclared`.

## What the report adds

```text
case: app-a-checkout
  main-1:
    tier tiny · sessions total 3 · generator 1
    turn round 0: ... · steps used 40 · max steps 40 · step use 1.00
    first pass: calls 24 · before 1st write 14 · ...
    generator: step limit hit
    guardrails: ... · error class E-STEP-BUDGET · pre-exec ambiguity catches n/a · deterministic selector blocks n/a · catalog gate fail-closed n/a
...
step use of the generator's turns (...):
  main-1: mean 1.00 · known 1 · unknown 1
  cand-1: mean 0.31 · known 2 · unknown 0
```

The numbers above are illustrative.

| Figure | Meaning |
|---|---|
| `tier` | the size class the case declared |
| `sessions total · generator` | distinct agent sessions of the run that recorded at least one turn; the generator's own count leaves out the planner's turn |
| `steps used`, `max steps`, `step use` | per generator turn: steps taken, the limit the turn's end was classified against (the number its prompt stated, else the orchestrator's own copy of the configured limit), and their ratio |
| `generator: step limit` | `hit` when any generator turn ended on its step limit, `not hit` when every one is known not to have, `n/a` otherwise (a Codex-primary run has no step budget, so it is always `n/a`) |
| the three gate counters | `preExecAmbiguityCatches`, `deterministicSelectorBlocks` and `catalogGateFailClosed`, from the run's recorded outcome |
| `mean · known · unknown` | the label's mean step use over the turns whose ratio is known, and how many turns were left out |

**`n/a` is never zero.** A figure the run did not record reads `n/a`. `steps used` is `n/a` unless the
turn's steps were observed completely; with no limit `max steps` is `n/a`, and a limit that is not a
positive whole number leaves `step use` `n/a`; a gate counter is `n/a` when its gate never ran, while a
recorded `0` is a real zero; `sessions n/a` means the run recorded no turn (it made none, or they were
pruned). Unknown figures stay out of every aggregate and are counted beside it. A label whose turns
are mostly `unknown` says little about step use: report that criterion as inconclusive, not passed.

**A `max steps` figure does not prove the prompt stated it.** When the live limit read fails, times out
or finds a role's agent without a cap, the prompt states nothing while `max steps` can still show the
orchestrator's own copy of the configured limit. The orchestrator log of the run then carries a `[qa]`
warning (`no step limit for role ...`, or the step limits `are unavailable` / `could not be read`).
Check the log before reading a candidate's `step use` as the effect of stating the limit.

## Open question: does the step count reset every turn?

Each prompt says `This turn runs at most N steps`. The sentence is true either way: it is exact if the
runtime counts steps per prompt turn, and if it counts across the session a turn can only end sooner.
What is not settled is which one the runtime does. Reading the cap per turn rests on the SDK's
description of it and on the recorded step-limit notice, not on a live capture. The report assumes it:
`step use` divides one turn's `steps used` by its `max steps`.

The evidence to look for is a run that reports `generator: step limit hit` while its generator turns
share a session (the `generator` session count is lower than the number of `turn` lines) and every
one of those turns shows a known `steps used` below its `max steps`: the cap was reached on steps
counted in earlier turns. Note such a run when you see one. Until the question is closed, read
`step use` as a per-turn ratio, not as how close a session came to its cap.

## Success criteria and guardrails

Judge each side on its three labels together: pool the cases of the three labels for the rate and the
median, and compare the three per-label step-use means.

| Criterion | Passes when | Read it from |
|---|---|---|
| Tiny-diff step-budget rate | the candidate's rate is at most half of `main`'s (aim: zero) | cases with `tier tiny` whose guardrails line says `error class E-STEP-BUDGET`, over all tiny cases |
| Calls before the first write | the candidate's median is at least 25% lower | `before 1st write` on each case's `first pass:` line |
| Step use | the candidate's is lower | the `mean` lines at the end of each report |

Guardrails must be no worse than `main`'s: verdict mix, `specsProduced`, `staticPass`, `executePass`,
`coverageRatio`, `reviewerApproved`, and the three gate counters above. The report names every
guardrail whose value differs between the labels on a `guardrails changed:` line; the benchmark does
not decide which direction is worse, you do. The deliberate no-op case must still end `skipped`.

## Checklist

- [ ] The `GET /agent` fixture was re-recorded on the pinned OpenCode build, and its test passes.
- [ ] The cases cover the five kinds above, and the apps run in shadow mode.
- [ ] The same cases file served both sides, and the queue was idle before every `run`.
- [ ] Three labels per side, each snapshotted before its records aged out.
- [ ] Every `n/a` and every `unknown` count was noted, not read as zero.
- [ ] No candidate run logged a `[qa]` warning that a role's prompts state no step limit, or each one
      was noted against its case.
- [ ] Each criterion and guardrail was read for the pooled side, and the no-op still ended `skipped`.

Source: `scripts/efficiency-benchmark.ts`, with the tracked example at
`config/benchmarks/efficiency-cases.example.json`; the live limit read is `stepLimits` in
`src/agent-runtime/`, and the fixture's README is `src/integrations/fixtures/README.md`.
