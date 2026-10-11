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

## Time budget per tier

A diff run's generator first pass is bounded by its tier's wall time (`DIFF_TIME_BUDGET_MS`: tiny 6 min,
focused 12 min, broad none). To measure how much time a tier really needs, set these on the
orchestrator (`.env` or Doppler) and restart it; no rebuild is needed:

| Variable | Tier | Accepts |
|---|---|---|
| `QA_DIFF_TIME_BUDGET_MS_TINY` | tiny | a positive whole number of milliseconds, or `none` |
| `QA_DIFF_TIME_BUDGET_MS_FOCUSED` | focused | the same |
| `QA_DIFF_TIME_BUDGET_MS_BROAD` | broad | the same (the default is no bound) |

Unset or blank keeps the default, `none` removes the tier's bound, and anything else (`6min`, `0`, `1.5`)
stops the composition with an error naming the variable. The value is still clamped by the transport's
own prompt deadline (`agentPromptCapMs`): a budget at or above it is not a bound, the host's deadline
fires first. A cut run's note states the time it was actually given.

## Probe: what one pipeline run did, and a plain agent for comparison

The benchmark above compares the pipeline with itself. To decide whether the pipeline beats a plain
agent (the whole repo, a short prompt, and the ability to run its own spec), both arms emit the same
metrics shape (`scripts/probe-metrics.ts`) and one reads the two reports side by side. Everything
here is telemetry: it never gates a run. A figure that was not measured reads `n/a`, never `0`.

`probe-report` describes a run the pipeline already made. Run it in the orchestrator container, right
after the run (the working copy still holds the specs then):

```bash
docker compose exec orchestrator npm run probe-report -- <runId> [<runId>...] [--json]
```

It prints a table of the runs and one of their agent turns, and writes each run's full report, with
the ordered tool sequence of every turn, to `config/benchmarks/probe-results/<runId>.json`
(gitignored). `--ground-truth <file>` adds the stitcher figures' companion, a score of the run's evidence against a
hand-written answer: see [Cross-repo case](#cross-repo-case).

| Figure | Source |
|---|---|
| verdict, error class, note | the run's outcome and record |
| total time and per-phase time (gate, classify, setup, grounding, generation, validate, execute, coverage, decide) | the `step.changed` events the run already records: a phase lasts until the next step change; `grounding` is the pre-generation sub-step of `generate`; a phase the run never entered is `n/a` |
| explorer, page capture, review time | the explorer's and the reviewer's turn durations; the page capture is the grounding time minus the explorer's |
| turn wall time, time to first call, time to first write, calls before first write, denied calls | `agent_turns` (`duration_ms`, `time_to_first_call_ms`, `time_to_first_write_ms`, `calls_before_first_write`, `denied_call_count`), measured by the call tracker; a turn recorded before those columns existed reads `n/a` |
| steps used / max, calls, buckets, redundant and prompt-provided reads, prompt bytes | `agent_turns`, as in the benchmark |
| tokens in/out/reasoning/cache and cost | `agent_turns.usage_total`, summed over every step the turn finished. Older rows only have the last message's usage (the `*` in the table), which understates a many-step turn; a turn that timed out recorded none before `usage_total` |
| files read, outside the diff's directories, outside the explorer's brief, browser URLs | the turn's ordered tool sequence (`agent_turns.tool_sequence`: tool plus the redacted, capped file, pattern, URL or command each call pointed at; never what the agent typed or wrote). "Outside the diff's directories": a file not under any directory that holds a changed file, and not under `e2e/`; "outside the brief": a file whose path the explorer's output does not contain |
| specs (paths, line counts) | `spec.written` events and the run record; line counts are read from the working copy through the confined reader, so a spec the next run cleaned away is `n/a` lines |
| change-coverage status and ratio | the `coverage.computed` event (or the outcome's ratio) judged against the app's policy minimum |
| reviewer verdict | the `reviewer.verdict` event |

### The plain-agent arm: `baseline-agent`

Experiment only; nothing in the service calls it. It gives one agent what a developer with a coding
agent has (the whole repository at the commit, a short prompt, the live DEV site, a Playwright runner)
and none of the pipeline's stages: no explorer, grounding, context map, reviewer, regeneration or
deterministic gate. Run it in the orchestrator container, with the queue idle (it refuses otherwise,
like `efficiency-benchmark run`: DEV is used by one thing at a time):

```bash
docker compose exec orchestrator npm run baseline-agent -- --app <app> --sha <sha> --timeout-min <n> --label <l>
docker compose exec orchestrator npm run baseline-agent -- --app <app> --sha <sha> --label <l> --dry-run [--check-auth]
```

| Aspect | How |
|---|---|
| Isolation | a throwaway clone of the app's mirror at the commit, under `<mirrors>/.baseline/<label>` (the mirror pruning never touches that directory). The clone has no remote, the real mirror is only read, and nothing is pushed. The commit must already be in the mirror (the pipeline fetched it on its first run of that commit). `--keep-copy` keeps the copy; otherwise it is removed at the end |
| Suite and dependencies | the pipeline's own setup step (`buildSetupAdapter().setup`): the `config/e2e` seed when the repo has no `e2e/`, the managed fixtures, and the dependency install |
| The agent | `qa-baseline`, defined in an `opencode.json` at the root of the copy. The server resolves its configuration per session directory, so the agent exists only there, with no entry in `agents/opencode.json`. Model, step cap and temperature are the generator's, read from `agents/opencode.json` and cross-checked against what the server resolves for `qa-generator` (a stale copy stops the run) |
| Tools | read, glob, grep, list, edit/write, the Playwright browser's navigate, snapshot, click and type, and a shell that can only run `npx playwright test*`. No web fetch, no sub-agent, no serena or engram; `doom_loop` and `external_directory` denied; `.env` files unreadable. Before any session the runner asks the server for the rules it resolved and checks a set of probes against them (a shell command outside Playwright, a code-running browser tool, a web fetch...); a mismatch stops the run before a token is spent |
| Prompt | the commit message, `git show --stat` and the full diff (cut at 200 000 characters, redacted by the engine's sanitizer), after five or six lines: write Playwright tests under `e2e/` for this change against the live DEV site, run them with `npx playwright test` and iterate, or say NOOP and why, prefix created data with the app's `qa.testDataPrefix`. If the automatic login did not work for the app the prompt says so and names `npx playwright test --project=setup` |
| Authentication | the same login the pipeline's harness makes, in the orchestrator (the credentials never enter a file the agent can read): a session in an orchestrator-side directory beside the copy, which a small wrapper around the repo's own `playwright.config.ts` injects with the non-secret `PW_*` values. The wrapper also points Playwright at the headless shell the agents container has, because that container carries the MCP server's browsers, not the build the project's Playwright pins. The basic-auth credentials (`DEV_ENV_*`) are already in the environment of both containers |
| Timeout | `--timeout-min` is a wall-clock limit on the session; at the limit the session is aborted and whatever it wrote is judged |
| Metrics | the session's messages are replayed through the pipeline's own call tracker, so calls, buckets, denied calls, time to first call and first write, tool sequence and steps mean the same as for a pipeline turn; tokens and cost are summed over every step |
| Verdict | the specs the agent added are run twice with the repo's Playwright runner (`runE2E`), after the login is made again with whatever `auth.setup.ts` the agent left: both green `pass`, both red `fail`, one of each or a pass only on retry `flaky`. No spec and NOOP is `skipped`; no spec and no NOOP is `infra-error` `E-NO-DECISION`; the clock or the step cap with no spec is `E-TIME-BUDGET` or `E-STEP-BUDGET` |

It writes `config/benchmarks/probe-results/<label>.json` in the shape `probe-report` emits, with the
arm-specific facts under `detail` (what the agent changed outside `e2e/`, its closing words, each suite
run), and prints the same markdown rows. `--dry-run` prepares the copy, prints the prompt and the
permissions the server resolved, and starts no session; `--check-auth` also makes the one login.

### Warm start

A watched app's suite starts every run from the stock seed, so every run first has to author the app's login.
To compare the arms on the change itself, both start each case from the same snapshot of `e2e/` that holds a
working `auth.setup.ts`, and no case sees the specs a previous one left. `warm-suite` (run in the orchestrator
container; `snapshot` and `restore` refuse unless the queue is idle) manages the snapshots under
`<mirrors>/.warm/<app>/<label>/` (`e2e/` plus `manifest.json`, which lists every file with its sha256 and what
was left out):

```bash
docker compose exec orchestrator npm run warm-suite -- snapshot --app <app> --label <l>
docker compose exec orchestrator npm run warm-suite -- verify   --app <app> --label <l>   # exit 0 = warm
docker compose exec orchestrator npm run warm-suite -- restore  --app <app> --label <l> [--dry-run]
```

A snapshot leaves out `node_modules`, `test-results`, `playwright-report`, `blob-report`, `.serena`, `.git`,
`.qa/coverage`, `.qa/fault-injection`, `.qa/measured.json`, logs, the login session (`.auth/`, any
storage-state file by content) and credentials (`.env*`, keys and client certificates, `.har` files); links are
never followed. The mirrors volume is mounted into the agents container, so nothing in a snapshot may be a
secret. `restore` makes the mirror's `e2e/` equal to the snapshot (extra specs, directories, `.qa` state and
run output are removed; `node_modules` is kept so nothing is reinstalled) and prints what it added, replaced
and removed. `verify` is warm when the snapshot's `auth.setup.ts` exists and no longer carries the
`qa-auth-setup-seed` marker. Take the snapshot after the app's login has been authored and before any case
spec exists, restore it before every pipeline case, and pass the same label to the baseline arm:

```bash
docker compose exec orchestrator npm run baseline-agent -- --app <app> --sha <sha> --timeout-min <n> --label <l> --warm <snapshot-label>
```

With `--warm` the copy's `e2e/` is made equal to the snapshot before setup and the dependency install, the
prompt says nothing about the login (the session is injected as usual), and the specs the snapshot held are
not counted as the agent's. A cold or missing snapshot, or a warm login that cannot log in, stops the case.

Shadow mode starts cold every run: it never opens a PR, so `e2e/` is never tracked, and the per-run
`git clean -fd` on the mirror deletes it (the stock `auth.setup.ts` is seeded again and the generator
authors the login again). To let a suite accumulate across pipeline runs, or to keep a restored snapshot
through the next run, set `QA_PRESERVE_UNTRACKED_SUITE=1` on the orchestrator (`.env` or Doppler; it is passed
through `docker-compose.override.yml`) and restart it. The clean then leaves the primary repo's spec directory
alone (`git clean -fd -e node_modules -e /e2e/`) and cleans everything else as before. Unset, blank, `0` and
`false` keep today's behavior, and any other value stops the composition with an error naming the variable.
It is not a cache of what a published suite holds: `git checkout -f` still overwrites a file that collides
with a path the checked-out commit tracks (git's own rule, untouched), and a tracked suite also keeps the
untracked files an earlier run left in `e2e/`. A service repo's mirror and code-target runs are cleaned as usual.

Differences between the arms that the numbers do not hide:

- The agents container's global `instructions` (`agents/AGENTS.md`, the pipeline's shared rules) apply
  to every agent the server runs, `qa-baseline` included: this arm is "a plain agent" plus those shared
  rules. A project config cannot remove them. If that matters, run the arm on an `opencode serve` whose
  config has none.
- The pipeline's change-coverage, static gate and reviewer do not exist here, so `change-coverage` and
  `reviewer` read `n/a` for this arm. The two arms' tokens and cost are comparable only for turns whose
  usage is summed over every step (no `*`).
- The agent can run `npx playwright test` from a directory other than `e2e/` and the shell patterns
  cannot stop it; the prompt names the working directory. A command chained after an allowed one is
  checked by the server command by command.

### Cross-repo case

The question here is narrower than "which arm writes a better test": **does the cross-repo stitcher (service
links, contracts, code graph) help the agent find front-end code a backend change affects, when nothing in the
backend diff points at it?** One case is fixed beforehand: service `joomeco/ms-name-users` at `d842b71a619e5a6a84d1a7966d74c670285cdaa8`
(domain-only; adding a duplicate delivery address now throws a 409; no OpenAPI change), seen from the app
`name-webapp`. Its ground truth is `config/benchmarks/ground-truth/name-webapp-address-duplicate-409.json`
(gitignored app data; the neutral `config/benchmarks/ground-truth.example.json` ships). It lists the affected
files (`address.api.ts`, `address.store.ts`, `address-form.page.ts`), the affected route (`/user/address/new`) and
the read-only consumers that must not be credited (`order-delivery`, `location-picker`, `user.page`).

**Before either arm** (both need DEV to themselves): the queue is idle, the warm snapshot is restored (see
[Warm start](#warm-start); `QA_PRESERVE_UNTRACKED_SUITE=1` keeps it through the pipeline's clean), and the app
is in shadow mode (a webhook cannot set it; `GET /api/apps` shows `shadow` and `services`). At the time of writing
`name-webapp` is `shadow: true`, declares `joomeco/ms-name-users` (the only app that does) and has no
`versionUrl` anywhere, so the deploy gate is skipped.

**Arm B, the pipeline's cross-repo run.** The webhook is the only path that runs the suite of the app that
*owns* a service from that service's commit: `POST /api/runs` and `npm run qa` always run the app's own commit and
never carry a trigger repo. A POST of `{repo, sha}` for a service repo resolves to every app that declares it and
enqueues a diff-mode e2e run of each (diff, classify and gate from the service mirror, suite from the app's
mirror; `mode` and `baseSha` in the payload are ignored for a service). From the host, which publishes the
orchestrator on port 458:

```bash
curl -s -X POST http://localhost:458 -H 'content-type: application/json' \
  -d '{"repo":"joomeco/ms-name-users","sha":"d842b71a619e5a6a84d1a7966d74c670285cdaa8"}'
# 202 {"message":"enqueued"}
```

Signatures: with `WEBHOOK_SECRET` set the request must carry `x-hub-signature-256: sha256=<hex HMAC-SHA256 of the
raw body>`, otherwise it is a `401`; with no secret the orchestrator fails closed unless `WEBHOOK_ALLOW_UNSIGNED=true`
(the state of the running container when this was written: no secret, unsigned allowed, so the command above works
as is). With a secret, run it inside the orchestrator, which has the variable:

```bash
docker compose exec orchestrator sh -c 'BODY='"'"'{"repo":"joomeco/ms-name-users","sha":"d842b71a619e5a6a84d1a7966d74c670285cdaa8"}'"'"'
  SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '"'"'{print $NF}'"'"')
  curl -s -X POST http://localhost:${PORT:-458} -H "content-type: application/json" -H "x-hub-signature-256: sha256=$SIG" -d "$BODY"'
```

The answer carries no run id: read it with `GET /api/runs?app=name-webapp&limit=1` (Bearer `QA_API_TOKEN`, or the
TUI), then, **right after the run and before anything else touches the app's mirror**:

```bash
docker compose exec orchestrator npm run probe-report -- <runId> \
  --ground-truth config/benchmarks/ground-truth/name-webapp-address-duplicate-409.json
```

**Arm A, the plain agent.** Run it after arm B (it never fetches: it uses the mirror's `origin/<baseBranch>` as
the last pipeline sync left it, so B's sync is what makes both arms see the same app commit; the arm prints it, and
records it as `detail.service.primarySha`, to compare with `git -C /app/.mirrors/joomeco__name-webapp rev-parse HEAD`
after B). The service must be one the app declares.

```bash
docker compose exec orchestrator npm run baseline-agent -- --app name-webapp \
  --service joomeco/ms-name-users --service-sha d842b71a619e5a6a84d1a7966d74c670285cdaa8 \
  --timeout-min <n> --label <l> --warm <snapshot-label> \
  --ground-truth config/benchmarks/ground-truth/name-webapp-address-duplicate-409.json
```

| Aspect | How |
|---|---|
| Copy | the app at its base branch's head (as in the pipeline run), not at a service commit; the suite lives there |
| Prompt | the service commit's message, stat and diff, a line saying the change is deployed on DEV and where its source is, and the request for tests of the front-end behavior it affects. No page, route or component is named |
| Service source | the service's files at the commit under `services/<repo>/` in the copy (a clone of the service mirror, checked out, its git data removed), outside the suite directory. Readable and searchable, fenced against every write tool; the shell stays Playwright-only. The server's resolved permissions are probed for the fence before any token is spent |

**What the report adds** (both arms, `### Stitcher signals` and `### Ground truth` in the markdown, `stitcher` and
`groundTruth` in the JSON):

| Figure | Meaning |
|---|---|
| `serviceLinksCount`, `contractDriftCount`, `structuralSignalBytes`, `crossRepoImpactedCount` | the run's recorded gate signals; `n/a` when the resolver was not wired (it needs `services[]` and `boundaries[]` in the app and `qa.structuralSignals.mode` not `off`), and always `n/a` for arm A, which has no stitcher |
| prompt `service-links`, `blast-radius`, `co-change` bytes | whether the generator's first-pass prompt carried each advisory section (`absent` or its bytes, up to the next level-2 heading); for arm A it is its own prompt, so always `absent` |
| ground truth, per source | **brief blast radius** (the files in the explorer brief's `blastRadius`; arm B only), **files read** (content reads of every agent turn; a path matches by its tail, so absolute paths and `:line` suffixes count) and **spec routes** (`page.goto` literals of the generated specs, origin, query and trailing slash removed; a route built at run time is counted in `dynamicGotos` and not scored) |
| `hits`, `misses`, `false positives` | affected items reached, affected items not reached, and items the ground truth says are not affected that the source named |
| `precision`, `precision-all`, `recall` | hits / (hits + false positives), over what the ground truth can judge; affected items named / all items named (what is neither affected nor rejected counts as wrong); hits / affected items |

A source that could not be observed (no brief in arm A, no tool sequence, no readable spec) reads `n/a`, never a
zero score. Read the arms with the asymmetry in mind: B is given curated context (links, contracts, graph, the
service's staged context), A the raw service source and diff; "files read" for A includes service files, which the
ground truth neither credits nor rejects (they show as unjudged).

## Success criteria and guardrails

Judge each side on its three labels together: pool the cases of the three labels for the rate and the
median, and compare the three per-label step-use means.

| Criterion | Passes when | Read it from |
|---|---|---|
| Tiny-diff step-budget rate | the candidate's rate is at most half of `main`'s (aim: zero) | cases with `tier tiny` whose guardrails line says `error class E-STEP-BUDGET`, over all tiny cases |
| Tiny-diff time-budget rate | the candidate's rate is at most half of `main`'s (aim: zero) | cases with `tier tiny` whose guardrails line says `error class E-TIME-BUDGET`, over all tiny cases |
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
