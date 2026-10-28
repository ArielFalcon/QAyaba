# ADR-0010: Remove the self-maintainer

- Status: Accepted, 2026-10-28, owner
- Decision source: D11. On 2026-10-28 (15:32Z) the owner approved D1-D13 together: "Regarding the 13 recommendations I agree with everything" (translated). D11 was presented as "Maintainer clean-up: close 18 open `qa/maintainer-*` PRs, delete the `qayaba-self` mirror (destructive, outward-facing)", with the recommendation "Yes, when the maintainer is deleted in step 1; owner does or authorizes the GitHub part". The approved wording presupposes the deletion; the audit's row 4.1 ("Discard") is the evidence it rests on. This ADR records that approved recommendation.
- Code references at 4105c582:
  - The trigger that keeps it armed: `src/server/health-poller.ts:57-59`, `src/server/runner.ts:843`, `src/server/wire-app.ts:399`
  - What it does when triggered: `src/server/maintainer-runtime.ts:98-128` (working copy `qayaba-self`), `:141-157` (its whole input), `:206-234` (commit, push and fix PR), `:272` (the `cfg.autonomous` check: the scope check, gate and swap come after it)
  - The code-running paths, all after the `:272` check and so reachable only with auto-merge on: `src/server/maintainer-runtime.ts:72`, `:286-288`, `:328`, `:348`, `:434`; `src/server/self-update.ts:103`, `:159-161`
  - The write authority: `agents/opencode.json:186-195`, the guard `src/server/merge-guard.ts:21`
  - The full deletion list is under "What the removal deletes"
- Related: [ADR-0001](0001-design-pillars.md), [ADR-0003](0003-learning-layer-rebuild.md), [ADR-0007](0007-code-target-removal.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md), [RFC-0002](../rfc/0002-platform-steps-0-1.md), [RFC-0004](../rfc/0004-log-level-from-outcome.md)

**In short:** step 1 deletes `qa-maintainer` (the agent that opens fix pull requests on qayaba itself), its auto-merge, the canary hot-swap, the merge guard and the `qayaba-self` mirror. Closing the open `qa/maintainer-*` pull requests is the owner's call at that time, with an explicit go; no agent does it on its own. What else the removal drags out (the incident store, the producers' signals) is listed as a consequence for the owner to confirm, not as a separate decision.

## Context

The maintainer is not a dormant feature. In code it is armed: each minute the health poller hands pending incidents to it whenever it is idle (`src/server/health-poller.ts:57-59`). Its auto-merge and hot-swap are off by default (`src/settings/registry.ts:147`, default `false`). With the default, what runs is the diagnosis session (`src/server/maintainer-runtime.ts:192`), a commit of the working copy (`:206-223`), a force-push of `qa/maintainer-<id>` and a pull request against `main` (`:225-234`). The run then returns at the `cfg.autonomous` check (`:272`), before the scope check, the rate check, the self-test gate and the swap (`:275-328`). Today even that push is refused: the audit saw HTTP 403 on it, and nothing from the maintainer has reached GitHub since 2026-07-02 (audit figures, not re-checked; fact 2). "Armed" is a statement about the code and its triggers, not about what reaches GitHub now.

### What was checked at 4105c582

| # | Fact | Evidence | Label |
|---|---|---|---|
| 1 | Routine events page it. | A run interrupted by a restart records a warn incident (`src/server/runner.ts:843`); an orphaned-session cleanup records one (`src/server/wire-app.ts:399`); an unexpected pipeline crash records an error incident (`runner.ts:693`). Any pending incident while idle triggers a session (`health-poller.ts:57-59`). | confirmed |
| 2 | With auto-merge off it still commits, pushes a branch and opens a pull request on the main repository, in code. | It clones or resets `qayaba-self` (`maintainer-runtime.ts:98-109`, `:118-121`), commits with `git add -A` (`:210`), force-pushes `qa/maintainer-<id>` (`:225-229`), opens the PR against `main` (`:231-234`), and only then checks `cfg.autonomous` (`:272`). The audit saw the push refused with 403 ("credential of another account") for 3 maintainer commits of 2026-10-27 in the `qayaba-self` copy, none of which is on GitHub. | the code path: confirmed. The refused push today: audit figure, not re-checked |
| 3 | Its whole input is one line per incident. | The prompt holds each incident's id, source, severity, summary and optional detail (`maintainer-runtime.ts:141-157`). | confirmed |
| 4 | It has produced no merged fix. | 18 remote-tracking branches `origin/qa/maintainer-*` exist in the local clone, tip commits from 2026-06-12 to 2026-07-02; none is an ancestor of `main`. Squash merges would not show as ancestors, so this does not prove the audit's "0 merged". The audit counts 21 attempts: 18 open PRs and 3 local branches. | branches: confirmed. The PR and attempt counts: audit figures, not re-checked |
| 5 | It holds write authority over qayaba's own source. | Role `qa-maintainer` has `write`, `edit` and `bash` on (`agents/opencode.json:186-195`); its work directory is the `qayaba-self` copy. | confirmed |
| 6 | Behind auto-merge, its pre-deploy gate runs agent-written code as the orchestrator, outside the execution launcher. | `execSync` (`maintainer-runtime.ts:72`) runs `npm install`, `npm run typecheck` and `npm test` in the fixed working copy (`:286-288`) with a scrubbed environment but the orchestrator's uid. These lines come after the `cfg.autonomous` check (`:272`), so they run only with `SELF_MAINTAINER_AUTOMERGE` on. The orchestrator "runs as root with the API token, the saved sessions and the provider keys in reach" (`docs/execution-sandbox.md:6-7`), and the invariant says agent-influenced code runs only through the launcher (`AGENTS.md:658-662`). The architecture rule that guards `child_process` scans `qa-engine/src` only (`qa-engine/.dependency-cruiser.cjs:97-98`), so it never saw this. | the code and the missing guard: confirmed. Reachable only with auto-merge on (default off); a hazard if switched on, not a live one |
| 7 | Behind auto-merge, the canary proves less than it merges. | The swap (`maintainer-runtime.ts:328`, after the `:272` check) copies `src/` and the package files only (`self-update.ts:103`, `:159-161`); engine code lives under `qa-engine/`. After a swap, `npm install` runs in the live directory with the swapped `package.json`'s lifecycle scripts (`maintainer-runtime.ts:348`; the comment at `:344-347` says so). | the copy and the install: confirmed in code, reachable only with auto-merge on. "Engine fixes merge unproven": inference |
| 8 | It rewrites the orchestrator's own code at runtime. | `self-update.ts:159-161`. The production compose file keeps `src/` on a normal filesystem so the swap works; the dev override mounts the code read-only so the swap is a no-op (`docker-compose.yml:14-18`, `docker-compose.override.yml:3-10`). | confirmed in code (only with auto-merge on, which is off by default) |
| 9 | It taxes every move in steps 2-6. | `PROTECTED_PATHS` holds 195 entries (`merge-guard.ts:21`); a test fails when a moved security-relevant file is not re-listed (`src/server/protected-paths-follow-moves.test.ts:1-3`). | confirmed |
| 10 | Its fixes are shaped by one run's incident. | Fact 3, and the golden rule: "Never fix a problem only for the project where it showed up" (`AGENTS.md:10-13`). | inference from facts 3 and 1 |

### The owner's words (translated)

- 2026-10-28 14:14Z: "The problem was that at the start, instead of deciding on an MVP and making it work, I kept adding features on top of features in an app that did not work. That is why I want you to look for what is switched off, to see whether its hypothetical value once fixed justifies integrating it or it is discarded."
- 2026-10-28 15:32Z: "Regarding the 13 recommendations I agree with everything."
- 2026-10-28 15:04Z: "do not add more patches to main, keep those discoveries as information for the refactor process." This is the work rule in [ADR-0011](0011-root-cause-fix-policy.md). In code the maintainer can still commit, push and open fix PRs against `main` during the refactor (fact 2); with today's credential the audit saw its push refused, so that is a code-level exposure, not a live one.

## Decision

1. **The maintainer is removed in step 1:** the `qa-maintainer` role and prompt, the incident-to-fix runtime, the auto-merge, the canary hot-swap with the boot guard that backs it, and the merge guard.
2. **The `qayaba-self` mirror is removed** with it. The code that creates it goes, and so does the prune exemption that protects it.
3. **Closing the open `qa/maintainer-*` pull requests is not part of any commit.** It needs the owner's explicit go at that time (the owner closes them, or authorizes closing PR numbers taken from a fresh GitHub listing, point C), and an agent never does it on its own. The same holds for deleting the remote branches.

### Follows from the removal (not separately decided; point A below)

- The incident store (`src/server/maintainer.ts`), its `/api/maintainer/*` routes and the `qa maintainer` commands in `bin/qa` exist to feed and inspect the maintainer: the only code that reads the store is the poller's trigger (`wire-app.ts:471`) and the maintainer itself, and the routes are not in `contract/openapi.json`. They are removed with it.
- Each producer of an incident keeps its signal as a log line at the severity of its meaning ([RFC-0004](../rfc/0004-log-level-from-outcome.md) proposes how a level follows the typed outcome). No producer is deleted without its signal landing in a log line (`AGENTS.md`, "Surface integration errors loudly").

## What the removal deletes (paths at 4105c582)

| Area | Deleted | Edited so the maintainer leaves |
|---|---|---|
| Role and prompt | `agents/agent/qa-maintainer.md` (80 lines); the `qa-maintainer` entry of `agents/opencode.json` (`:186-`) | `qa-engine/src/shared-kernel/agent-role.ts:3`, `src/agent-runtime/types.ts:119`, `src/integrations/fixtures/opencode-roster.json:6`, `README.md:256`, `src/integrations/agent-tool-surface.test.ts:852-859` (that test goes) |
| Runtime | `src/server/maintainer-runtime.ts` (605), `maintainer.ts` (168), `maintainer-memory.ts` (81), `maintainer-summary.ts` (44), `merge-guard.ts` (768), `self-update.ts` (191), `boot-guard.mjs` at the repository root (78); about 2,015 lines with the prompt. `scripts/setup-branch-protection.sh` is not deleted (point B) | `src/server/wire-app.ts` (`:28`, `:46`, `:110`, `:173-176`, `:356-369`, `:470-473`, `:782`, `:827-828` for `recoverRollbackRecord` and `confirmSwapAfterBoot`, `:830`), `src/server/control-plane-router.ts` (`:15-16`, `:73-74`), `src/server/health-poller.ts` (the incident and trigger dependencies `:8-11`, `:57-59`; the poller keeps its probe, session sweep, retention, backup and prune), `src/server/shutdown.ts:26` (a comment), `package.json:23` (`start` stops running the boot guard) |
| Incident producers | the incident store and its `/api/maintainer/*` routes (`src/server/maintainer.ts`); the store's only readers are the poller's trigger (`wire-app.ts:471`), the maintainer and those routes | `src/server/runner.ts` (`:693`, `:843`), `src/server/wire-app.ts` (`:243`, `:399`), `src/server/run-engine-factory.ts` (`:165`, the `recordIncident` import, and `:1481-1482`), comments that name the incident or the runtime (`qa-engine/src/shared-kernel/domain-error.ts:43`, `src/integrations/repo-mirror.ts:204`, `src/server/onboarding/onboarding-job.ts:137`), `qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts` (`:182`, `:206-208`: the `engine-fix` edge), `qa-engine/src/contexts/cross-run-learning/infrastructure/process-audit-port.adapter.ts` (`:17`, `:28`, `:49`), `src/types.ts:136-148` (the `Incident` types), `bin/qa` (`:52-58`, `:329-375`, `:387`) |
| GitHub helper | none | `src/integrations/github.ts`: `createPullRequest` (`:61`), `enableAutoMerge` (`:82`), `mergePullRequest` (`:108`), `getPullRequest` (`:117`) and `getPrStatus` (`:132`) have no production caller outside the maintainer. `getRepo` (`:193`) and `listRepos` (`:214`) stay for onboarding. The engine's own `qa-engine/src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts` is a separate implementation and stays |
| Mirror | the `qayaba-self` directory on the mirrors volume (host state, not a repository file) | `src/server/mirror-prune.ts:25-26` (the exemption) |
| Settings | none | `src/settings/registry.ts` (`:11` group, `:44` `QAYABA_REPO`, `:68` description, `:146-148`), `src/settings/settings.ts` (`:54`, `:115-118`, `:205`, `:259-262`), `src/settings/defaults.ts:3`, `scripts/gen-settings-docs.ts:27`; `docs/settings.md` is regenerated (`npm run settings:gen`). `.env.example` mentions the maintainer and is hand-written, so `npm run settings:check` does not cover it: step 1 edits it by hand |
| CI and branch protection | none | `.github/workflows/ci.yml:1-6` (the header calls the `ci` job the maintainer's outer guard; the workflow and its `ci` job stay), `scripts/setup-branch-protection.sh:2-4` (the same wording; the script stays, point B) |
| Scripts and arch | the `merge-guard` preset of `scripts/mutate.ts` (`:429-434`); the entry `src/server/maintainer-runtime.ts` in `qa-engine/.dependency-cruiser-shell-exceptions.json:31` (that list may only shrink) | `scripts/test-timings.json` (entries `:685-688`, `:732`) |
| Compose | none | `docker-compose.yml` (comments `:15-18`, `:143`, `:147-149`, `:151`), `docker-compose.override.yml:8-12` |
| Tests | `src/server/maintainer-memory.test.ts`, `maintainer-runtime.test.ts`, `maintainer-summary.test.ts`, `merge-guard.test.ts`, `self-update.test.ts`, `protected-paths-follow-moves.test.ts` (about 1,560 lines) | `src/server/health-poller.test.ts`, `src/server/control-plane-router.test.ts`, `src/server/runner.test.ts`, `src/server/create-app.test.ts`, `src/settings/settings.test.ts`, `qa-engine/test/contexts/cross-run-learning/domain/process-audit.test.ts`, `src/server/mirror-prune.test.ts` (`:124-128`, the test of the `qayaba-self` exemption), `scripts/model-agnostic-prompts.test.ts` (imports `:32-34`, the maintainer prompt case `:565-595` and its entry `:679`) |

These tables list the owners and the seams opened. They are not exhaustive: a case-insensitive search at 4105c582 for `maintainer`, `merge-guard`, `self-update`, `boot-guard`, `qayaba-self` and `SELF_MAINTAINER` matches 78 files outside `docs/architecture/` and `odd/` (the files this removal deletes included). The unlisted matches were not opened (hypothesis: mostly tests and comments that name the role). The step 1 commit runs the search again and handles each match, with the global search the code standard requires.

### AGENTS.md and docs that change with it

| File (at 4105c582) | Change |
|---|---|
| `AGENTS.md:583-585` | The `qa-maintainer` paragraph (self-repair, `SELF_MAINTAINER_AUTOMERGE`, merge guard, canary) is deleted. |
| `AGENTS.md:567` | "beside the maintainer, assistant, reflector and proposer" drops the maintainer. |
| `AGENTS.md:464` | "opens a maintainer incident" drops that clause. |
| `AGENTS.md:690-691` | The rule "Governance-sensitive changes ship alone" stays. This removal is itself one of those changes and ships as its own commit. |
| `README.md:256` | The roster row loses `qa-maintainer`. |
| `docs/execution-sandbox.md:108` | The hot-swap clause goes. |
| `docs/testing-standards.md` (`:165`, `:172`, `:178`, `:1243`, `:1374` and the merge-guard rows) | The merge-guard preset records go. |
| `docs/observability-context.md:64`, `docs/efficiency-benchmark.md` (`:177`, `:536`) | The maintainer mentions go. |
| `.env.example` | The maintainer text goes, with the `SELF_MAINTAINER_AUTOMERGE` entry if it is listed there. Hand-written: no gate finds it (`settings:check` covers `docs/settings.md` only). |
| `.github/workflows/ci.yml:1-6` | The header stops calling the job the maintainer's outer guard; the job and its `ci` name stay (point B). |
| `docs/landing-page/DESIGN_BRIEF.md` (`:39`, `:217-223`, `:297`) | It describes the maintainer as a product feature. It is product copy, so whether it is edited is the owner's call. |
| `docs/architecture-remediation.md` (`:121`, `:196`, `:283`, `:387`) | It is the earlier plan and is outside the previous-forms scan (`scripts/check-previous-forms.ts:55-56`); whether it is edited or marked superseded is the index's call ([README](../README.md)). |

This table is not exhaustive either: the search named under the code table covers these files too.

## Consequences

- **Good.** The only role that edits qayaba's own source is gone, with its `bash` tool. The only path that runs agent-written code as the orchestrator, outside the launcher, is gone; it was reachable only with auto-merge on (facts 6 and 7), so this removes a latent hazard, not a live one. The path that rewrites the orchestrator's own code at runtime is gone, so "the orchestrator never writes its own code at runtime" (`docker-compose.override.yml:3-4`) holds in production by construction, not by the default switch. The 195-entry protected-path tax on steps 2-6 ends. Five methods of `src/integrations/github.ts`, a second implementation of pull request creation and merge, go (the file stays, see the table).
- **Cost.** Incident visibility changes. The store was in memory and capped at 30 (`src/server/maintainer.ts:6-7`); what replaces it is the log. Three producers have no log beside them today: the health probe records only an incident after 3 and 10 failures (`health-poller.ts:44`, `:47`), a deep queue only an incident (`:53`), and the orphaned-session sweep only an incident when it cleaned sessions (`wire-app.ts:397-399`). Step 1 gives each a log line at error or warn; losing them silently would break the loud-failure invariant.
- **Order with ADR-0007.** `merge-guard.ts:354-355` and `:402-403` name the code runner, `code-setup.ts`, `test-run-evidence.ts` and the Stryker adapter. This ADR lands first (the audit's step 1 order puts the maintainer at item 10, the code target at 15), so that list is gone before its entries would dangle. See [ADR-0007](0007-code-target-removal.md).
- **Order with ADR-0003.** The process audit's `engine-fix` disposition is the only engine edge into the incident store (`process-audit.ts:182`, `:206-208`). With no consumer it becomes an observe-only finding, as the time-exhaustion streak already is (`AGENTS.md:463-464`). The learning-layer ADR keeps the audit's observe streak.
- **State left outside the code.** These are host state or remote state; a code commit does not touch them.

| Left behind | Who acts | Note |
|---|---|---|
| The open `qa/maintainer-*` branches and their PRs (18 per the audit) | the owner, with an explicit go | Decision 3 and point C. The 18 is an audit figure (`gh pr list --search head:qa/maintainer`, all open, created 2026-06-12 to 2026-07-02), not re-checked. The audit's range "#5-#23" spans 19 numbers, so it is not a list of the 18. |
| The `qayaba-self` directory on the mirrors volume | the existing prune, once the exemption is gone | Hypothesis, read from code: with the exemption removed, `pruneMirrors` treats the directory as an orphan (its name is no configured repo slug) and deletes it at its next pass, every 6 hours (`health-poller.ts:25-26`, `:74-77`; `mirror-prune.ts:74-81`). The audit saw 3 maintainer commits of 2026-10-27 in it (20:56Z, 23:29Z, 23:33Z) that never reached the remote (the first, an orphan-sweep fix, matches one the owner made by hand later that night); deleting the directory discards those commits (audit figures, not re-checked). Whether the directory still exists was not re-checked. |
| `pending-swap.json`, `pending-promote.json`, `maintainer-deploys.json`, `maintainer-failures.json`, `last-rollback.json` in the data volume (`self-update.ts:6`, `:21`; `maintainer-runtime.ts:91-93`) | the owner | Inert once the code is gone. Not checked whether they exist. |
| The GitHub settings that `scripts/setup-branch-protection.sh` applies (required `ci` check, admins enforced, auto-merge allowed: `:31`, `:38-39`) | the owner | A setting already applied on the remote does not change with any commit, whatever happens to the script. Point B below. |

### Not decided here

Decided 2026-10-28: each recommended answer below is accepted ([ADR-0013](0013-owner-decisions-remaining-questions.md)).

| Point | The question | Recommended answer |
|---|---|---|
| A | Do the incident store, the `/api/maintainer/*` routes and the `qa maintainer` commands leave with the maintainer, with each producer's signal becoming a log line? | Yes. Nothing but the maintainer's own routes and commands reads the store, those routes are not in the public contract, and the log is where the loud-failure invariant already sends a failure. |
| B | Which of the three GitHub settings that `scripts/setup-branch-protection.sh` applies stay, and what happens to the script? | The settings serve different things (table below). Keep the required `ci` check and the admin enforcement. Leave "allow auto-merge" to the owner: it is a remote change that needs its own explicit go. Keep the script in step 1 as the only reproducible record of the three settings, with its header reworded. Not checked: whether the script was ever run, so whether any of the three is set on the remote. |
| C | How are the open `qa/maintainer-*` pull requests closed (decision 3)? | The owner closes them, or authorizes closing the PR numbers taken from a fresh GitHub listing of heads `qa/maintainer-*` when the removal commit lands. The authorization names those numbers. Do not use the audit's range: "#5-#23" spans 19 numbers for 18 PRs, so at least one number in it is not an open maintainer PR, and the 18 is an audit figure, not re-checked. Each PR gets a closing comment that links this ADR; then the owner deletes the remote branches. |
| D | The records cite files step 1 deletes, and the previous-forms gate would flag them. | Same question and answer as point C of [ADR-0007](0007-code-target-removal.md) and [RFC-0002](../rfc/0002-platform-steps-0-1.md) Q1: skip the path and citation checks for `docs/architecture/` in commit G1, before the first deletion. |

**Point B in detail.** The script and the workflow header describe all three settings as the maintainer's "outer guard" (`scripts/setup-branch-protection.sh:2-4`, `.github/workflows/ci.yml:1-6`). The sources do not support that for each setting:

| Setting (script line) | Who it serves at 4105c582 | Recommended answer |
|---|---|---|
| Required `ci` check on `main` (`:38`) | Every merge to `main`, whoever opens the PR: the `ci` job runs the project gate (typecheck, arch:check and the tests among its steps) on every PR and push to `main` (`.github/workflows/ci.yml:1-2`). Only the wording around it names the maintainer. | Keep. |
| Enforce admins (`:39`) | The same branch rule: it makes the required check bind admins too. | Keep with `ci`; the owner's call. |
| Allow auto-merge (`:31`) | The script's stated reason is the maintainer (`:4`: "so a canary-verified maintainer fix merges automatically once CI passes"), and the maintainer's promote path calls it (`maintainer-runtime.ts:482`). The engine's publication calls the same GitHub feature on the repository it publishes to (`qa-engine/src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts:14-17`), which is a watched app's repository; whether qayaba's own repository is one is the owner's app configuration (hypothesis: no publishing happens there today, since that app is in shadow mode, [ADR-0007](0007-code-target-removal.md)). | Leave to the owner. No commit changes it. |
| The script itself | The only reproducible definition of the three settings. | Keep it in step 1 and reword its header (listed under "Edited" above); the owner may delete it later, knowing it removes that record. |

## Enforcement

Not enforced yet. At 4105c582 nothing prevents the maintainer from returning. Step 1 adds, in the same commit series:

| Holds | Mechanism |
|---|---|
| The role and runtime do not return | `npm run typecheck` (the role leaves `AGENT_ROLES`, `agent-role.ts:3`) and a rule for the removed names added to `BANNED_RULES` (`scripts/check-previous-forms.ts:38`), whose dead-path and dead-citation checks also fail on any document left pointing at a deleted file. |
| The settings do not return | `npm run settings:check` after `npm run settings:gen`. |
| The shell exception list only shrinks | The entry at `.dependency-cruiser-shell-exceptions.json:31` is removed. |
| No producer swallows its signal | Planned: a test per converted producer through its public seam, for example `startHealthPoller` with fake dependencies asserting a logged error after 3 failed probes. No such test exists at 4105c582. |

**A gap this ADR does not close.** The rule `no-child-process-outside-launchers` scans only `qa-engine/src` (`qa-engine/.dependency-cruiser.cjs:97-98`), which is how `maintainer-runtime.ts` called `execSync` unobserved. Whether to extend it to `src/` belongs to [RFC-0002](../rfc/0002-platform-steps-0-1.md).

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the maintainer, stop its triggers | A dormant agent with write and `bash` tools, about 2,015 lines and a 195-entry path list stays through steps 2-6. It is the pattern the owner named on 2026-10-28 14:14Z. |
| Keep it, fix the producers so only real faults page it | The audit found no evidenced value, and facts 3 and 10 are structural: it works from a one-line summary of one run's incident and patches the shared engine. Better producers do not change that. |
| Keep auto-merge as an opt-in | Facts 6 and 7: its gate runs agent code as the orchestrator and its canary covers `src/` only. Opting in means accepting both. |
| Delete the code but also close the PRs in the same step | Closing is outward-facing and destructive, and the owner reserved it (decision 3). |
| **Remove it in step 1, keep the signals as log lines (chosen)** | It removes the armed path and its write authority with the smallest change, and routes what it was paged for to the place the loud-failure invariant already requires. |
