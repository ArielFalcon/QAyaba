# RFC-0002: Platform steps 0-1: encode the target, delete what is dead

- **Status:** Accepted, 2026-10-28: Q1 to Q15 and the inherited points as recommended ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md)). Decided before: the work order (platform steps 0-1, then one slice per confirmed root-cause family, then steps 4-6; [ADR-0002](../adr/0002-architecture-direction.md)) and five deletions: D1 and D2 ([ADR-0003](../adr/0003-learning-layer-rebuild.md)), D5 ([ADR-0004](../adr/0004-response-value-oracle-removal.md)), D8 ([ADR-0007](../adr/0007-code-target-removal.md)), D11 ([ADR-0010](../adr/0010-maintainer-removal.md)). Proposed, not decided: the edits of step 0, the commit order of step 1, three gate changes, the deletions of rows 1 and 2 that no ADR names, and where the audit's other discards ([RFC-0001](./0001-dormant-features.md)) fall. Fifteen forks are listed under "Owner decisions needed" (Q1 to Q15), followed by the inherited ADR points with their recommended answers, among them ADR-0004's open question 1 (whether the value fields leave the contract in step 1).
- **Code references at 4105c582:** `docs/engine-platform-architecture.md:70-101`, `docs/engine-platform-architecture.md:155-170`, `AGENTS.md:40`, `AGENTS.md:665-666`, `qa-engine/.dependency-cruiser.cjs:97-106`, `qa-engine/test/arch/shell-public-surface.test.ts:17`, `qa-engine/.dependency-cruiser-shell-exceptions.json`, `scripts/check-previous-forms.ts:38-76`, `src/errors.ts`, `src/contract/events.ts`, `src/server/run-history-sqlite-adapter.ts:24-89`, `src/server/merge-guard.test.ts:81`, `src/server/run-engine-factory.ts:985-1005`, `Dockerfile:72-87`, `package.json:23`, `qa-engine/src/contexts/evaluation/domain/graders.ts:114-121`, `qa-engine/src/shared-kernel/error-class.ts:159-162`, `src/server/wire-app.ts:393-403`, `src/server/health-poller.ts:17`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0003](../adr/0003-learning-layer-rebuild.md), [ADR-0004](../adr/0004-response-value-oracle-removal.md), [ADR-0006](../adr/0006-bundle-mutation-switch.md), [ADR-0007](../adr/0007-code-target-removal.md), [ADR-0010](../adr/0010-maintainer-removal.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0001](./0001-dormant-features.md), [RFC-0003](./0003-coverage-dump-harvest.md), [RFC-0004](./0004-log-level-from-outcome.md), [RFC-0005](./0005-suite-store-single-writer.md), [rejected-explanations](../rejected-explanations.md), [README](../README.md), the platform plan `docs/engine-platform-architecture.md`

## Summary

1. Step 0 is two documentation commits: the placement rule and its eight-row decision table go into `AGENTS.md`, and the inventory (188 non-test files of `src/`, 29,735 lines, each with a row and an owning context; the counting basis is under Problem) goes into the migration's feature document. The inventory finds 5 modules read as copies of engine things (4 hold), 7 modules that die only because an approved deletion cuts their wiring, 33 modules that answer yes to more than one row, and 3 gaps in the table itself.
2. Step 1 is 27 commits in a proposed order, one deletion each (one more if Q11 is accepted): 2 gate-preparation commits, 9 for rows 1 and 2, then D11 (4), D1 with D2 (4), D8 (3), D5 (4, the last of them removing the dead value fields from the contract) and a final one that derives the stored run outcome from the engine's type. Every commit leaves the full CI gate green; the shell-exceptions list only shrinks (47 entries now, 45 after step 1).
3. Checking the audit's and the first inventory's row-1 and row-2 claims against the code changed six of them: `src/util/sleep.ts` is not a clean twin, the stored run outcome is a projection, the `opencode-client` barrel hides deep imports, three `repo-mirror` functions are used by a script, two files the audit lists as unreachable are loaded at run time, and `src/qa/learning/` holds a live file. None is a step 1 deletion as first read.
4. Three findings go beyond the ADRs: D1 leaves the intelligence view with one field, so the whole route can go (Q6); the child-process rule scans only `qa-engine/src` while `AGENTS.md:665-666` says any new module that imports `child_process` fails the build (Q3); and the image installs three static-signal tools that nothing runs (Q11).
5. The proposed order is D11, D1 with D2, D8, D5. It differs from the audit's list because `src/server/merge-guard.test.ts:81` fails if a protected file is deleted before the guard, and the learning fold reads the oracle's score. Fifteen owner decisions and the inherited ADR points, each with a recommended answer, are at the end.

## Problem

Evidence labels: a statement without a label is confirmed (the file was opened at 4105c582, or the number was counted from the tree at that commit); a figure taken from an ADR or from RFC-0001 says so; a hypothesis is marked. Counting basis: every count of files or lines is of non-test files (no `.test.` in the name) with the extension `.ts`, `.mjs`, `.cjs` or `.js`, listed by `git ls-files` at 4105c582, lines counted with `wc -l`.

### What the owner said (translated)

| Date | Words | Where recorded |
|---|---|---|
| 2026-10-28 | "The problem was that at the start, instead of deciding on an MVP and making it work, I kept adding features on top of features in an app that did not work. That is why I want you to look for what is switched off, to see whether its hypothetical value once fixed justifies integrating it or it is discarded." | [ADR-0010](../adr/0010-maintainer-removal.md), Context |
| 2026-10-28 | "Regarding the 13 recommendations I agree with everything." | [ADR-0004](../adr/0004-response-value-oracle-removal.md), Decision source |
| 2026-10-28 | "The order seems fine to me" | [ADR-0002](../adr/0002-architecture-direction.md), section 2 |
| 2026-10-28 | "Do not add more patches to main; keep those discoveries as information for the refactor process" | [ADR-0002](../adr/0002-architecture-direction.md), section 2 |

### The chain, checked at 4105c582

| # | What happens | Where |
|---|---|---|
| 1 | The target layout and its placement rule live in one document. The file every session loads says the opposite: `src/` is "The permanent shell around the engine", with "four permanent roles". | `docs/engine-platform-architecture.md:70-101`; `AGENTS.md:40`, `AGENTS.md:106` |
| 2 | The plan makes step 0 the first step "so every change made during the migration already follows it", and its completion checklist ends with "`AGENTS.md` states the placement rule, and its repo map names the new roots". Nothing in `AGENTS.md` states the rule yet. | `docs/engine-platform-architecture.md:160-165`, `:236-245` |
| 3 | The shell holds 188 non-test files (29,735 lines; the engine holds 738, 75,726 lines; same basis, stated above). Five shell modules were read as copies of engine things (four hold; some are kept in step by parity tests); 12 engine files are reached by nothing. | `src/errors.test.ts:61-64` ("from either error taxonomy"), `src/server/seam-parity.contract.test.ts:35-69` |
| 4 | Features were switched off, or stood in for by a no-op, instead of removed, and their code still costs. Example 1: the maintainer's protected-paths list has 195 entries (22 of them directories or globs; counted at 4105c582) and a test forces every later move to update it (the list is `PROTECTED_PATHS` in `src/server/merge-guard.ts:21`). Example 2: 84 production source files (`src`, the engine, `scripts`, `client`, `packages`) carry a branch for the code target ([ADR-0007](../adr/0007-code-target-removal.md) figure, a lower bound). Example 3: the curriculum puts a false "PROVEN" statement into lead prompts (8 runs carry it, per [RFC-0001](./0001-dormant-features.md) figure). | `src/server/merge-guard.test.ts:81`; [ADR-0003](../adr/0003-learning-layer-rebuild.md) "A measurement difference" |
| 5 | The gates that should keep the shell small have three gaps. (a) The frozen shell-exceptions list holds 47 entries and its ceiling constant is 57, so ten entries can be added without a failing test. (b) The child-process rule has `from.path "^qa-engine/src/"`, so no file of `src/` is scanned; `src/server/maintainer-runtime.ts:5` imports `execSync` and four non-test files of `src/` import `child_process` today. (c) The previous-forms gate scans `docs/architecture/` for paths and `file:line` citations, so every record that cites a file step 1 deletes fails the gate once git tracks the folder (`.gitignore:71` ignores it at 4105c582; [README](../README.md), open question 2). | `qa-engine/test/arch/shell-public-surface.test.ts:17`, `:83-92`; `qa-engine/.dependency-cruiser.cjs:97-106`; `AGENTS.md:665-666`; `scripts/check-previous-forms.ts:73-76`, `:117-138` |

Runs that show the cost (figures from the records, not re-read here): the response oracle produced no score in the 31 outcomes of the history window ([ADR-0004](../adr/0004-response-value-oracle-removal.md)); no merged maintainer fix is evidenced: 18 `origin/qa/maintainer-*` branches exist and none is an ancestor of `main`, though squash merges would not show as ancestors ([ADR-0010](../adr/0010-maintainer-removal.md), not re-checked); the one baseline replicate `run-ed28973-mvs7oo0f-17041c71` on 4105c582 passed with line coverage 0.630 and 0 of 3 mutants killed ([ADR-0006](../adr/0006-bundle-mutation-switch.md)).

### Findings that change the row-1 and row-2 list

The audit's reachability list and the first inventory were checked name by name, not only by import. Six claims do not hold as written or need a limit.

| Claim to check | What the code shows | Consequence for step 1 |
|---|---|---|
| `src/util/sleep.ts` is a copy of an engine helper | The engine's `sleepWithAbort` is private to `qa-engine/src/contexts/generation/infrastructure/sse/event-stream.ts:141` and has another signature (`(ms, signal?)` against the shell's `(ms, opts?: { signal })`); a third plain `sleep` sits at `qa-engine/src/contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.ts:17`; the shell's only importer is `src/server/runner.ts:22`. | Not deleted. A shared kernel helper is a step 3 choice (Q13). |
| `toStoredRunOutcome` and the shell `RunOutcome` are a copy of the kernel type | `src/server/run-history-sqlite-adapter.ts:24-89` is a projection that drops `note`, `cases`, `logs`, `diffArchetypes` and `adjudication` by design (the allow-list is `src/server/seam-parity.contract.test.ts:35-69`). It carries every `gateSignals` field (48, 42 of them behind a conditional spread, `:32-84`) through an explicit copy into a second hand-written type (`src/types.ts:153-297`), with three casts where the two types differ (`:32`, `:53`, `:86`). The read model also returns the shell type. | Deleted last, as a derived type (`Omit` of the kernel's), after VF shrinks the type (commit Z, which names the casts). |
| The `src/integrations/opencode-client.ts` barrel is a pass-through to delete | It hides deep imports of infrastructure files; removing it would add entries to the frozen list. | Not deleted; step 3 (the entry stays on the list). |
| `getCommitDiff`, `getCommitMessage`, `listChangedSpecs` of `src/integrations/repo-mirror.ts` (`:109`, `:153`, `:138`) are dead | `scripts/baseline-agent.ts:922`, `:1047`, `:1048`, `:1116` call them (`npm run baseline-agent`). They are parallel implementations of the engine's `GitMirrorReadAdapter`, not copies: the shell's `getHeadSha` (`:165`) throws on a git failure, the engine's `headSha` returns `null`; the shell's `getCommitMessage` returns the message untrimmed, the engine's trims. | Not deleted. Their fate follows the fate of `scripts/baseline-agent.ts` and step 3 with pinning tests (Q12). |
| `capture-dom.script.cjs` and `codegraph-store-reader.mjs` are unreachable (audit list) | Both are loaded at run time and no import shows it: `qa-engine/src/contexts/generation/infrastructure/embedded/capture-dom.script.cjs` is read as text at `qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts:673`; `qa-engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs` is spawned (`STORE_READER_SCRIPT`, `qa-engine/src/shared-infrastructure/code-graph/codegraph-engine.ts:22`). `src/server/file-boundary-check.ts` is started by `bin/container-entrypoint.sh:71-72` and spawns `src/server/file-boundary-probe.mjs` (`file-boundary-check.ts:40`); no non-test file imports either. | Never deleted by an import scan. The 12 files of commit A5 were each searched by name. |
| The folder `src/qa/learning/` goes with the learning layer | `src/qa/learning/infra-error-gloss.ts` is live (used by `src/server/chat.ts`, `src/server/help.ts`, `src/server/run-report-view.ts` and `src/qa/value-report.ts`). | D1 deletes named files of the folder, never the folder. |

### What it does not explain

None of this explains a run failure family; [RFC-0001](./0001-dormant-features.md) says so of the dormant members and the same holds for twins and unreachable files. Step 1 alone is not expected to change a verdict. The only change a run can see is the lead prompt losing the exemplar section when D1 lands ([ADR-0003](../adr/0003-learning-layer-rebuild.md), "A measurement difference"), which [ADR-0011](../adr/0011-root-cause-fix-policy.md) requires every before/after comparison across step 1 to list.

## Goals and non-goals

**Goals**

1. A session that reads `AGENTS.md` meets the placement rule and the decision table, and every module of `src/` has a row and an owner on file before any module moves.
2. Step 1 deletes what rows 1 and 2 name and what D1, D2, D5, D8 and D11 decided, one commit per deletion, with the callers switched and the tests that pinned the deleted code deleted with it.
3. The CI gate gets harder in three places only: the records stop failing the gate for citing a deleted file, the frozen list's ceiling matches its length, and the child-process rule covers `src/`.
4. Nothing in a run changes except what D1 removes from the lead prompt.

**Non-goals.** Moving any module (steps 2 to 6); renaming the roots; rebuilding the learning layer ([ADR-0003](../adr/0003-learning-layer-rebuild.md) schedules that apart); the switches of ADR-0005 and ADR-0006; any fix of RFC-0003, RFC-0004 or RFC-0005; host and remote state (closing the maintainer's pull requests, removing a mirror directory); the owner's gitignored app configuration.

## Options

| | A. Encode, then delete in dependency order, one commit per deletion | B. Delete lazily, when a later step first touches the code | C. Delete every discard of the audit in step 1 |
|---|---|---|---|
| What it removes | Rows 1 and 2, the 12 unreachable files, the five decided deletions: about 1,935 lines of the maintainer runtime, its guard and its boot guard, 1,233 of 1,646 lines of the learning context, 439 lines of the oracle, about 1,100 lines of the code target, plus their tests | Nothing now | Everything in A plus the 17 members with no decision ([RFC-0001](./0001-dormant-features.md)) |
| Complexity added | One predicate in the gate script, one constant, one scope change of an arch rule, and the tests under Test plan | None | A, plus decisions that are not made |
| Risk | Each commit is a deletion with a compiler and a full gate behind it; the risks no test covers are listed under Recommendation | Steps 2 to 6 carry the dead code. The plan's own premise: "Deleting first shrinks everything that follows" (`docs/engine-platform-architecture.md:167-170`). The 195-entry protected-paths list is edited by every later move until D11 | Deletes features the owner has not judged. It contradicts RFC-0001's own recommendation to decide each member; it is not this RFC's call |

Two sub-choices inside A. **By feature or by layer**: a commit per feature (recommended) keeps each revertable and keeps the governance-sensitive ones alone (`AGENTS.md:690`); a commit per layer (all contract removals, then all prompts) mixes decisions and cannot be reverted by decision. **Gate exemption** (Q1): skip the folder entirely, as the gate does for `odd/`, or skip only the reference checks.

## Recommendation

Option A. It is the smallest change that follows the approved order, it adds no module (every addition is a gate rule or a test), and nothing in it names an app: the only project-shaped input is the declared scope in the language registry, which A6 shrinks.

### Step 0: two documentation commits

**S0.1: `AGENTS.md`.** The plan's step 0 names "repo map and boundary sections" (`docs/engine-platform-architecture.md:160-162`). The edit:

| Where (4105c582) | Change |
|---|---|
| Repo map, `src/` row (`AGENTS.md:40`) | "The permanent shell around the engine" becomes the shell the migration empties: each module has a row of the decision table and moves to the engine or the platform at steps 2 to 5. |
| Boundary section (`AGENTS.md:103-117`) | "`src/` has four permanent roles" (`:106`) becomes "four kinds of module today", each naming its row: composition root = row 8, control plane = row 7, provider I/O edges and persistence = rows 6 and 4. |
| New "Placement rule" section after the Boundary section | The two-sentence rule, the eight-row table and the "more than one yes means split" paragraph, copied from `docs/engine-platform-architecture.md:70-101`; one line mapping the plan's target names to today's folders (engine = `qa-engine/src`; platform = the composition root, control plane, provider edges and persistence of `src/`) until step 5 names the roots; one line saying a change places each part it touches by the table first. |
| One line (Q14) | A pointer to [ADR-0001](../adr/0001-design-pillars.md), as its open question 4 asks. |
| One sentence under the table (Q14) | Test support (a module only tests import) takes no row and moves with its tests; the inventory found 4 such modules and the table has no row for them. |

The table has one home. After S0.1 the plan document's copy is replaced by a pointer to `AGENTS.md`, so no second copy can drift (Q14).

**S0.2: the feature document.** `odd/tasks/<feature-name>.md` (proposed name `platform-migration`), with its Engram mirror `odd/<feature-name>/tasks`, created before the first source write. It holds the header, `## Specs` (the owner's strings above, quoted), `## Tasks` (the 29 commits of this RFC with their evidence), `## Log` (`L1` is the owner's request), and the inventory: one row per module with its row, its owning context or platform folder, its importers and its fate.

**The inventory, summarized** (188 files on the counting basis above; the full table is the S0.2 commit):

| Placed as | Count | What |
|---|---|---|
| 1. Copy of an engine thing | 5 | `src/errors.ts`, `src/contract/events.ts`, `src/qa/learning/curriculum.ts`, `src/qa/learning/learning-rule.ts`, `src/util/sleep.ts` (the last one fails the check, see Findings) |
| 2. Nothing reaches it | 0 whole modules | 11 dead names inside live modules were listed; 8 hold (`RunOptions`, `AgentResult`, `capText`, `MAX_PROMPT_BODY_CHARS`, `SECRET_AUDIT`, `mergePullRequest`, `getPullRequest`, `resolveApiToken`); 3 are used by a script (`repo-mirror.ts`) |
| 2D. Reached only through wiring a decided deletion removes | 7 | all in `src/server/`. D11: `maintainer.ts`, `maintainer-memory.ts`, `maintainer-runtime.ts`, `maintainer-summary.ts`, `merge-guard.ts`, `self-update.ts`; D1: `reflector-switch.ts` |
| 3. Decides something about a run | 15 | engine contexts at step 2; for example `src/server/turn-telemetry-config.ts`, `src/integrations/verdict-parse.ts`, `src/integrations/verdict-validate.ts`, `src/server/chat.ts`, `src/server/help.ts` |
| 4. Adapter for one context | 10 | for example `src/server/coordination-events.ts`, `src/server/judge-agent.ts` |
| 5. Adapter shared by contexts | 1 | `src/server/dns-forward.ts` |
| 6. Process-wide resource | 55 | database, telemetry, settings, agent-server client |
| 7. Entry point or wire contract | 52 | routes, webhook, queue, CLI, and the sandbox boot probe `src/server/file-boundary-probe.mjs` (note below) |
| 8. Composition | 6 | `src/server/engine-root.ts`, `durable-run-events.ts`, `file-boundary.ts`, `judges-composition.ts` and two more |
| T. Test support (no row) | 4 | `src/telemetry/trace-harness.ts`, `src/server/web-console/console-harness.ts`, `src/integrations/fixtures/opencode-roster.ts`, `src/no-console.scan.ts` |
| Split (more than one yes) | 33 | below |

`src/server/file-boundary-probe.mjs` (99 lines) is the one non-`.ts` file of `src/`. It is the program `file-boundary-check.ts` runs as the sandbox uid, with the plain node binary and no loader (`src/server/file-boundary-check.ts:12-14`, `:40`; `docs/execution-sandbox.md:118`). Proposed: row 7 like its parent, owned by the platform entry points beside `file-boundary-check.ts`, and moved with it at step 2. It is governance-sensitive (listed in the protected paths today, `src/server/merge-guard.ts:388`), so it moves in a commit of its own. Its declaration file `src/server/file-boundary-probe.d.mts` (20 lines) is outside the counting basis and moves with it.

The 33 split modules, which step 2 splits before it places the parts:

| Part of `src/` | Modules |
|---|---|
| `src/server/`, a to k (8) | `context-map-wiring`, `effective-config`, `egress-wiring`, `evaluation-evidence`, `evaluation-service`, `exec-sandbox-factory`, `judge-evidence`, `judge-settings` |
| `src/server/`, l to z (10) | `login-bootstrap-wiring`, `mirror-prune`, `port`, `run-engine-factory`, `run-history-sqlite-adapter`, `runner`, `sandbox-health`, `service-context`, `tools-endpoint`, `wire-app` |
| the rest of `src/` (15) | `src/cli.ts`, `src/types.ts`, `src/integrations/github.ts`, `src/integrations/opencode-client.ts`, `src/integrations/repo-mirror.ts`, `src/orchestrator/schemas.ts`, `src/qa/learning/oracle-types.ts`, `src/qa/usage.ts`, `src/server/api/use-cases/continue-run.ts`, `src/server/api/use-cases/create-run.ts`, `src/server/api/use-cases/login-bootstrap.ts`, `src/server/onboarding/onboarding-job.ts`, `src/server/persistence/repositories/learning.repository.ts`, `src/server/persistence/repositories/run.repository.ts`, `src/settings/defaults.ts` |

**The 47 entries of the frozen list, by inventory module** (`qa-engine/.dependency-cruiser-shell-exceptions.json`):

| Entries | Count | Belongs to | Fate at step 1 |
|---|---|---|---|
| `scripts/agent-browser-smoke.ts`, `baseline-agent.ts`, `campaign.ts`, `harness-auth.ts`, `onboard-app.ts`, `prompt-contract-matrix.ts`, `sandbox-smoke.ts`, `warm-suite.ts` | 8 | Not `src/` modules: entry points that stay in `scripts/` | Stay |
| `scripts/prompt-contract-matrix.test.ts`, `prompt-contract-matrix.sample.test.ts` | 2 | Tests of `scripts/prompt-contract-matrix.ts` | Stay |
| `scripts/model-agnostic-prompts.test.ts` | 1 | The model-agnostic prompt guard (`scripts/model-agnostic-prompts.test.ts:1-8`): it scans the static prompt layers and every prompt the harness sends, and drives the prompt-contract matrix. It belongs to the prompt layers, not to one script. It pins the prompts built by the engine contexts and by `src/server/chat.ts`, `src/integrations/opencode-client.ts`, `src/integrations/verdict-validate.ts` and the onboarding proposer adapter, all of which stay | Stays, after M2 and L2 edit it: it imports `src/server/maintainer-runtime.ts`, `maintainer.ts` and `maintainer-memory.ts` (`:32-34`) and the reflector adapter (`:24`), which they delete |
| `scripts/learning-quarantine.ts` | 1 | Dies with D1 | Leaves in L3 |
| `src/integrations/opencode-client.ts` | 1 | rest, split (rows 6, 3, 1) | Stays (step 3) |
| `src/integrations/repo-mirror.ts` | 1 | rest, split (rows 5, 1, 2) | Stays (step 3) |
| `src/server/engine-root.ts` | 1 | server a-k, row 8 | Stays |
| `src/server/judge-agent.ts`, `judge-evidence.ts`, `judges-composition.ts` | 3 | server a-k, rows 4, split, 8; dormant, decision pending ([RFC-0001](./0001-dormant-features.md) OD-1) | Stay unless OD-1 deletes the judges (then 3 more leave with their 2 tests) |
| `src/server/login-bootstrap-wiring.ts` | 1 | server l-z, split (rows 3, 8) | Stays |
| `src/server/maintainer-runtime.ts` | 1 | server l-z, 2D | Leaves in M2 |
| `src/server/run-engine-factory.ts`, `tools-endpoint.ts`, `wire-app.ts` | 3 | server l-z, split | Stay |
| `src/server/turn-telemetry-config.ts` | 1 | server l-z, row 3 | Stays |
| 23 test files in `src/` | 23 | The module each pins: `agents-prompts.test.ts` and `verdict-parser-wiring(.noop-kind).test.ts` and `verdict-validate.test.ts` pin `verdict-parse.ts` and `verdict-validate.ts` (row 3); `role-session-routing.test.ts` pins `src/agent-runtime/`, `run-engine-factory.ts` and `opencode-client.ts`; `opencode-client.test.ts`, `engine-root.test.ts`, `judge-agent.test.ts`, `judge-evidence.test.ts`, `run-engine-factory.test.ts`, `tools-endpoint.test.ts` and `webhook-routing.test.ts` pin the module of the same name; `agent-efficiency-contract.test.ts` pins the persistence layer (row 6); `onboarding/write-boundaries.test.ts` pins `write-boundaries.ts`; `spec-snapshot.test.ts` pins `spec-snapshot-sqlite.adapter.ts`; the 8 `src/telemetry/*.test.ts` files read span shapes through `trace-harness.ts` (test support) and belong to the platform telemetry modules | Stay, except that the two judge tests leave with OD-1 |

Totals: 12 in `scripts/`, 12 production modules of `src/`, 23 tests. Certain shrink in step 1: 47 to 45 (`maintainer-runtime.ts` in M2, `scripts/learning-quarantine.ts` in L3). The ceiling constant is 57 (`qa-engine/test/arch/shell-public-surface.test.ts:17`) and the list has 47 entries, so ten additions would pass the test unnoticed (Q2).

**Gaps in the decision table found by the inventory** (the table is the owner's design; these are proposals for Q14):

1. Test support has no row (4 modules). Proposed: it moves with its tests and takes no row.
2. `src/telemetry/instrument-table.ts` declares the metric and attribute names of the engine's own vocabulary (verdict, error class, review outcome). It is placed in row 6 as the adapter's table; its destination is `qa-engine/src/shared-kernel/telemetry/`, beside the attribute registry.
3. Question 4 against question 6 for a process-wide resource that one context uses (`score-metrics-sink.ts`, `ledger.ts`): placed by the resource (the process meter, the span processor), so row 6; a resource one context only uses (the Langfuse HTTP API) is row 4.

Three owners in the inventory are proposals that follow the vocabulary of existing code, not decisions: a new context for the operator assistant (`chat.ts`, `help.ts`; no context owns it), `test-execution` for the egress origins, `run-orchestration` for the context-map rule (Q15).

### Step 1: the commit order

Conventions: one deletion per commit; the commit carries its callers, its tests, its docs and its retired-name rule for `BANNED_RULES`; `gov` = governance-sensitive (ships alone, `AGENTS.md:690`); `contract` = public contract (high-risk item 3). The 400-line figure is a planning heuristic, not a limit: most of these commits are deletions and say so in their message.

| ID | Subject (conventional) | Removes | Class |
|---|---|---|---|
| S0.1 | `docs(agents): state the placement rule and the decision table` | nothing | |
| S0.2 | `docs(odd): add the platform migration feature document with the inventory` | nothing | |
| G1 | `ci(previous-forms): stop checking references in docs/architecture` | gate behaviour (Q1) | gov (CI) |
| G2 | `test(arch): lower the shell exceptions ceiling to the entries it holds` | 10 spare slots | |
| A1 | `refactor(errors): use the kernel's error taxonomy in the shell` | `src/errors.ts` (57 lines), `src/errors.test.ts` | |
| A2 | `refactor(contract): import run events from the kernel` | `src/contract/events.ts` | |
| A3 | `refactor(types): remove two dead interfaces and two copies of kernel types` | `RunOptions`, `AgentResult`, `SpecMeta`, `SpecRecord` in `src/types.ts` | |
| A4 | `refactor(logger): import LogLevel from the kernel port` | the copy at `src/integrations/logger.ts:18` | |
| A5 | `chore(engine): delete 12 files nothing reaches` | 12 engine files (list below) | |
| A6 | `refactor(language-registry): remove the astGrep flag nobody reads` | the flag, `hasAstGrepRules`, its test | |
| A7 | `refactor(api-token): remove resolveApiToken` | one function | gov (token) |
| A8 | `refactor(sanitizer): remove capText and MAX_PROMPT_BODY_CHARS` | two exports | gov (redaction) |
| M1 | `fix(health-poller): log the signals the maintainer incidents carry` | adds log lines | |
| M2 | `refactor(maintainer)!: remove the runtime, auto-merge, canary swap, merge guard and boot guard` | per [ADR-0010](../adr/0010-maintainer-removal.md) | gov (activation switch) |
| M3 | `refactor(agents): remove the qa-maintainer role and prompt` | write authority of the role | gov (write authority) |
| M4 | `ci(arch): apply the child-process rule to src` | adds a rule | gov (security invariant) |
| LC | `refactor(contract)!: remove the intelligence view and the reflector and curriculum config fields` | wire sections and config fields | contract |
| L2 | `refactor(learning): remove the reflector, its switch and its role` | reflector | gov (activation switch, role) |
| L3 | `refactor(learning): remove the rule loop` | ledger, fold, retrieval, injection, CLI | |
| L4 | `refactor(learning): remove the curriculum and the exemplar templates` | curriculum | |
| C1 | `refactor(contract)!: remove the code target from the wire` | `code` value | contract |
| C2 | `refactor(test-execution): remove the code target` | runner, setup, evidence, strategy, Stryker adapter | |
| C3 | `chore(image): remove the toolchains only the code target used` | `Dockerfile:30-70` candidates, egress registry entries | gov (environment) |
| A9 | `refactor(sanitizer): remove the write-only secret audit record` | `SECRET_AUDIT` and its hooks | gov (redaction) |
| V1 | `refactor(contract)!: remove the value oracle trend from the signals view` | wire section | contract |
| V2 | `refactor(objective-signal): remove the response value oracle` | seven files, 439 lines, and the `faultInject` execution option | |
| V3 | `refactor(seed): remove the fault-injection fixture, its sandbox allowlist and its setup anchors` | seed block, allowlist, anchors | gov (sandbox) |
| VF | `refactor(contract)!: remove the dead value fields` | `valueScore`, `valueByCandidate`, `valueStats`, `mutantCount`, `killedCount`, the `mutation_value` grader, the class `E-VALUE-SURVIVED` (list under D5); only after the owner answers ADR-0004 point 1 | contract |
| Z | `refactor(run-history): derive the stored run outcome from the engine's type` | the shell `RunOutcome` copy, its `gateSignals` copy and `StructuredReflection` | |

The D2 reset is an operation, not a commit: it is applied between M4 and LC (Q8). The closing live run follows Z (Q10). [RFC-0001](./0001-dormant-features.md) OD-14 (warn per unknown app-config key) proposes itself as the first commit of step 1; if accepted it goes before G1, as an addition, and must precede C1 and L2, which retire config keys.

**Why this order.**

| Constraint | Evidence | Effect |
|---|---|---|
| D11 before D8 and D5 | `src/server/merge-guard.test.ts:81` asserts every exact protected path exists; `src/server/merge-guard.ts:354-355` names `code-execution.runner.ts` and `code-setup.ts`, `:402-403` name `test-run-evidence.ts` and `stryker-mutation-oracle.adapter.ts`, `:166` and `:359` name the setup adapter and the sandbox allow-list | Deleting those files first fails that test, and editing the list first is wasted work. The audit's step 1 list (working notes, not committed) puts the response oracle before the maintainer series, which would edit a file the next commit deletes. |
| D1 before D5 | The fold reads the oracle's score (`qa-engine/src/contexts/cross-run-learning/application/fold-run-outcome.use-case.ts:24-27`) | The reader leaves before the writer's field does. |
| D8 before D5 | `ValueOraclePort` has three implementers: the response oracle, the null oracle and the Stryker adapter (D8); `src/server/run-engine-factory.ts:985-1005` picks one by target | The last of the two commits deletes the port and the null oracle. Either order works; D8 first leaves D5 the shorter tail. |
| VF after V2 and L3 | V2 deletes the writers of the value fields (`qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts:199-206`); L3 deletes the reader of `valueScore` (`fold-run-outcome.use-case.ts:24-27`) and the scorecard writer of `src/server/persistence/repositories/learning.repository.ts` | The fields have no writer and no reader when they leave the types, so the contract is regenerated once, in the commit that owns the change. |
| Outermost consumers first | The wire sections (LC, C1, V1) are cut before the code behind them | Each inner deletion then leaves the contract unchanged. |
| LC after the D2 reset | [ADR-0003](../adr/0003-learning-layer-rebuild.md) enforcement table: "the reset is applied and checked before the commit that removes the `curriculum` field of the intelligence view" | After LC the view can no longer show the reset. The direct read-only read of the table row works in either order (ADR-0003 says so), so the order is kept as ADR-0003 states it, not because the reset could not be read otherwise. |
| M4 after M2 | `maintainer-runtime.ts:5` is the fourth importer of `child_process` in `src/` | The rule is added when it passes with three named sites. |
| A9 after C2 | The write-only audit hook is also wired into the code runner (`qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts:299-300`, `:439`) | One caller fewer to edit. |
| Z last | It derives from the kernel type as VF leaves it, and the shell `StructuredReflection` it deletes loses its last callers in L2 and L3 | Deriving earlier would be redone. |
| G1 first | The records already cite files this RFC deletes | The first deletion commit would otherwise fail `npm run previous-forms:check`. |

**How the gate proves nothing broke.**

| Class | Proof before the commit lands |
|---|---|
| Every commit | The full CI gate: `npm run typecheck && npm run arch:check && npm run previous-forms:check && npm run seed:lint && npm run embedded:lint && npm run sdk:typecheck && npm run contract:check && npm run settings:check && npm test`, then `cd client && go vet ./... && go test ./...` (`AGENTS.md:64-66`). A global search for every removed name across code, docs, scripts, compose, `Dockerfile`, `bin/`, `web/` and `client/`, with no hit outside the records. The test count falls only by the deleted code's tests; the message lists the number (baseline: 12,282 tests, 12,280 pass, 2 skipped). |
| Removes a frozen-list entry | The entry leaves the list in the same commit (`qa-engine/test/arch/shell-public-surface.test.ts:89` fails on a stale entry) and the ceiling constant drops to the new length. |
| Contract (LC, C1, V1, VF) | `npm run contract:check` regenerated and `npm run sdk:typecheck`, the Go client tests, and the console and TUI views read in a browser at a mobile and a desktop width, or reported "NOT visually verified". |
| Settings (M2, L2) | `npm run settings:gen` then `npm run settings:check`. `.env.example` is hand-written, no gate covers it, and its edit is the owner's ([ADR-0013](../adr/0013-owner-decisions-remaining-questions.md) point 3, RFC-0001 OD-15), not part of M2 or L2 (Correction 2026-10-29). |
| Governance (gov) | Alone in the commit. `npm run sandbox:smoke` in the running container for M2, C2, V3. |
| Touches an assembled prompt | A throwaway byte comparison of the assembled prompts before and after on one fixed input (not committed): identical for every commit except L3 and L4, which differ only by the sections they remove. The prompt-contract baselines (`scripts/prompt-contract-baseline.json`) change deliberately and in that commit. |
| After Z | One live run against the test app (`docs/engine-platform-architecture.md:228-234`): the wired process starts, runs and finalizes; a green suite does not prove the composition root. |

### Step 1: what each deletion removes

#### Rows 1 and 2 not named by an ADR (A1 to A9)

| ID | Removes (paths at 4105c582) | Replaced by | Docs and prompts changed | Notes |
|---|---|---|---|---|
| A1 | `src/errors.ts` (57 lines) and `src/errors.test.ts` | `qa-engine/src/shared-kernel/domain-error.ts` (same classes, same `isInfraError` logic). Callers: `src/server/runner.ts:23`, `src/integrations/repo-mirror.ts:11` (used at `:208` in `realGit`) | none found | Two negative cases live only in the shell test (`src/errors.test.ts:24`, `:30`, `:53`: a generic `Error` is not infrastructure, non-Error throwables are not, a stalled agent is distinct from an unavailable one); move them into `qa-engine/test/shared-kernel/domain-error.test.ts` first. No test pins that `realGit` wraps a git failure in an `InfraError` (`src/integrations/repo-mirror.test.ts:437-487` tests scrubbing and hardening only): add it first. `repo-mirror.ts` is git hardening, so the commit touches only the import. |
| A2 | `src/contract/events.ts` (2 lines, a pure re-export) | `@kernel/contract/events.ts`, already used by `scripts/efficiency-benchmark.ts:22` and `scripts/probe-report.ts:17`. 9 production importers (`src/agent-runtime/facades.ts:3`, `src/agent-runtime/opencode-strategy.ts:17`, `src/agent-runtime/types.ts:4`, `src/cli-exit.ts:1`, `src/contract/openapi.ts:7`, `src/server/api/handlers/runs.ts:6`, `src/server/durable-run-events.ts:1`, `src/server/run-events.ts:1-2`, `src/server/runner.ts:25`) and 2 tests | | Comments that cite the deleted path must be edited: `client/internal/events/events.go:1`, `:93`, `client/internal/events/events_test.go:10`, `qa-engine/src/contexts/run-orchestration/domain/run-event.ts:1`. The generated contract must come out byte-identical. |
| A3 | `RunOptions` (`src/types.ts:29`; `scripts/mutate.ts:1005` has an unrelated one), `AgentResult` (`src/types.ts:56`), `SpecMeta` (`src/types.ts:20`), `SpecRecord` (`src/types.ts:86`) | the kernel's `SpecMeta` and `SpecRecord` (`qa-engine/src/shared-kernel/qa-case.ts:60`, `:68`); importers: `src/integrations/verdict-parse.ts:3`, `src/server/persistence/repositories/run.repository.ts:7` | none | The copies are identical and no parity test pins them. `UsageSnapshot` (`src/qa/usage.ts:8`) looked like a twin and was not checked. |
| A4 | `LogLevel` at `src/integrations/logger.ts:18` | `qa-engine/src/shared-kernel/ports/logger.port.ts:3`; importers `src/telemetry/log-shipper.ts:18`, `src/integrations/redacting-logger.ts`, `src/integrations/logger.ts` | none | |
| A5 | `qa-engine/src/contexts/app-catalog/application/ports/repo-info.port.ts`; the five extractor ports `complexity-`, `pattern-`, `relation-`, `semantic-diff-`, `symbol-extractor.port.ts` in `qa-engine/src/contexts/change-analysis/application/ports/`; `qa-engine/src/contexts/change-analysis/domain/static-signal.ts`; `qa-engine/src/contexts/change-analysis/domain/vcs-read.ts` (reached only by those ports; `vcs-read.port.ts` is another, live file); `qa-engine/src/contexts/generation/application/ports/dom-grounding.port.ts`; `qa-engine/src/contexts/generation/application/ports/plan-parser.port.ts`; `qa-engine/src/contexts/test-execution/application/ports/code-validate.port.ts`; `qa-engine/src/index.ts` (a comment: "qa-engine public entry is unused") | nothing; `repo-info.port.ts` could be implemented by `getRepo` and `listRepos` of `src/integrations/github.ts`, and is better redeclared at step 3 with a consumer | none | Each was searched by name, not only by import. |
| A6 | The `astGrep` flag of the language registry (`qa-engine/src/shared-kernel/language-id.ts:8`, `:24-27`), `hasAstGrepRules` (`:168`) and its one caller, `qa-engine/test/shared-kernel/language-id.test.ts:49` | nothing | the header comment of `language-id.ts:1` | Its only purpose was to pick an extractor A5 deletes. |
| A7 | `resolveApiToken` (`src/server/api-token.ts:62`; tests only; `loadOrCreateApiToken` is the live one) | | | The API token is a security boundary: the commit changes nothing else in the file. |
| A8 | `capText` (`src/orchestrator/sanitizer.ts:94`) and `MAX_PROMPT_BODY_CHARS` (`:91`), used by tests only | | | Redaction: the commit changes nothing else, and the redaction tests run unchanged. |
| A9 | `SECRET_AUDIT` (`src/orchestrator/sanitizer.ts:14`), write-only: written by `recordAudit` (wired at `src/server/run-engine-factory.ts:637`) through the optional hooks of the engine runners (`qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:181-182`, `:332`; `code-execution.runner.ts:299-300`, `:439`), read only by `src/orchestrator/sanitizer.test.ts` | | | Hypothesis: the record was meant for an operator who never got a reader. A reader that does not exist is the reason for the deletion. |

#### D11: the maintainer (M1 to M4)

The file list is [ADR-0010](../adr/0010-maintainer-removal.md), "What the removal deletes"; it is not repeated here. This RFC adds the order and what the ADR leaves open.

| ID | What | Notes |
|---|---|---|
| M1 | Three producers of a maintainer incident have no log beside them: the health probe after 3 and 10 failures (`src/server/health-poller.ts:44`, `:47`), a deep queue (`:53`) and the orphaned-session sweep when it cleaned sessions (`src/server/wire-app.ts:397-399`; the only lines near it that log are a failed sweep, `:402`, and a failed delete, `qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts:649-663`, so a successful sweep leaves no trace once M2 removes `recordIncident`). Each gets a log line before its only consumer goes. The other producers already log beside the incident: `src/server/runner.ts:683` (error, before `:693`), `src/server/wire-app.ts:242-245` (the unhandled-rejection recorder is given an error logger) and `src/server/runner.ts:840` (info, before `:843`). | Two changes to the poller's seam, both small. `HealthPollerDeps.log` accepts `"error"` as well as `"info"` and `"warn"` (`src/server/health-poller.ts:17`); the wired `logLine` already takes every `LogLevel` (`src/integrations/redacting-logger.ts:130`). `cleanupOrphanedSessions` returns the count it cleaned (`Promise<number>`, today `Promise<void>`, `health-poller.ts:12`) and the poller logs it, because the sweep is a closure of `wire-app.ts` that no test reaches. One RED test per trigger (3 failures, 10 failures, deep queue, a sweep that cleaned sessions) through `startHealthPoller` with fake dependencies. The level follows [RFC-0004](./0004-log-level-from-outcome.md) once decided; until then the proposal keeps each incident's own severity: error for both probe counts (recorded as "critical"), warn for the queue and the sweep (recorded as "warn"). |
| M2 | `src/server/maintainer-runtime.ts` (605), `maintainer.ts` (168), `maintainer-memory.ts` (81), `maintainer-summary.ts` (44), `merge-guard.ts` (768), `self-update.ts` (191), `boot-guard.mjs` (78), their tests, the `merge-guard` preset of `scripts/mutate.ts`, the `/api/maintainer/*` routes and the `qa maintainer` commands. `package.json:23` runs `node boot-guard.mjs && tsx src/index.ts` and `Dockerfile:156` runs `npm run start`, so the `start` script changes in the same commit. After the runtime goes, the five maintainer-only functions of `src/integrations/github.ts` have no caller (`createPullRequest` `:61`, `enableAutoMerge` `:82`, `mergePullRequest` `:108`, `getPullRequest` `:117`, `getPrStatus` `:132`), nor have the clamp helpers beside them; `getRepo` (`:193`) and `listRepos` (`:214`) stay for onboarding. Settings in `src/settings/registry.ts`: `QAYABA_REPO` (`:44`), `SELF_MAINTAINER_AUTOMERGE` (`:147`), `SELF_MAINTAINER_CI_CHECK` (`:148`); `selfRepo` is used only by the maintainer (`src/server/wire-app.ts:110`, `:365`) and its default is `DEFAULT_SELF_REPO` (`src/settings/defaults.ts:3`). The frozen list loses `src/server/maintainer-runtime.ts` (47 to 46). The prompt guard `scripts/model-agnostic-prompts.test.ts` is edited in the same commit: its maintainer prompt case (`:565-595`, entry `:679`), its imports of `maintainer-runtime.ts`, `maintainer.ts` and `maintainer-memory.ts` (`:32-34`) and the word in its header (`:1`) go. | `scripts/setup-branch-protection.sh` stays (ADR-0010 point B). Closing the 18 pull requests, deleting remote branches and the `qayaba-self` mirror directory are the owner's explicit go and not a commit. |
| M3 | `agents/agent/qa-maintainer.md` (80 lines), the `qa-maintainer` entry of `agents/opencode.json`, the role in `qa-engine/src/shared-kernel/agent-role.ts:3`, `src/agent-runtime/types.ts`, `src/integrations/fixtures/opencode-roster.json`, `src/integrations/agent-tool-surface.test.ts`. | The only role that edited qayaba's own source, with a `bash` tool, leaves. `scripts/model-agnostic-prompts.test.ts` needs no edit here: every mention of the role in it (`:1`, `:32-34`, `:565-595`, `:679`) went with M2, and M3's global search confirms it. |
| M4 | A rule change, not a deletion: `no-child-process-outside-launchers` (`qa-engine/.dependency-cruiser.cjs:94-107`) gets `src/` in its scope, excluding `\.test\.ts$`, with exactly three named sites: `src/integrations/repo-mirror.ts:7`, `src/server/run-engine-factory.ts:11` (hardened git at `:446`, `:476`) and `src/server/file-boundary-check.ts:22` (the boot probe). | Without it a fourth module can import `execSync` unobserved, which is how `maintainer-runtime.ts` did. RED test in the pattern of `qa-engine/test/arch/exec-launcher-spawn-sites.test.ts`. |

AGENTS.md and docs for D11: `AGENTS.md:583-585`, `:567`, `:464` and the other rows of the ADR-0010 table; `README.md`, `docs/execution-sandbox.md`, `docs/testing-standards.md`, `.env.example` (hand-written; the owner's edit, not this step's: Correction 2026-10-29), `docker-compose.yml`, `docker-compose.override.yml`.

#### D1 and D2: the learning layer (LC, L2, L3, L4)

[ADR-0003](../adr/0003-learning-layer-rebuild.md) leaves the file list to this RFC. Counts are non-test lines at 4105c582. The context `qa-engine/src/contexts/cross-run-learning` holds 1,646; D1 deletes 23 files (1,233 lines) and keeps 7 (413 lines). `LEARN` below is that context.

| Layer | Deleted (23 files) | Kept and edited (7 files) |
|---|---|---|
| `LEARN/application` | `fold-run-outcome.use-case.ts`, `quarantine-learned-rules.use-case.ts`, `render-learned-rules.ts`; ports `curriculum`, `learning-quarantine`, `learning-repository`, `learning-store`, `learning`, `reflector` | `index.ts`; `ports/process-audit.port.ts` |
| `LEARN/domain` | `curriculum-model`, `curriculum`, `distill-rule`, `learning-repository`, `learning-store-model`, `learning`, `quarantine`, `rule-fold`, `rule-governance.service` | `learning-gates.ts`; `process-audit.ts` (the `RuleView`, `readRules` and `deprecateRule` edges go; the `ErrorClass` import re-points to the kernel; D11 removes the incident edge at `:182`, `:206-208`); `should-distill-learning.ts` (D8 edits `isCode`) |
| `LEARN/infrastructure` | `adapters/learning-port.adapter`, `curriculum-port.adapter`, `reflector-port.adapter`, `sqlite-learning-repository.adapter`, `stub-learning-repository.adapter` | `process-audit-port.adapter.ts` |
| `LEARN/composition` | | `build-cross-run-learning.ts` |

Its tests: 17 files (3,479 lines); 5 stay (learning gates, process audit, should-distill, the process-audit adapter, the composition builder: 852 lines) and about 12 go (2,627 lines).

| ID | Removes | Notes |
|---|---|---|
| D2 (operation) | Resets the stored curriculum row of the one app that has one ([ADR-0003](../adr/0003-learning-layer-rebuild.md) names it). The feature document records a read-only read of the table row before and after. | `effective_config.grounding.curriculum` is `learning` in 34 of 34 runs, so the baseline replicate and cycle 3 ran under identical curriculum conditions (ADR-0003 figure). After L4 nothing reads the row: the reset is hygiene that D2 approved, not a condition for any behaviour (Q8). |
| LC | `GET /apps/:name/intelligence` and its surfaces; `reflector` and `grounding.curriculum` from the recorded effective config. The view is `{app, rules, scorecard, curriculum, curriculumCorrupt}` (`src/contract/commands.ts:789-797`); after D1 only `app` remains, so I propose removing the route: `src/server/api/handlers/insights.ts:21-26`, `src/contract/openapi.ts:377`, `src/server/intelligence-view.ts` (66), `client/internal/api/client.go:161-165`, `client/internal/ui/intelligence.go`, `web/public/js/api.js:107`, the generated SDK and Go types (Q6). `src/server/effective-config.ts:68` and `:72` stop writing the two keys; its reader (`:95`, `:112`) drops them from its shape but stays lenient (`:108-109`), so stored rows that carry them still parse. | ADR-0003 says the view "loses `rules`, `scorecard` and `curriculum`"; the schema shows that is all but one field. |
| L2 | `src/server/reflector-switch.ts` (19), `QA_REFLECTOR_ENABLED` (`src/settings/registry.ts:74`) and `REFLECTOR_TIMEOUT_MS` (`:73`) with `src/settings/settings.ts` and a regenerated `docs/settings.md`, `agents/agent/qa-reflector.md` (32) and its `agents/opencode.json` entry, the role in `qa-engine/src/shared-kernel/agent-role.ts`, `src/agent-runtime/types.ts`, `src/integrations/fixtures/opencode-roster.json`, the reflector port and adapter, the reflector arm of `src/server/run-engine-factory.ts:1466`, and the reflector case of the prompt guard `scripts/model-agnostic-prompts.test.ts` (`:624-648`, entry `:681`, the import at `:24`, the word in its header at `:1`) | An activation switch and an agent role leave: governance, alone. |
| L3 | The rule loop: the application, domain and infrastructure files above except the curriculum ones; `src/qa/learning/learning-rule.ts` (40), `ledger-cli.ts` (44), `ledger-report.ts` (133) and their tests; `scripts/learning-quarantine.ts` (95) with the `learning:quarantine` script and its frozen-list entry; the `rule-learning` preset of `scripts/mutate.ts` (`:108-119`; `scripts/mutate.test.ts:34-37` fails if a preset names a missing file); `showLearning` in `src/cli.ts` (`:336-404`); `historyLearningStore` (`src/server/run-engine-factory.ts:301-366`) and the `campaignFrozen` arm for the learning repository (`:1459`; the process-audit arm at `:1476` stays); the `learned-rules` prompt sections and `renderLearnedRules` (`qa-engine/src/contexts/generation/infrastructure/adapters/generation-turns.adapter.ts:156`; `qa-engine/src/contexts/generation/infrastructure/adapters/review-port.adapter.ts:87`); the rules and the scorecard writer of `src/server/persistence/repositories/learning.repository.ts` (345 lines; `run_outcomes` stays), and its `updateRunOutcomeReflection` (`:182`), whose only caller is the reflector arm L2 removes (`src/server/run-engine-factory.ts:1470`). The shell keeps its read of the scorecard, which the signals view still uses, until V1. | `AGENTS.md:539-558` (the learning policy) is rewritten to say what is left (the gates and the process audit) and that the rebuild is separate; `:463-464` and `:567` lose the reflector and rule wording. |
| L4 | The curriculum: `LEARN/domain/curriculum.ts`, `curriculum-model.ts`, the curriculum port and adapter, `src/qa/learning/curriculum.ts` (3), the exemplar selection (`qa-engine/src/contexts/run-orchestration/application/run-flow/phases/ground.steps.ts:72-80`) and the `skillExemplars` it feeds (`qa-engine/src/contexts/generation/infrastructure/adapters/generation-turns.adapter.ts:176`), the curriculum port wiring (`src/server/run-engine-factory.ts:1508`), the `--grounding stitcher\|curriculum` arm of `scripts/campaign.ts:216`, `:377` and `scripts/campaign-model.ts:190`, the telemetry registry entries. With Q5: `qa-engine/src/shared-kernel/scenario-catalog.ts` (127), `scenario-archetype.ts` (19), `structural-pattern.ts` (74), reached only through the curriculum port in the paths traced (`generator-sections.ts:4`, `:256-268`) (Correction 2026-10-29: not only; the run step `read-diff-shapes` also called the detector to fill the diff's shapes; L4 (`0989507c`) removed that step, its state and its outcome field together with the detector). | The lead prompt loses the exemplar section and the "PROVEN" statement. |

Also in D1 (L3 and L4, by what they touch): the kernel's `learned-rule.ts` (30); the learning parts of `src/server/chat.ts` and `src/server/help.ts`; `src/server/run-trace.ts:50`. Persisted leftovers stay: the tables `learning_rules`, `scorecard`, `curriculum` and the columns `run_outcomes.rules_retrieved` and `run_outcomes.reflection`; the history database carries a schema version, so a drop is a persisted-format decision (Q7). Fate of the stand-ins (Q4): `LearningPort`, `LearningPortAdapter`, `StubLearningRepository` and `LearningRepositoryPort` go with the rule loop (`LEARN/composition/build-cross-run-learning.ts:26` uses the stub only as the default repository of the port adapter); the builder stays until step 2 decides whether the gates and the process audit keep one.

#### D8: the code target (C1 to C3)

The file list is [ADR-0007](../adr/0007-code-target-removal.md), "What the removal deletes": the runner (609), strategy (37), setup (117), evidence (51), ecosystem, the Stryker adapter (284), the edits in about 84 files, the prompts, the surfaces and the image. This RFC adds the split and what it found.

| ID | What | Notes |
|---|---|---|
| C1 | The `code` value leaves the wire: `target` stays with one value (ADR-0007 point A), the app-config key `code` and the webhook `target` (`src/orchestrator/schemas.ts`), the CLI flags, the generated SDK and Go types. | Contract, alone. The owner's gitignored app file keeps `code: true` and has no `dev` block (ADR-0007): it stops validating. |
| C2 | Engine and shell removal, including `learning-gates.ts:20`, `:39` and `should-distill-learning.ts:4-5` (the `isCode` input), the `code-run-reads` preset (`scripts/mutate.ts:600-622`), the code-runner entries of the mutation tables, the protected-path entries already gone with D11. | `npm run sandbox:smoke`: the launcher profiles lose a caller. |
| C3 | `Dockerfile:30-70` candidates (JDK, Maven, Gradle, Rust, Go) and `config/egress/registries.yaml` entries. | Image change (high-risk item 5), own commit; whether the toolchains have another user is checked before removal (ADR-0007). |

AGENTS.md: `AGENTS.md:84`, `:133`, `:204-207`, `:346`, `:658-662` as the ADR table lists them.

#### D5: the response value oracle (V1 to V3 and VF)

[ADR-0004](../adr/0004-response-value-oracle-removal.md) leaves the file list to this RFC. The seven files below total 439 lines; `fault-injection-counter-reader.ts` (29), `bundle-mutation-oracle.adapter.ts` and the `_mutate` fixture stay (bundle mutation is [ADR-0006](../adr/0006-bundle-mutation-switch.md)). Of what ADR-0004 lists under "Goes", V1 takes the signals-view series, V2 the oracle, its aim, its calibration and the `faultInject` execution option, V3 the fixture, the allow-list and the anchors, and VF the value fields, the `mutation_value` grader and the class `E-VALUE-SURVIVED`. The oracle scorecard is cut in three places: its writer in L3, its readers in LC (the intelligence view) and V1 (the signals view); its table stays (Q7).

| ID | Removes | Notes |
|---|---|---|
| V1 | The `valueOracle` trend of the signals view (`src/contract/commands.ts:814`, `:916`; `src/server/signals-view.ts`, which derives it from the scorecard at `src/server/wire-app.ts:681`), the console tile that reads it (`web/public/js/console.js:412`), `src/qa/learning/oracle-types.ts` (47) and its test, and the shell's last read of the scorecard. | Contract, alone. Console and TUI read in a browser. |
| V2 | `qa-engine/src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts` (72), `qa-engine/src/contexts/run-orchestration/application/run-flow/fault-aim.ts` (56), `qa-engine/src/contexts/objective-signal/domain/fault-calibration.ts` (73), `scripts/fault-calibration.ts` (113) with the `fault-calibrate` script (`package.json:42`), `qa-engine/src/contexts/objective-signal/infrastructure/null-value-oracle.adapter.ts` (16), `qa-engine/src/contexts/objective-signal/application/ports/value-oracle.port.ts` (9), `qa-engine/src/contexts/objective-signal/domain/fault-injection-score.ts` (100; it also declares `CandidateValue`, `ValueStats`, `FaultAim` and `operationKey`, used by `qa-engine/src/contexts/objective-signal/domain/coverage-collector.ts`, `qa-engine/src/contexts/objective-signal/application/ports/objective-signal.port.ts` and `qa-engine/src/contexts/objective-signal/application/index.ts:29-32`, which move first and leave with VF). The `faultInject` and `faultOperations` execution options (`qa-engine/src/contexts/test-execution/domain/execution.ts:9-11`, `qa-engine/src/contexts/test-execution/domain/execution-strategy.ts:18-20`, `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:79-80`, `:161-162`, `:278-279`, `:911`, `:943`, `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.strategy.ts:14-15`, `:38-39`, `qa-engine/src/contexts/test-execution/infrastructure/adapters/execution-port.adapter.ts:51-52`), whose only caller is the oracle's re-run (`src/server/run-engine-factory.ts:979`); they go before V3 removes the allow-list entries they set. Consumers: `qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts:26`, `:169`, `qa-engine/src/contexts/objective-signal/composition/build-objective-signal.ts:11`, `src/server/engine-root.ts:67`, `:228`, `src/server/run-engine-factory.ts:95`, `:98`, `:649`, `:985-1005`; `faultAimOf` in `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts:5`, `:102` and `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts:4`, `:637`. Tests: `src/server/run-engine-factory.fault-injection.test.ts` (158), `scripts/fault-calibration.test.ts`; the `run-output-readers` preset of `scripts/mutate.ts` (`:510-538`) loses its oracle target and two tests and keeps the counter reader. | `qa.valueOracle` stays as the bundle-mutation switch until ADR-0006 decides its name. |
| V3 | The seed block in `config/e2e/fixtures.ts:264-322` and `:906-916`; the allow-list entry (`qa-engine/src/shared-infrastructure/process-sandbox/exec-env.ts:49`: `QA_FAULT_INJECT`, `QA_FAULT_INJECT_OPERATIONS`); the setup anchors (`qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts:62-64`, `:207`). | The anchors place the capture and mutation fixtures relative to the oracle's block and to the `_faultInject: void;` type line. Watched repositories already hold a copy of the seed with that block, so the new anchors must match both forms (with and without it). Sandbox allow-list: governance, `npm run sandbox:smoke`, `npm run seed:lint`. |
| VF | The five value fields leave the types, the persisted outcome and the wire, once V2 has removed their writers and L3 their readers: `valueScore`, `valueByCandidate`, `valueStats`, `mutantCount`, `killedCount`. **Engine:** the kernel outcome (`qa-engine/src/shared-kernel/run-outcome.ts:27-30`); the run flow's state and results (`qa-engine/src/contexts/run-orchestration/application/run-flow/run-state.ts:200-207`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts:128-132`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts:651-673`, `decided-end.ts:126`, `:270-273`, `:304`, `finalize-run.ts:278`, `:293`, `:314`, `outcome-assembly.ts:34-37`, `:85`, `run-types.ts:327`); `qa-engine/src/contexts/run-orchestration/infrastructure/run-pipeline.adapter.ts:41`; the objective-signal result (`qa-engine/src/contexts/objective-signal/application/ports/objective-signal.port.ts:41`, `qa-engine/src/contexts/objective-signal/domain/coverage-collector.ts:42-43`); the grader `mutation_value` (`qa-engine/src/contexts/evaluation/domain/graders.ts:114-121`) and its catalog entry (`qa-engine/src/contexts/evaluation/domain/grader-catalog.ts:60`) with the evidence it reads (`qa-engine/src/contexts/evaluation/domain/run-evaluation-evidence.ts:152-153`, `src/server/evaluation-evidence.ts:505-506`); the class `E-VALUE-SURVIVED` (`qa-engine/src/shared-kernel/error-class.ts:14`, the `valueScore` input at `:121`, the rule at `:159-162`). **Shell and wire:** `src/types.ts:164-168`, `:280`, `:282`; `src/server/trends-view.ts:30`; `src/server/run-report-view.ts:194`; `src/cli.ts:274`, `:345`, `:397-401`; `src/server/chat.ts:58`; `src/qa/value-report.ts:18`, `:169-171`; `web/public/js/console.js:552`, `:647`; the coordination event's `valueScore` (`src/contract/commands.ts:850`, `src/server/coordination-events.ts:96`, `qa-engine/src/contexts/coordination/application/coordination-telemetry.ts:81`; hypothesis: the same score sampled at outcome time); then `contract/openapi.json`, the generated SDK and Go types. The scorecard entries of `src/contract/commands.ts:763-767` leave with the intelligence view in LC. **Tests and docs:** `qa-engine/test/contexts/cross-run-learning/domain/learning-gates.test.ts:21` (kept in D1; its map over error classes loses the key) and `qa-engine/test/shared-kernel/error-class.classification.test.ts:143`; `docs/observability-design.md:944`, `:953`, `:1203`. A search at 4105c582 for these names, `mutation_value`, `E-VALUE-SURVIVED` and `faultInject` over `src`, `qa-engine/src`, `scripts`, `web/public`, `client`, `packages`, `contract` and `config` finds 59 files outside `*.test.ts` (some are deleted by V2, L3, LC and C2 before VF); the commit handles each that remains. | Contract, alone, and only after the owner answers [ADR-0004](../adr/0004-response-value-oracle-removal.md) point 1 ("Inherited, not repeated", below): the recommended answer is that the fields leave with the contract regenerated in the same step and old rows stay readable. If the answer is "stay as nulls", VF is not made. `GRADER_VERSION` (`grader-catalog.ts:16`, now `"3"`) stays: [ADR-0004](../adr/0004-response-value-oracle-removal.md) records that no `mutation_value` grade was ever stored in the history window, so no stored score changes meaning; `docs/observability-design.md:1192` is the rule that a changed meaning needs a new version. Hypothesis: scores stored before 2026-10-26 are not in the history database (ADR-0004), so the commit checks the stored scores before it keeps the version. |

AGENTS.md: `AGENTS.md:78` (the `fault-calibrate` command), `:850`, `:912`; `config/apps/example.yaml:149-158`.

#### Z: the stored run outcome

`toStoredRunOutcome` (`src/server/run-history-sqlite-adapter.ts:24-89`) copies the kernel outcome into the shell `RunOutcome` (`src/types.ts:153-297`) field by field: 11 top-level fields and 48 `gateSignals` fields, 42 of them behind a conditional spread (`:32-84`), into a second hand-written declaration of `gateSignals` (`src/types.ts:160-293`). The kernel keeps `errorClass` (a `string | null`, `qa-engine/src/shared-kernel/run-outcome.ts:14`), `usage` and `reflection` wide so that it does not import their types from `src/` or downstream contexts (`:1`), and the shell types them narrow, which costs three casts: `errorClass` (`run-history-sqlite-adapter.ts:32`), `usage` (`:53`) and `reflection` (`:86`).

Z replaces the shell declaration with the kernel type minus the five fields the projection drops by design (`Omit` of `note`, `cases`, `logs`, `diffArchetypes`, `adjudication`). With it go the field-by-field copy, the second `gateSignals` declaration and the mapping's parity tests (`src/server/seam-parity.contract.test.ts:66-193`; the `save()` forwarding test at `:194` stays). The three casts disappear as casts: where a reader needs the narrow `RunUsage`, error class or reflection shape, it narrows at that read, and the compiler lists those readers. The shell `StructuredReflection` (`src/types.ts:299`) is deleted in Z: its other users are the reflector's backfill that L2 removes (`src/server/run-engine-factory.ts:1470`) and `updateRunOutcomeReflection` that L3 removes (`src/server/persistence/repositories/learning.repository.ts:182`). `rulesRetrieved` and `reflection` stay in the type, because their columns stay (Q7). Correction 2026-10-30: L3 and L4 removed `rulesRetrieved` and `reflection` from the type and from the repository's read and write (`72d206a9`); only the columns stay in the schema (Q7), and no field of the type names them.

Z derives from the kernel type as VF leaves it: VF removes `valueScore`, `valueByCandidate`, `valueStats`, `mutantCount` and `killedCount`, and deriving before VF would be redone. Z changes no stored field. If the owner answers ADR-0004 point 1 with "stay as nulls" ("Inherited, not repeated"), VF is not made and the five fields stay in the derived type.

### Risks no test covers

| Risk | Where | How it is covered instead |
|---|---|---|
| Container boot after `boot-guard.mjs` goes: `Dockerfile:156` runs `npm run start` | M2 | `docker compose up --build` and a read of `/api/health` once before the commit lands |
| Three producers have no log today (probe counts, deep queue, orphaned-session sweep) | M1 | RED tests per trigger |
| Stored outcomes, evaluation scores and external clients that carry the removed value fields or the class `E-VALUE-SURVIVED` | VF | a history-reader test with a stored outcome that still carries them (Test plan); external clients are not checked |
| An embedded or spawned script looks unreachable to an import scan | A5, later deletions | name search for every file; the two audit false positives above |
| Mutation presets and recorded timings that name a deleted file | all | `scripts/mutate.test.ts:34-37` covers presets; the test runner ignores a `scripts/test-timings.json` entry for a deleted file, and the commit refreshes it |
| Watched repositories hold a copy of the seed fixtures | V3 | a test with both forms of the fixtures file; copies outside this repository are not checked |
| Toolchains in the image that something else uses | C3, Q11 | image build and one live run; operator runbooks outside the repository are not checked |
| Console and TUI views | LC, C1, V1 | Go tests cover the client; the console is read by hand and reported "NOT visually verified" if no browser read happens |
| External clients that send `grounding.curriculum` or `target: code` | LC, C1 | not checked |
| The owner's gitignored app file silently loses unknown keys | C1, LC | the schema is not strict for those keys; a missing `dev` fails loud (ADR-0007) |
| Orphan tables and columns | LC, L3 | they stay (Q7) |
| Host and remote state: the 18 maintainer pull requests, the `qayaba-self` directory, marker files in the data volume | M2 | the owner's explicit go; the prune removes the directory on its own once the exemption is gone (hypothesis, ADR-0010) |

### Where it lives

Steps 0 and 1 add no module. Every addition is a rule or a test in the gate: the predicate lives in `scripts/check-previous-forms.ts`, the ceiling in `qa-engine/test/arch/shell-public-surface.test.ts`, the child-process scope in `qa-engine/.dependency-cruiser.cjs`. They move with the roots at step 5, as the existing rules do. Nothing names an app, a model or a language outside the registry.

## Patches it supersedes

| Patch | Where | Replaced by |
|---|---|---|
| The reflector off by default, as a switch | `src/settings/registry.ts:74`, `src/server/reflector-switch.ts`, `AGENTS.md:544` ("The reflector is OFF by default") | Deleting the reflector (L2) |
| A no-op repository so the learning port always has one | `qa-engine/src/contexts/cross-run-learning/composition/build-cross-run-learning.ts:26` | Deleting the rule loop and its port (L3, Q4) |
| A null oracle so the value port always has one | `qa-engine/src/contexts/objective-signal/infrastructure/null-value-oracle.adapter.ts` | Deleting the port (V2) |
| The maintainer's auto-merge off by default | `src/settings/registry.ts:147` | Deleting the maintainer (M2) |
| Freeze arms that exist because the learning code could write during a campaign (`campaignFrozen` is defined at `:760`) | `src/server/run-engine-factory.ts:1459`, `:1466`, `:1508` | Deleting the code they guard (L2 to L4); the arm at `:1476` guards the process audit, which stays; the freeze itself moves to the server ([ADR-0009](../adr/0009-campaign-freeze-on-server.md)) |
| Two copies of one taxonomy kept in step by a parity test | `src/errors.ts`, `src/errors.test.ts:61-64` | A1 |
| A ceiling that leaves ten free slots | `qa-engine/test/arch/shell-public-surface.test.ts:17` | G2 |

## Test plan

Deleting code has no failing test of its own: a test cannot fail for the reason a deleted module existed. The compiler, the arch rules and the global search are the proof; behaviour that must survive is pinned before the deletion and passes before and after.

| Test | Through | Before the change | After |
|---|---|---|---|
| `isInfraError` is false for a generic `Error` and for non-Error throwables; a stalled agent is distinct from an unavailable one | the kernel's `isInfraError` and error classes, in `qa-engine/test/shared-kernel/domain-error.test.ts` | passes (moved from the shell) | passes |
| `realGit` wraps a failed git command in an `InfraError` and scrubs the credential | `src/integrations/repo-mirror.ts` exported `realGit`, in `src/integrations/repo-mirror.test.ts` | passes with the shell's class | passes with the kernel's |
| A module of `src/` that imports `child_process` fails the arch check, the three named sites and test files pass | a throwaway tree built under `os.tmpdir()` like `qa-engine/test/arch/shell-public-surface.test.ts` | RED: no rule covers `src/` | GREEN |
| After 3 failed probes, after 10, at a deep queue, and after a sweep that cleaned sessions, the health poller writes a log line (one test per trigger; the first two at level error) | `startHealthPoller` with fake dependencies (`src/server/health-poller.test.ts`) | RED | GREEN |
| The evaluation catalog lists no `mutation_value` and a regrade of a stored run emits none | `GRADER_CATALOG` and the grade-run use case (`qa-engine/src/contexts/evaluation/application/index.ts:27`, `grade-run.use-case.ts`) | RED: it is listed and emitted | GREEN |
| A stored outcome row that still carries `valueScore`, `valueByCandidate`, `valueStats`, `mutantCount`, `killedCount` and the class `E-VALUE-SURVIVED` is read with its other fields intact | the history repository's `listRunOutcomes` | passes | passes (pinned before VF, because ADR-0004 says old rows stay readable and marks it "not verified") |
| The seed upgrade places the capture and mutation fixtures in a fixtures file with the oracle block and in one without it | the setup adapter's public seam | passes for the first form only | passes for both |
| The ceiling equals the list length after each shrinking commit | `qa-engine/test/arch/shell-public-surface.test.ts:83-92` | existing | existing, constant lowered |
| The gate no longer reports a deleted path inside `docs/architecture/` and still reports a banned term there | `scripts/check-previous-forms.test.ts` (the pure `checkPreviousForms`) | RED | GREEN |

Each test asserts the observable effect of its rule and names the behaviour it checks (`AGENTS.md`, Testing standards). Existing behaviour the changed code shares is pinned by the tests that already exist; the differential check is the byte comparison of assembled prompts above.

## Measurement

| What | Before (4105c582) | Expected after step 1 | How it is read |
|---|---|---|---|
| Non-test files and lines in `src/` | 188; 29,735 | lower by the deleted shell files; each commit records its own count | `git ls-files` and `wc -l` at the commit, on the counting basis stated under Problem |
| Non-test files and lines in `qa-engine/src` | 738; 75,726 | lower by the learning, oracle, code-target and unreachable files | the same command and basis |
| Entries in the frozen shell-exceptions list | 47; ceiling 57 | 45; ceiling 45 | `qa-engine/.dependency-cruiser-shell-exceptions.json`; the constant |
| Tests | 12,282 (12,280 pass, 0 fail, 2 skipped) | fewer only by the tests of deleted code; none failing | `npm test` summary, listed per commit |
| Assembled prompts | the lead prompt carries the exemplar section and "PROVEN" | identical except for the sections L3 and L4 remove | the byte comparison |
| One live run after Z (Q10) | the one baseline replicate `run-ed28973-mvs7oo0f-17041c71`: pass, line coverage 0.630, 0 of 3 mutants killed | the process starts, runs and finalizes; verdict classes as before | a direction only: identical inputs spread widely (0.630 to 0.904 across the baseline replicate and cycle 3, [ADR-0003](../adr/0003-learning-layer-rebuild.md)), and the prompt difference above must be listed |

A single run neither confirms nor refutes this RFC: no run outcome is expected to change from steps 0 and 1 except through the prompt.

## Owner decisions needed

Each has a recommended answer. Q1 to Q15 are this RFC's; the ADR points inherited with their recommended answers are listed after.

| # | Question | Recommended |
|---|---|---|
| Q1 | How does the previous-forms gate treat `docs/architecture/`? (a) skip the folder entirely, as it skips `odd/`; (b) skip only path and citation checks and keep the banned-term rules, with the new retired-name rules not applying to the folder (the records name the retired names on purpose, [ADR-0004](../adr/0004-response-value-oracle-removal.md)). | (b), commit G1 alone (CI is high-risk item 5). It keeps the owner's banned terms working on the records. |
| Q2 | Lower the shell-exceptions ceiling to the 47 entries now and at each shrink? | Yes (G2). |
| Q3 | Apply the child-process rule to `src/` after D11, with three named sites? | Yes (M4), alone. |
| Q4 | Delete `LearningPort`, `LearningPortAdapter`, `StubLearningRepository` and `LearningRepositoryPort` with the rule loop? ([ADR-0003](../adr/0003-learning-layer-rebuild.md) leaves this to this RFC.) | Yes; keep the builder until step 2. |
| Q5 | Do the exemplar templates (`scenario-catalog.ts`, `scenario-archetype.ts`) and the keyword detector (`structural-pattern.ts`) go with the curriculum? | Yes (L4). (Correction 2026-10-29: the premise that only the curriculum reached the detector was incomplete; the run step `read-diff-shapes` also called the detector to fill the diff's shapes; L4 (`0989507c`) removed that step, its state and its outcome field together with the detector.) |
| Q6 | Remove the intelligence route and its surfaces, since D1 leaves the view with one field? | Yes (LC, contract commit). |
| Q7 | Do the orphan tables and columns (`learning_rules`, `scorecard`, `curriculum`, `run_outcomes.rules_retrieved`, `run_outcomes.reflection`) stay at step 1? | Yes: no persisted-format change in step 1. |
| Q8 | How is the D2 reset applied? | The owner authorizes the exact statement at that time; a copy of the history file is taken first; the row is read before and after and recorded; applied before LC. It is hygiene, since nothing reads the row after L4. |
| Q9 | Approve the order D11, D1 with D2, D8, D5 (it differs from the audit's list)? | Yes. |
| Q10 | Is the live run after Z the after-measurement of [ADR-0011](../adr/0011-root-cause-fix-policy.md), under its measurement conditions? That ADR left the replicate count of the after-measurements undecided (Correction 2026-10-29: decided as recommended in ADR-0013, one per version). | Yes, one replicate, launched on the owner's go. |
| Q11 | Remove `lizard`, `difft` and `ast-grep` from the image (`Dockerfile:72-87`)? No code in `qa-engine/src`, `src`, `scripts`, `agents` or `bin` runs them (the only user was the extractor ports A5 deletes). [ADR-0007](../adr/0007-code-target-removal.md) says `pip3` stays for `lizard`; `python3` and `build-essential` stay for the native build either way. | Yes after the owner confirms no operator runbook uses them; own commit after C3, image rebuilt. One commit more. |
| Q12 | Where do the audit's other discards fall ([RFC-0001](./0001-dormant-features.md))? Also the candidates the inventory found: `src/server/metrics.ts` (hypothesis: nothing reads the gauge), and the fate of `scripts/baseline-agent.ts` (it keeps three `repo-mirror.ts` functions alive). | After Z, each in its own commit gated by its own answer, except OD-14, which goes first if accepted (see the note under the commit table). |
| Q13 | Leave `src/util/sleep.ts` to step 3, and derive the stored run outcome last (Z)? | Yes to both. |
| Q14 | Step 0 content: the table lives in `AGENTS.md` only, with the plan document pointing to it; a one-line pointer to [ADR-0001](../adr/0001-design-pillars.md); the test-support sentence. | Yes to all three. |
| Q15 | Record the three proposed owners (operator assistant as a new context, `test-execution` for egress origins, `run-orchestration` for the context-map rule) in the inventory only, and decide them at step 2? | Yes; step 1 creates no context. |

**Inherited, not repeated.** [ADR-0004](../adr/0004-response-value-oracle-removal.md) point 1 (do `valueScore`, `valueByCandidate`, `valueStats`, `mutantCount`, `killedCount` and the oracle series leave the persisted and wire contract in step 1, or stay as nulls?; recommended: they leave, the contract regenerated in the same step and old rows still readable, which is commit VF; a "stay as nulls" answer drops VF and keeps the fields in the type Z derives; point 2 of that ADR, the definition of "service-triggered runs work", concerns a later review and not step 1); [ADR-0007](../adr/0007-code-target-removal.md) points A (keep `target` with one value), B (the owner's configuration) and D (the definition of a stable E2E MVP); [ADR-0010](../adr/0010-maintainer-removal.md) points A (store and routes leave), B (branch-protection script stays), C (closing the pull requests is an explicit go) and D (same as Q1). Each is taken at its ADR's recommended answer unless the owner says otherwise.

## Out of scope

- Moving any module, renaming the roots, or splitting the 33 modules (steps 2 to 6).
- Rebuilding the learning layer, or any lesson kind ([ADR-0003](../adr/0003-learning-layer-rebuild.md)).
- The coverage and bundle-mutation switches ([ADR-0005](../adr/0005-coverage-enforce-activation.md), [ADR-0006](../adr/0006-bundle-mutation-switch.md)) and the fixes of RFC-0003, RFC-0004 and RFC-0005.
- The 17 members of [RFC-0001](./0001-dormant-features.md) with no decision, except where Q12 slots them.
- Host and remote state: the maintainer's pull requests and branches, the `qayaba-self` directory, data-volume marker files, branch-protection settings.
- The owner's gitignored configuration, and any edit of `docs/architecture-remediation.md`, which the index decides ([README](../README.md)).
