# ADR-0001: Design pillars

- Status: Accepted, 2026-10-28, owner, for the pillars (the owner's quoted words). Accepted as proposed on 2026-10-28 ([ADR-0013](0013-owner-decisions-remaining-questions.md)): the numbering P1-P7, the review questions, the review procedure and the recommended answers to the Open questions.
- Decision source: no D#. The pillars are the owner's own statements of 2026-10-28 13:36Z, quoted below (translated).
- Code references at 4105c582:
  - `AGENTS.md:3-22` (golden rule: project-agnostic, model-agnostic, root-cause fixes)
  - `qa-engine/src/shared-kernel/language-id.ts:1-2` (the language registry and the declared scope)
  - `qa-engine/src/shared-kernel/diff-stat.ts:39-44`, `:50-53`, `:55-60` (size tiers)
  - `qa-engine/src/contexts/run-orchestration/domain/run-time-budget.ts:13-22`, `:37-41`, `:52-56` (run time by tier)
  - `docs/engine-platform-architecture.md:67-68` (the line the platform plan draws)
- Related: [ADR-0002](0002-architecture-direction.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md), [README](../README.md)

**In short:** seven pillars, taken from the owner's own words, are the criteria for every design in this repository. The split into P1-P7, the question a review may ask of each, and how an RFC answers it are the assistant's proposal; the owner accepted them as proposed on 2026-10-28 ([ADR-0013](0013-owner-decisions-remaining-questions.md)).

## Context

The root-cause investigation of the runs of 2026-10-26 to 2026-10-28 ended in designs. A design needs criteria that do not change with the fix at hand. The owner stated them during the architecture debate of 2026-10-28. This record fixes them in the repository so that no RFC, fix or session has to rediscover them.

`AGENTS.md:3-22` already holds two of them for fixes (P4 and P5). The pillars extend all seven to designs.

## Decision

All quotes are the owner's words of 2026-10-28 13:36Z, translated from Spanish.

**What is the owner's and what is not.** The owner stated the criteria: the quotes in the third column. The assistant proposes, and the owner has not approved, three things: the split of those words into seven numbered pillars and their names, the fourth column (a question a review may ask), and the review procedure under the table. (Correction 2026-10-30: the owner accepted all three as proposed on 2026-10-28, [ADR-0013](0013-owner-decisions-remaining-questions.md), as the Status line says; the sentence above describes the record as written.)

| # | Pillar | The owner's words (translated) | A question a review may ask of an RFC (proposed) |
|---|---|---|---|
| P1 | Determinism with flexibility | "A fundamental pillar of qayaba is flexibility with determinism, which is very hard to achieve." "A good architecture is rigid at the base and flexible at the edges." "The goal is that, for several identical executions, qayaba behaves in a similar, predictable and stable way, delivering quality results." | Do identical inputs keep behaving alike after this change? Which part is the rigid base, and which edge stays flexible? |
| P2 | A boundary between the engine and the AI, drawn by rules | "If it is too deterministic in trying to process every event and every aspect, it can end up failing when new code is tested, because it had no way to assimilate a new pattern or a new obstacle that appeared. If the AI is given too much responsibility, the app becomes unpredictable, with different ways of acting in each identical execution. The ideal is to delimit the boundary well with established rules: what responsibility each part has." | Which side decides this, and which written rule says so? Could the engine decide it from facts it already holds, or does the agent judge with facts the engine hands it? |
| P3 | Adapt from signals, never from size thresholds | "These adaptations must not be done with the approach 'if lines of code > X path A, else path B', because that is fragile. The decisions about how qayaba adapts to each execution must be based on signals that we configure to read important values of the flow under test. Because if we try to cover every variant by hand we never finish." The owner's examples: days with no restaurants because DEV resets them daily, and routes reachable only from mobile that were flagged as navigation errors. | Does any branch compare a size or a count with a constant? Which signal does the adaptation read, who produces it, and what happens when the signal is absent? |
| P4 | App-agnostic through ports | "Qayaba is an E2E testing engine agnostic to the app it tests; since there are too many frameworks and languages, it was decided mainly to create it for JavaScript with the Angular framework and for Java with Spring, with HTTP connections and events between microservices. But these are implementations of their corresponding ports, which lets qayaba be scalable and flexible. Its focus is purely web apps, so assuming that the frontend is always JavaScript or TypeScript is correct; the flexibility is in the frameworks." | Behind which port does this sit? Would it fire the same way on another app, framework or backend, with no name, route, text or data shape of one app in the code? |
| P5 | Fix the mechanism, not the symptom of the app under test | "All the latest executions have been made on the same code fragments of the same app; this can create a bias, because the errors show up in a certain way conditioned by what they test. If all the fixes we plan are designed to fix only those symptoms, what will happen is that when running qayaba against a new app, it will start failing constantly again." | What evidence beyond the tested fragments, or what argument from the code, shows the mechanism is not shaped by them? How would it show on a different app? |
| P6 | Test quality is the product | "We have not yet gone into the quality of the tests that qayaba generates. The app is a QA tester; if its priority is to make green tests, it becomes a garbage generator. The architecture has to focus on tests being generated with quality and testing real flows, forcing neither the FAIL nor the PASS state." | Can this change make a weak test pass or a sound test fail? Which objective signal (killed mutants, changed lines covered on the final bytes, defects found) shows the suite got better and not only greener? |
| P7 | No pattern for its own sake | "Regarding the Command pattern, if it brings no real value, do not do it. In general it is not about applying patterns just because; each decision must be grounded, and any added complexity, logical or cognitive, must be justified." | Which failure family (run ids, hypothesis) does the structure remove? What complexity does it add, and is there a smaller change that removes the same cause? What returns if it is deleted? |

Proposed use in a review (not owner-approved): (Correction 2026-10-30: approved as proposed, [ADR-0013](0013-owner-decisions-remaining-questions.md), 2026-10-28.)

1. A review may ask the questions above. The RFC would answer them as a checklist inside its Recommendation, one line each, with evidence (a run id, a `path:line`, a number) or "not affected" (Open question 1).
2. A pillar the RFC cannot answer is named under "Owner decisions needed".
3. An answer that rests on one run, or on the app under test alone, does not count (P5).

## Consequences

- A review may ask the seven questions of an RFC or a fix design. Whether an RFC must carry the answers is Open question 1.
- The pillars are criteria, not facts about the code. The two deviations located in code at 4105c582 are P3 and P2. Outcome-level deviations from P1 (same input, different results) and P6 (a pass with 0 of 3 mutants killed) are in the run evidence, cited by run id in the rows below. No total is stated: the rows are the deviations known when this record was written, listed so a review does not rediscover them. This record does not decide what to do about them.

| Pillar | Deviation observed | Decided? |
|---|---|---|
| P3 | A change is sorted into tiers by counting files and changed lines against constants: `DIFF_TIERS` (`diff-stat.ts:41-44`, applied by `diffTier` at `:50-53`). The tier then sets the first-pass wall time (`:55-60`) and the run's time (`run-time-budget.ts:37-41`, `:52-56`). The source states its own limit: "the tiers count raw files and changed lines, so generated files and lockfiles inflate a tier and a one-line change can have a wide blast radius" (`diff-stat.ts:40`). In code at 4105c582. | No. Open question 3. |
| P2 | No written table says, decision by decision, whether the engine, the agent with facts, or a signal decides. The platform plan draws a different line, between engine code and platform code: "the line between them is ownership, not behaviour" (`docs/engine-platform-architecture.md:67-68`). In code at 4105c582. | No. See ADR-0002, Open questions. |
| P1 | Identical input, different results. Cycle 3 ran the same app commit (`ed289735`) three times on engine commit 40513c1e, an ancestor of 4105c582 (11 commits earlier): run-ed28973-mvs0onsn-6ad17f30 ended `flaky` (line coverage 0.766, 0 of 3 mutants killed), run-ed28973-mvs2ukug-c82da7be `pass` (0.904, 1 of 3), run-ed28973-mvs49h5y-acdab309 `pass` with error class `E-FALSE-POSITIVE` (0.738, 1 of 3). Three runs of one app show a direction, not proof (P5). | No. No cause is attributed here. |
| P6 | A run can end `pass` while no test of the suite is shown to fail when the changed code is broken. Run run-ed28973-mvs7oo0f-17041c71, engine 4105c582: `pass`, shadow-mode decision "would: pr", review approved, line coverage 0.630, bundle mutation 3 applied and 0 killed. Hypothesis: three mutants of one run are a small sample, so this is a signal to watch, not a measure. | No. No cause is attributed here. |

- One owner statement is not recorded as a pillar. On 2026-10-28 14:14Z the owner said: "The problem was that at the start, instead of deciding on an MVP and making it work, I kept adding features on top of features in an app that did not work" (translated). It underlies the decisions on the learning layer and the dormant features (ADR-0003, RFC-0001). Whether it is an eighth pillar: Open question 2.

## Enforcement

Held by review, not by a gate: no test can judge these questions.

| Pillar | Mechanical holder today | Gap |
|---|---|---|
| P1, P2, P3, P6, P7 | none | Not enforced yet. |
| P4 | The rule text in `AGENTS.md:3-22`. The declared scope lives in one registry (`language-id.ts:2`). A search for the tested app's name over `src`, `qa-engine/src` and `agents`, tests excluded, finds 0 files at 4105c582. | No test or gate runs that search, and it covers the name only, not app-shaped logic. |
| P5 | The rule text in `AGENTS.md:10-13`. | Review only. |

Platform step 0 (RFC-0002) puts rules into `AGENTS.md`. Whether it also points to this record: Open question 4.

## Alternatives considered

- **Keep the pillars in the assistant's per-user memory only.** Rejected: memory notes belong to one user and one session, and a reviewer of an RFC cannot see them.
- **Fold the pillars into `AGENTS.md` only.** Not chosen: `AGENTS.md` holds rules and invariants for code, and a pillar needs its quote, its date and its review question. This record is the source, and `AGENTS.md` can point to it.
- **State the pillars as measurable thresholds.** Rejected by P3 itself.

## Open questions

Decided 2026-10-28: each recommended answer below is accepted ([ADR-0013](0013-owner-decisions-remaining-questions.md)).

1. **Must an RFC carry an answer to the seven questions?** The numbering, the questions and the procedure are the assistant's proposal. A: no checklist, the pillars stay a reference a reviewer reads. B: a checklist inside the existing Recommendation section, one line per pillar with evidence or "not affected". C: a separate section in every RFC, which changes the fixed RFC template. Recommended: B. Cost: one more block to keep honest in every RFC; a line that only says "not affected" must still be checked by the reviewer.
2. **Is the MVP-restraint statement of 14:14Z an eighth pillar?** Recommended: no. P7 already asks that added complexity be justified, and the statement is the basis of ADR-0003 and RFC-0001 as it stands. Revisit if the owner wants it to bind every new feature explicitly.
3. **What replaces the tier thresholds (`DIFF_TIERS`, `diff-stat.ts:41-44`) under P3?** To be settled in an RFC, not here. Recommended: an RFC after the three family slices that names, for each consumer of the tier (the first-pass time and the run's time), the signal it reads and what happens when the signal is absent.
4. **Does `AGENTS.md` point to this record?** Recommended: yes, one line among the rules that platform step 0 writes (RFC-0002), so a session meets the pillars where it meets the rules.
