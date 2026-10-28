# ADR-0009: The server freezes campaign runs

- **Status:** Accepted, 2026-10-28, owner
- **Decision source:** D10. On 2026-10-28 (15:32Z) the owner approved the recommendations D1-D13 together: "Regarding the 13 recommendations I agree with everything" (translated). The D10 recommendation the owner approved: "Server freezes every campaign-tagged run by default; a learning experiment declares its learning arm explicitly." Supporting words (translated): 2026-10-28 13:36Z, "The goal is that for several identical runs, qayaba behaves similarly, predictably and stably, delivering quality results"; 2026-10-28 14:14Z, "the idea is that the app 'evolves' with the app it tests, learning from errors and decisions between executions".
- **Code references at 4105c582:**
  - The freeze switch and what it withholds: `src/server/campaign-freeze.ts:9-16`, `src/settings/registry.ts:107`, `src/server/run-engine-factory.ts:760`, `:794-800`, `:809-811`, `:1144`, `:1459`, `:1466`, `:1476`, `:1508`, `:1526`, `docs/efficiency-benchmark.md:526-545`
  - Every other read of the switch: `src/server/login-bootstrap-wiring.ts:9`, `src/server/context-map-wiring.ts:36`, `src/server/wire-app.ts:275-279`, `src/server/runner.ts:114-125`, `:326-327`, `:367`, `:524`, `:721-722`, `src/settings/settings.ts:248`, `src/telemetry/bootstrap.ts:156`, `:233`, `src/telemetry/telemetry-health.ts:30`
  - The client-side guard: `scripts/campaign.ts:264-266`, `:216-218`, `:320`, `:586`, `:626`, `scripts/campaign-model.ts:149-150`, `scripts/campaign-report.ts:61-62`
  - What the server does with a campaign: `src/server/api/use-cases/create-run.ts:75-80`, `:95`, `src/server/runner.ts:80`, `:354-361`, `src/server/campaign-capture.ts:19-29`, `src/contract/commands.ts:144-151`, `:173-182`
  - What a run records: `src/server/effective-config.ts:62`, `:68`, `:72`, `src/server/wire-app.ts:333-340`, `src/server/persistence/repositories/run.repository.ts:332-338`
  - The contract this changes: `docs/observability-design.md:1041`, `:1143-1146`, `src/server/runner.campaign.test.ts:91`
- **Related:** [ADR-0001](0001-design-pillars.md), [ADR-0003](0003-learning-layer-rebuild.md), [ADR-0008](0008-product-version-source.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md)

**In one line:** a run that carries a campaign identity is frozen by the server unless its request declares a learning arm; the client-side check stops being the only guard.

## Context

A campaign compares runs of one commit. The freeze exists so that replicate 2 does not start from what replicate 1 taught the system. Today nothing on the server makes a campaign run frozen.

**What the freeze is.** A process-wide environment switch, `QA_CAMPAIGN_FREEZE`, read in five places (table below). At each run's composition (`run-engine-factory.ts:760`), when on, the run is built without the learning collaborators (rule store, reflector, process audit, curriculum: `:1459`, `:1466`, `:1476`, `:1508`), with the suite store read-only (`:1526`), and with the context-map heal inside the run skipped (`:794-800`, `:809-811`). Once at boot, the same switch leaves unwired the runner's two pre-run steps (below). Documented at `docs/efficiency-benchmark.md:526-545`; that text says the switch "is read once, in the composition root" (`:529`) and lists the rebuild (`:538`) but not the login bootstrap (table `:531-538`).

**Where it is guarded.** Only in the launcher script:

- `scripts/campaign.ts:264-266` refuses a pipeline arm when `QA_CAMPAIGN_FREEZE` is not on, unless `--skip-env-checks` is passed (`:218`, `scripts/campaign-model.ts:149-150`).
- The value it checks is the launcher's own environment (`scripts/campaign.ts:586`), not the server's, and the campaign record stores that same view (`:320`, `scripts/campaign-report.ts:61-62`: "as this process saw it").
- The script itself launches through the same `POST /runs` as any client (`scripts/campaign.ts:626`), so the server is where every door meets.
- The server has no check. `createRun` accepts a `campaign` and enqueues (`create-run.ts:75-80`, `:95`); `enqueueTrackedRun` checks only that a campaign's capture mode is uniform (`runner.ts:354-361`). The runner states that the campaign identity is "never passed to the engine, so it cannot change what the run does" (`runner.ts:80`).

**What happened.** The replicate launcher used for the baseline is an operator script outside the repository; it posted a hand-built `campaign` body straight to the API, so the check above never ran. The server accepted it.

| Evidence | Value |
|---|---|
| Baseline run-ed28973-mvs7oo0f-17041c71 (campaign validation-2026-10-28-c, replicate 1, main 4105c582) | `effectiveConfig.campaignFreeze` false, `grounding.curriculum` "learning" |
| The three replicates of cycle 3 (campaign validation-2026-10-28-b, 40513c1e): run-ed28973-mvs0onsn-6ad17f30, run-ed28973-mvs2ukug-c82da7be, run-ed28973-mvs49h5y-acdab309 | all false |
| Whole history database, read on 2026-10-28 | 34 runs, 31 campaign-tagged, 0 recorded as frozen |

The run record does hold the freeze: `effective-config.ts:62` writes it at run start, `run.repository.ts:332-338` stores and reads it.

**Effect, as reported by the dormant-features audit ([RFC-0001](../rfc/0001-dormant-features.md)).** Run-ed28973-mvra9a3s-09df0987 failed on test-side locator timeouts and was labelled an app defect (the rule that did so is not recorded). The curriculum then credited three scenario templates with "PROVEN (1 bug)", and that marker reached the lead's prompt in later runs, among them the 2nd and 3rd replicates of the cycle 3 campaign. A frozen run builds no curriculum collaborator (`run-engine-factory.ts:1508`) and would not have received it. The prompts were not re-read for this record.

**Five readers of one switch.** Each calls `resolveCampaignFreeze` on the process environment, so there is no single owner of "this run was frozen". They fall in three groups, and only the first is the per-run composition.

| Group | Reader | What it decides |
|---|---|---|
| (a) Per run, at composition | `run-engine-factory.ts:760` | The withheld collaborators above. Its value also sets the map's `recapture` provenance to "skipped" (`:1144`). |
| (b) Once at boot, for the runner's pre-run steps | `login-bootstrap-wiring.ts:9`, wired at `wire-app.ts:275-276`, consumed at `runner.ts:114-119`, `:326-327`, `:367` | Whether a run is preceded by an automatic login bootstrap run. Left unwired under the switch: "a campaign seeds the store itself before each arm-run" (`login-bootstrap-wiring.ts:7`). |
| (b) | `context-map-wiring.ts:36`, wired at `wire-app.ts:278-279`, consumed at `runner.ts:120-125`, `:524`, `:721-722` | Whether a context run executes first, "in its own queue turn" (`runner.ts:122`), to rebuild the map a run grounds on. |
| (c) For the record and telemetry | `settings.ts:248`, read as `settings.run.campaignFrozen` (`wire-app.ts:338`), recorded at `effective-config.ts:62` | The `campaignFreeze` a run record holds. |
| (c) | `bootstrap.ts:156` | The `campaignFreeze` of the telemetry handle and its health (`bootstrap.ts:233`, `telemetry-health.ts:30`). |

Group (b) acts in the runner's queue path, outside the per-run composition: both steps are decided once at boot from the process environment, before any run's request is looked at. A freeze decided per request that changes only the factory would leave a campaign-tagged run on an unfrozen process still preceded by a login bootstrap run and a context-map rebuild, which are runs the campaign did not ask for (`docs/efficiency-benchmark.md:538` names this for the rebuild).

**A precedent for the fix.** The server already gives campaign runs a default and a uniformity rule at enqueue, for every door: campaign runs default to full capture and a run whose applied capture mode differs from its campaign's is refused (`campaign-capture.ts:19-29`, `runner.ts:355-361`). The explicit request levers already exist beside it: `closedLoop`, `agentBrowser`, `captureMode`, `grounding` (`src/contract/commands.ts:173-182`).

**What this does not explain.** Why the 29 campaign runs before the baseline ran unfrozen is not established; it is confirmed only for the launcher used for the baseline. The freeze is not a cause of a failure family either; it decides whether a comparison is clean.

## Decision

| # | Decided |
|---|---|
| 1 | The server freezes every campaign-tagged run by default. Campaign-tagged means the run request carries a `campaign` (`src/contract/commands.ts:144-151`), stored as `runs.campaign_id`. |
| 2 | A learning experiment declares its learning arm explicitly in the run request. Without the declaration the run is frozen. |
| 3 | The decision is the server's, so every door gets it: the campaign script, a hand-written launcher, a direct API call. The client-side check stops being the only guard. |

**Not decided here** (left to the change that implements it):

- How the learning arm is spelled. Recommended: one more explicit request lever beside the existing ones.
- Whether the declaration lifts the whole freeze or only the lesson state. Today's freeze bundles two things: learning state (rules, curriculum, reflector, process audit) and replicate isolation (suite store read-only, no context-map heal inside the run, and the runner's two pre-run steps: no automatic login bootstrap and no context-map rebuild executed ahead of the run, group (b) above). Whichever it lifts, a per-request decision has to reach the pre-run steps too, because they are decided at boot, outside the factory.
- Whether `QA_CAMPAIGN_FREEZE` stays. A cross-repo case is triggered through the webhook, which has no campaign field (`docs/observability-design.md:1041`), so the server cannot see it as campaign-tagged.
- Runs without a `campaign` are not changed by this record.

## Consequences

- None of the 31 campaign-tagged runs in the history is isolated from learning state. They are read with that condition, as a timeline of code epochs, never as one same-code set.
- Measurement ([ADR-0011](0011-root-cause-fix-policy.md), D13): the baseline ran with the freeze off, and the after-measurement must hold the same condition. Turning the switch on before the after-measurement changes a condition D13 holds constant. Once the rule is enforced, the after run has to declare the learning arm explicitly to reproduce the baseline's condition, or be taken before the rule lands. Which of the two is for [ADR-0011](0011-root-cause-fix-policy.md) to settle.
- A deliberate guard changes. "The campaign identity cannot change what a run does" (`runner.ts:80`, `docs/observability-design.md:1143-1146`) stops being true. What stays true: variant labels remain inert, and the new rule keys on the presence of the campaign identity and an explicit lever, never on a label. The comment, the contract text and the freeze documentation are rewritten with the change; `runner.campaign.test.ts:91` (labels do not change the engine's inputs) stays valid.
- One decision, every reader. The recorded `campaignFreeze`, the run's wiring and the runner's pre-run steps (groups (a), (b) and (c) above) must come from one function of the request and the operator's setting; every read of the switch is replaced by it (whether the process switch itself stays is left open above). Group (b) is the part a factory-only change would miss.
- After [ADR-0003](0003-learning-layer-rebuild.md) deletes the rule loop, the reflector and the curriculum, the lesson state a freeze withholds is empty until the first lesson kind lands. The freeze still withholds the suite store write, the process audit, the context-map rebuild and the automatic login bootstrap. Enforcement must be in place before the first lesson kind runs, because that kind is measured as a frozen arm against a learning arm (D4) and the frozen arm must not be bypassable.
- Old runs keep `campaignFreeze` false; nothing is backfilled.

## Enforcement

Not enforced yet. What will hold it:

- A test through the public seam (the create-run use case and `enqueueTrackedRun`): a request with a `campaign` and no learning arm records `effectiveConfig.campaignFreeze` true and builds no learning collaborator; one that declares the learning arm records false; one with no `campaign` is unchanged.
- The same seam, on a process whose switch is off, for the pre-run steps (group (b)): a campaign-tagged request without the learning arm, for an app whose suite store holds no verified login and whose context map does not describe the sha, queues no login bootstrap run and executes no context-map rebuild ahead of it; the queue holds only that run. A request with no `campaign` still gets both. The test fails if the freeze reaches only the factory.
- Added by the learning slice, which the investigation's audit names as the place where the freeze is enforced server-side, and before the first lesson kind runs ([ADR-0003](0003-learning-layer-rebuild.md)).

Until then the only guard is `scripts/campaign.ts:264-266` and the operator's setting.

## Alternatives considered

| Alternative | Why it is not the decision |
|---|---|
| Keep the client-side guard and operator discipline | The launcher actually used bypassed it; 0 of 31 campaign-tagged runs were frozen. |
| The server refuses a campaign-tagged run when the process switch is off | Turns a silent mistake into a loud one, but leaves a process-wide switch as the owner of "frozen". A frozen-against-learning comparison then needs two server configurations and a restart between arms, and a run cannot declare its own arm. |
| Freeze every run, campaign or not | Ends the learning the owner wants: that the app "evolves" with the app it tests (14:14Z). |
| Choose the freeze from a variant label (for example arm B) | Labels are inert by contract: "a label that silently switched behaviour would be hidden coupling" (`docs/observability-design.md:1143-1144`). |
