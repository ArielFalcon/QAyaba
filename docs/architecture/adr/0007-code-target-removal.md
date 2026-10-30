# ADR-0007: Remove the code target

- Status: Accepted, 2026-10-28, owner
- Decision source: D8. On 2026-10-28 (15:32Z) the owner approved D1-D13 together: "Regarding the 13 recommendations I agree with everything" (translated). D8 was presented with its recommendation, which this ADR records as approved. The owner's own words about the code target are under Context.
- Code references at 4105c582:
  - What the target is: `AGENTS.md:204-207`, `qa-engine/src/shared-kernel/run-mode.ts:3`, `src/server/run-engine-factory.ts:682-683`
  - The false-failure chain: `qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts:101-105`, `:464-472`, `package.json:62`
  - The wider publication surface: `qa-engine/src/contexts/workspace-and-publication/domain/publish-policy.ts:8-11`, `qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts:13-14`
  - The second language list: `qa-engine/src/contexts/test-execution/domain/ecosystem.ts:1`, `qa-engine/src/shared-kernel/language-id.ts:2`
  - The full deletion list is under "What the removal deletes"
- Related: [ADR-0001](0001-design-pillars.md), [ADR-0003](0003-learning-layer-rebuild.md), [ADR-0004](0004-response-value-oracle-removal.md), [ADR-0006](0006-bundle-mutation-switch.md), [ADR-0010](0010-maintainer-removal.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md), [RFC-0002](../rfc/0002-platform-steps-0-1.md)

**In short:** after step 1 qayaba has one target, end-to-end tests against a live DEV site. The code target (`--target code`, `code: true`) is deleted, not parked. Code-level testing may return later as its own RFC on the same engine ports, once the E2E MVP is stable. The disarm approved in D8 was applied on 2026-10-28 to the one app configured for it (the owner's gitignored configuration).

## Context

The code target runs a repository's own test command instead of Playwright. The agent writes tests in the repo's framework, the orchestrator runs the repo's install and test commands and classifies the run by exit code (`AGENTS.md:204-207`). Its value oracle is Stryker, which re-runs the repo's test command once per mutant, with a 600 s default (`qa-engine/src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts:13`, `:68-70`, `:198`).

### What was checked at 4105c582

| # | Fact | Evidence | Label |
|---|---|---|---|
| 1 | The target has never run in the recorded history. | History database: 34 runs, all `target = e2e`, none for the app `qayaba` (2026-10-26 18:00Z to 2026-10-28 15:34Z); `run_outcomes` holds 31 rows, all `e2e`. The earliest recorded run is from 2026-10-26; nothing is known of earlier ones. | confirmed for that window |
| 2 | Aimed at qayaba's own repository, it may report a false failure. | The code install always passes `--ignore-scripts` (`code-execution.runner.ts:101-105`). better-sqlite3 is pinned at `12.10.1` (`package.json:62`) and builds its native binding in its install script, `prebuild-install \|\| node-gyp rebuild --release` (the installed package's own manifest). Any non-zero exit of the test command is the verdict `fail` (`code-execution.runner.ts:464-472`); only a refused manifest, an operator cancel, a spawn error (a timeout is one) or zero tests is `infra-error` (`:391`, `:406`, `:446`, `:456`). A non-shadow app turns `fail` into an Issue. | install flag, script and classification: confirmed. That the tests then fail at the missing binding, and the Issue: hypothesis (never run; no install was done here) |
| 3 | The comment at the install flag and the code disagree. | `code-execution.runner.ts:101` says a repo that needs a build script "will fail its test command → infra-error (inconclusive)"; `code-execution.runner.ts:464-472` returns `fail`. | confirmed |
| 4 | A code run may publish far more of the watched repo than an E2E run. | Publication adds `.` for code and only `e2e` for E2E (`publish-policy.ts:8`, `:11`); write confinement is a denylist for code and an allowlist of `e2e/` for E2E (`write-confinement.service.ts:13-14`). | confirmed |
| 5 | It carries a second language list, wider than the declared scope. | `Ecosystem` has node, python, go, rust, maven, gradle (`ecosystem.ts:1`); the language registry has javascript, typescript, java (`language-id.ts:2`). The orchestrator image installs those toolchains (`Dockerfile:30-70`) and the egress registry says "the code target uses all of them" (`config/egress/registries.yaml:8`). The golden rule extends languages "through the language registry … never through special cases" (`AGENTS.md:5-8`). | confirmed |
| 6 | The variant is spread through the engine. | 84 production source files reference it (a search of `src`, `qa-engine/src`, `scripts`, `client`, `packages` for `isCode`, `target === "code"`, `TestTarget`, `PublishKind`, `app.code`, `code: true`; tests and generated files excluded). | confirmed count; a lower bound on the places to edit |

### Armed state, and the disarm

The owner's app configuration for qayaba itself is gitignored user data (`.gitignore:27`, rule `config/apps/*`), not a repository file. D8 recommended disarming it now, and the owner approved D1-D13 at 15:32Z. An agent then set `qa.shadow: true` in it at about 15:34Z, as the approved recommendation said; the decision log records "D8 disarm done 15:34Z". Checked on the host: it keeps `code: true` and now has `qa.shadow: true`. In shadow mode a run replaces every PR and Issue with a log line (`AGENTS.md:182`), so no run can publish while the code still exists.

### The owner's words (translated)

- 2026-10-28 14:14Z: "The problem was that at the start, instead of deciding on an MVP and making it work, I kept adding features on top of features in an app that did not work. That is why I want you to look for what is switched off, to see whether its hypothetical value once fixed justifies integrating it or it is discarded."
- 2026-10-28 15:16Z: "the code-only mode, which runs code tests directly and not E2E, I don't know whether to keep it or remove it; my idea was that once E2E worked I would add an integrated code-testing flow to it, to test regressions, logic and bugs directly; I don't know how you see it, or whether it doesn't pay off and it is better to focus only on E2E."
- 2026-10-28 15:32Z: "Regarding the 13 recommendations I agree with everything."

## Decision

1. **The code target is deleted in step 1.** One target remains: E2E against a live DEV site. No flag, prompt branch, runner or toolchain that only it needs is kept dormant.
2. **The disarm approved in D8 stands.** It was applied on 2026-10-28 to the owner's gitignored app configuration (`qa.shadow: true`). It is a stopgap, not the fix.
3. **Code-level testing returns later as an RFC on the same engine ports.**
   - Entry condition: a stable E2E MVP.
   - Role: cover what E2E cannot reach, namely untaken arms, bundle-mutation survivors and `needs-unavailable-state` drops.
   - This ADR designs none of it.

## What the removal deletes (paths at 4105c582)

| Area | Deleted | Edited so the variant leaves |
|---|---|---|
| Execution | `qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts` (609 lines), `code-execution.strategy.ts` (37), `code-setup.ts` (117), `qa-engine/src/contexts/test-execution/infrastructure/code-validation.strategy.ts` (11; its importers are `build-test-execution.ts:8`, `validation-port.adapter.ts:5`, `src/server/engine-root.ts:65` and `src/server/run-engine-factory.ts:93`, all edited here), `test-run-evidence.ts` (51; its only importer is the runner), `qa-engine/src/contexts/test-execution/domain/ecosystem.ts` | `qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts` (imports `:16-25`; the code compile check `:267-320`), `qa-engine/src/contexts/test-execution/infrastructure/adapters/execution-port.adapter.ts`, `qa-engine/src/contexts/test-execution/infrastructure/adapters/validation-port.adapter.ts`, `qa-engine/src/contexts/test-execution/composition/build-test-execution.ts`, `src/server/engine-root.ts` (`:64-65`, `:164`, `:170`) |
| Value oracle and coverage | `qa-engine/src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts` (284) | `src/server/run-engine-factory.ts` (collector `:964-972`, oracle `:985-1005`), `qa-engine/src/contexts/objective-signal/infrastructure/target-coverage-collector.ts` |
| Native-report readers (to confirm) | `qa-engine/src/contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts`, `c8-coverage.adapter.ts`, `jacoco-coverage.adapter.ts`: the collector above is their only non-test value import (`target-coverage-collector.ts:5-7`) | `qa-engine/src/contexts/objective-signal/infrastructure/coverage-dump-reader.ts` imports their types (`:9-11`); confirm no E2E path reads native reports before deleting |
| Entry points and config | none | `qa-engine/src/shared-kernel/run-mode.ts:3`, `qa-engine/src/shared-kernel/contract/events.ts:5`, `src/orchestrator/schemas.ts` (the app-config key `code` at `:382`, its comment `:117-120`, the refine "dev is required unless code: true" `:396-397`, and the webhook payload's `target` at `:458`), `src/cli.ts` (`:140`, `:211`, `:283`), `src/server/webhook-routing.ts` (`:10`, `:27`), `src/server/run-config-gates.ts`, `src/server/onboard.ts`, `src/server/onboarding/patch-app-yaml.ts`, `src/server/onboarding/onboarding-job.ts`, `qa-engine/src/contexts/app-catalog/domain/app.aggregate.ts`, `qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts`, `scripts/campaign.ts:576` and `scripts/baseline-agent.ts:979` (each rejects `app.code === true`) |
| Prompts | none | `qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-sections.ts` (16 branches, e.g. `:725`), `reviewer-sections.ts`, `reviewer-change-sections.ts`, `task-builders.ts`, `review-render.ts`, `agents/agent/qa-reviewer.md`, `agents/skill/test-value-review/SKILL.md` |
| Fix loop and learning gates | none | `qa-engine/src/contexts/run-orchestration/domain/fix-loop.aggregate.ts`, `adjudicate.service.ts`, `fix-loop-action.ts`, `qa-engine/src/contexts/cross-run-learning/domain/should-distill-learning.ts:4-5`, `learning-gates.ts:20,39` (ADR-0003 also reworks the gates; whichever lands first removes the `isCode` input) |
| Publication and confinement | none | `qa-engine/src/contexts/workspace-and-publication/domain/publish-policy.ts` (the `code` kind), `write-confinement.service.ts` (`isCodeDenied`, `classifyStrays`), `render-publication.ts`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter.ts` and the write-confinement adapters |
| Surfaces and contract | none | `client/internal/ui/launcher.go:31`, `apps.go`, `live.go`, `dashboard.go`; `contract/openapi.json` and the generated `packages/sdk/src/types.gen.ts`, `client/internal/contract/types.gen.go` (regenerated, `npm run contract:check`) |
| Image and config | none | `Dockerfile:18` (a comment that names code mode), `Dockerfile:30-70` (candidate: JDK, Maven, Gradle, Rust, Go; `python3` and `build-essential` stay, see Consequences), `config/egress/registries.yaml`, `config/apps/example.yaml:18-21` and `:86`, `config/benchmarks/efficiency-cases.example.json:21` |
| Scripts | the `code-run-reads` preset of `scripts/mutate.ts` (`:600-622`) and its test (`scripts/mutate.test.ts:349`) | `scripts/prompt-contract-matrix.ts` (target dimension, `:85`), `scripts/efficiency-benchmark.ts:60`, the presets of `scripts/mutate.ts` that name the coverage collector (`:515`, `:531`, `:565`). `scripts/mutate.ts` itself and the Stryker packages stay: the repo's own mutation presets use them (`package.json:61`, `:72`) |
| Tests | `qa-engine/test/contexts/test-execution/infrastructure/code-execution.detect.confinement.test.ts`, `code-execution.runner.test.ts`, `code-execution.spawn.test.ts`, `code-execution.strategy.test.ts`, `code-setup.test.ts`, `code-validation.strategy.test.ts`, `test-run-evidence.test.ts`; `qa-engine/test/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.test.ts`, `stryker-mutation-oracle.confinement.test.ts`, `stryker-mutation-oracle.scenarios.test.ts` | the tests of the edited files above (for example `src/server/engine-root.test.ts`, `src/server/run-engine-factory.test.ts`, `src/server/webhook-routing.test.ts`) |

This table lists the owners and the seams verified. It is not a promise that no other branch exists: the step 1 commit finds the rest with the global search the code standard requires.

### AGENTS.md and docs that change with it

| File (at 4105c582) | Change |
|---|---|
| `AGENTS.md:84` | The command comment drops `--target e2e\|code`. |
| `AGENTS.md:133` | "Authors for code, context and login-seed runs" drops "code". |
| `AGENTS.md:204-207` | The "Targets" paragraph keeps only the E2E half; the pointer to the code runner goes. |
| `AGENTS.md:346` | "A code run, a context run and a login still to be written never coordinate" drops "A code run,". |
| `AGENTS.md:658-662` | The launcher invariant drops "a code-mode repo's install/test and the mutation oracle". The invariant itself stands. |
| `README.md:113`, `:119`, `:120`, `:171`, `:194`, `:438` | Code mode, Oracle row and the `code` target row go. |
| `docs/execution-sandbox.md:6`, `:31`, `:138` | The "code-mode" install and test mentions go; the `install` profile stays for the E2E project's `npm ci`. |
| `docs/execution-sandbox.md:174` | "the e2e target uses `npm`, the code target all groups" loses its second half. |
| `docs/testing-standards.md` (`:717`, `:1252`, `:1274-1292`, and the code-runner rows of the mutation tables) | The `code-run-reads` preset record goes. |
| `docs/testing-standards.md` (`:536`, `:559`, `:847`, `:994`) | Sentences that describe a code run (its coverage reports, its conventions read, its diff pass) lose that clause. |
| `docs/efficiency-benchmark.md:69` | The `"target": "code"` case field goes. |
| `docs/lead-sidekicks.md:4`, `docs/observability-design.md:1338` | "A code run," and the `--target code` sentence go. |
| `config/apps/example.yaml:18-21`, `:86` | The code-mode comment goes; `dev` is required without exception. |

Not exhaustive: this table lists the files opened. The step 1 commit searches the docs for `code target`, `code-mode`, `code mode`, `code run` and `--target code` and handles each match.

## Consequences

- **Good.** One target. About 1,100 lines of source go outright (runner 609, Stryker adapter 284, setup 117, evidence 51, strategy 37, ecosystem 1), and the 84 files lose a variant that steps 2-6 would otherwise carry. The second language list, the whole-tree publication path and the install-without-scripts trap are gone. The orchestrator image can shed toolchains only this target needed.
- **Contract change.** The `code` value leaves the public contract. That is a high-risk item (a contract others consume), so step 1 ships it as its own commit with the contract regenerated, as the audit proposed. Whether the `target` field itself stays is not decided here (point A below).
- **Order with ADR-0010.** `src/server/merge-guard.ts:354-355` and `:402-403` name the code runner, `code-setup.ts`, `test-run-evidence.ts` and the Stryker adapter as protected paths. The audit's step 1 order removes the maintainer (item 10) before the code target (item 15), so the list is gone when its entries would dangle. See [ADR-0010](0010-maintainer-removal.md).
- **Order with ADR-0004 and ADR-0006.** `run-engine-factory.ts:985-1005` picks the oracle by target: Stryker for code, the response oracle for E2E. ADR-0004 removes the second arm, ADR-0006 gives bundle mutation its own switch, this ADR removes the first. Whichever lands first must leave the others compiling.
- **Toolchains.** `Dockerfile:15-18` and `:73` need `build-essential`, `python3` and `pip3` for the arm64 better-sqlite3 build and for `lizard`, so they stay. Whether the JDK, Maven, Gradle, Rust and Go (`Dockerfile:42-70`) have another user is not checked here; step 1 checks before removing them. The JaCoCo reader (`jacoco-coverage.adapter.ts`, readers row above) reads the reports a Java code run writes, so its fate and the JDK's are decided together.
- **The owner's qayaba configuration.** The app schema makes `dev` optional only for `code: true` (`src/orchestrator/schemas.ts:117-120`, `:382`) and refuses a config with neither: "dev is required unless code: true" (`:396-397`). That file keeps `code: true` and has no `dev` block (checked on the host). Once the key and the refine go, the file no longer validates: an E2E app needs a `dev` block (`config/apps/example.yaml:86`, `run-engine-factory.ts:693-697`). How the loader reports it is not checked (hypothesis: it fails loud on the missing `dev`, while the unknown key `code` is stripped silently, audit 8.4). The file is the owner's data (point B below).
- **Languages of the later RFC.** The golden rule extends languages "through the language registry … never through special cases" (`AGENTS.md:5-8`), so the later code-level RFC meets it like any other feature. This follows from the standing rule; D8 did not state it.
- **History.** No row needs migrating: every recorded run and outcome is `e2e` (fact 1). Whether the `target` columns are dropped or kept constant is a step 1 detail.
- **Records that cite deleted files.** This ADR names files step 1 deletes. The previous-forms gate fails on a document that names a path or `file:line` that no longer exists (`scripts/check-previous-forms.ts:124`, `:131`, `:136`), and it scans `docs/architecture/` once git tracks the folder (`.gitignore:71` ignores it at 4105c582; [README](../README.md), open question 2). It skips only `odd/` and a few files (`:54-62`). Point C below.

### Not decided here

Decided 2026-10-28: each recommended answer below is accepted ([ADR-0013](0013-owner-decisions-remaining-questions.md)).

| Point | The question | Recommended answer |
|---|---|---|
| A | Does the `target` field stay in the contract with the single value `"e2e"`, or leave? | Keep it with one value in step 1 (the smaller change; no client breaks) and drop it at the next contract revision. Not checked: whether any client outside this repository sends it. |
| B | What happens to the owner's app configuration for qayaba itself, which keeps `code: true` and has nothing to test end to end? | Remove it. qayaba has no web UI to test, and no run history exists for it (fact 1). It is the owner's data: no agent edits it without the owner's go (the disarm approved in D8 is the one edit made so far). |
| C | The records cite files step 1 deletes, and the previous-forms gate would flag them. | Skip only the path and citation checks for `docs/architecture/` and keep its banned-term rules: [RFC-0002](../rfc/0002-platform-steps-0-1.md) Q1, commit G1, which lands before the first deletion. The records are dated to a commit by design; the gate already skips `odd/` for the same reason (`scripts/check-previous-forms.ts:54`). The [README](../README.md) compares the options. |
| D | What counts as a "stable E2E MVP" for reopening code-level testing? | One definition for the whole project: reuse the activation criterion of [ADR-0005](0005-coverage-enforce-activation.md) (consecutive replicates with a trustworthy measurement). That is a proposal; ADR-0005 is about coverage, not about this. |

Correction 2026-10-30 (point B): the owner's app configuration for qayaba itself was backed up to the data volume (`backups/qayaba-app-config-2026-10-29.yaml`) and removed by the agent on the owner's go of 2026-10-30, "de las acciones que marcas como mias, resuelve tu todas las que puedas" (translated: "of the actions you mark as mine, you resolve all you can"; feature document L13, [ADR-0013](0013-owner-decisions-remaining-questions.md) correction). The same file is not in the worktree (L22).

## Enforcement

Not enforced yet. At 4105c582 nothing prevents the code target from returning. Step 1 adds, in the same commit series:

| Holds | Mechanism |
|---|---|
| No code branch survives | `npm run typecheck`: the target type narrows to one member (or goes), so a leftover `"code"` fails to compile. |
| The contract carries no `code` | `npm run contract:check` after regeneration. |
| The removed names do not return in code or docs | A rule added to `BANNED_RULES` (`scripts/check-previous-forms.ts:38`) for the removed names, with the same commit deleting the files they named; the gate's dead-path and dead-citation checks fail on any document left pointing at them. |
| No exception names a deleted file | The allowlist entry for `code-execution.runner.ts` in `qa-engine/.dependency-cruiser.cjs:105` (rule `no-child-process-outside-launchers`) is removed. |

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the code target, switched off, until E2E is stable | It is the pattern the owner named on 2026-10-28 14:14Z: features added on features, left to decay. Disarming handles publication only; the 84 files, the toolchains, the contract value and the second language list stay, and `config/apps/example.yaml:18-21` still invites an operator to switch it back on. |
| Keep it and fix the install now | A fix means running install scripts of an untrusted repository, or adding a per-repo build step. `--ignore-scripts` exists to close the cheapest remote-code vector (`code-execution.runner.ts:101`). That is new work on a path outside the E2E MVP. |
| Keep only the Stryker oracle for the repo's own mutation presets | Those presets run through `scripts/mutate.ts`, not through the oracle adapter, so deleting the adapter loses nothing they use (`scripts/mutate.ts:604-620` names the adapter only in the `code-run-reads` preset). |
| Move code-level testing to a separate service now | No evidence of need. A new service before the E2E MVP is stable is the added complexity the owner asked to justify first ([ADR-0001](0001-design-pillars.md)). |
| **Delete now, rebuild later as an RFC (chosen)** | It is the smallest change that removes the cost and the false-failure path, and it leaves the later design free to start from the language registry and the engine ports. |
