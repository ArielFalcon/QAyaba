# Architecture records

Decision records of the root-cause investigation of qayaba (runs of 2026-10-26 to 2026-10-28). An RFC proposes, the owner decides, an ADR records what the owner decided. Every code reference is pinned to commit 4105c582 (Correction 2026-10-30: a record written after that commit pins its own, and its header says which: RFC-0011 and ADR-0014 pin f8d25c3e and e844d7f9, ADR-0015 pins 17bb77c1).

## Quick path

1. Read [ADR-0001](adr/0001-design-pillars.md) (the criteria every design is judged by) and [ADR-0002](adr/0002-architecture-direction.md) (the direction and the work order).
2. Find a decision in the [index](#index). Each ADR gives the owner's words (translated) as its basis.
3. Find what the owner still has to decide in [Where the owner's questions are](#where-the-owners-questions-are).
4. Check a claim: open the cited file at the pinned commit with `git show 4105c582:<path>`.

## Process

| Status | Applies to | Meaning |
|---|---|---|
| Proposed | RFC | Options with tradeoffs and one recommendation. The owner has decided nothing in it. |
| Partially decided | RFC | The owner decided some forks. The status links the ADRs that record them; the rest stay under "Owner decisions needed". |
| Accepted | ADR; RFC with every fork decided | Records what the owner decided. Points an ADR lists under "Not decided here" or "Open questions" are not part of the acceptance. |
| Superseded | ADR or RFC | A later record replaced it. The status names the replacement; the text stays as it was. |
| Rejected | RFC | The owner declined the proposal. The text stays so it is not proposed again. |

No record is Superseded or Rejected yet.

Rules:

- An ADR records only what the owner decided, with the owner's words as its basis. Anything the assistant added is labelled as a reading, a hypothesis or a recommendation.
- An RFC never presents an undecided choice as decided. Every fork is listed under "Owner decisions needed", one line each, with the recommended answer.
- When the owner decides a fork, the decision is written in an ADR and the RFC status changes. The RFC keeps its options as they were.
- Work stops at a product or architecture decision until the owner answers ([ADR-0011](adr/0011-root-cause-fix-policy.md), rule 6).

## Numbering and files

- Ids are `ADR-NNNN` and `RFC-NNNN`, four digits, assigned in order within each kind and never reused or renumbered. Files are `adr/NNNN-slug.md` and `rfc/NNNN-slug.md`; links between records are relative.
- [Rejected explanations](rejected-explanations.md) is one page with no number.
- Ids that are not record ids:
  - `D1` to `D14`: the owner's decisions of 2026-10-28. They are the decision source of the ADRs ([RFC-0001](rfc/0001-dormant-features.md), "Decisions already taken", maps each to its ADR).
  - `H01` to `H27`: the investigation's hypotheses. Three are confirmed (H06, H11, H20), 17 plausible, 7 refuted ([ADR-0002](adr/0002-architecture-direction.md) lists all 27).
  - `run-...` ids, `#n` run numbers and `O0b` to `O16` epochs: defined in the run index of [Rejected explanations](rejected-explanations.md#run-index) (Correction 2026-10-30: O12 to O16 are the root-cause branch's, in the second table of that index, which also records the break of RFC-0009 F6).
- Owner questions are numbered inside each record, so quote the record with the number (for example "RFC-0004 F1").

## The two templates

ADR:

```
# ADR-NNNN: <title>

- Status: Accepted, 2026-10-28, owner
- Decision source: D# and the owner's words (translated)
- Code references at 4105c582: ...
- Related: ...

## Context
## Decision
## Consequences
## Enforcement      (the test, architecture rule or gate that will hold it, and the step that adds it; "not enforced yet" when none)
## Alternatives considered
```

RFC:

```
# RFC-NNNN: <title>

- Status: Proposed, 2026-10-28 (or Partially decided, with ADR links)
- Code references at 4105c582: ...
- Related: ...

## Summary                 (at most 5 lines)
## Problem                 (the causal chain at path:line, the runs, what it does not explain)
## Goals and non-goals
## Options                 (each: what it removes, the complexity it adds, its risk)
## Recommendation          (why it is the smallest change, why it is app-agnostic, where it lives)
## Patches it supersedes   (path:line of what the fix removes)
## Test plan               (the RED test through a public seam)
## Measurement             (the signal that shows the cause gone, before and after)
## Owner decisions needed  (one line each, with the recommended answer)
## Out of scope
```

Some ADRs add an "Open questions" section after "Alternatives considered"; others keep a "Not decided here" list inside "Decision" or "Consequences". The RFC sections are all present in every RFC.

## How records cite code

- The header line "Code references at 4105c582" pins the commit: the head of main when the records were written. A line number is valid at that commit only. A claim about older engine code names its commit and is read with `git show <commit>:<path>`.
- A claim carries its evidence: a run id, a `path:line`, a number or a quoted source. A conclusion is labelled "confirmed" or "hypothesis". A cause is never generalised from one run, and a run is read in the code epoch it ran in ([ADR-0011](adr/0011-root-cause-fix-policy.md), rule 7).
- The owner's words are given as a translation marked "(translated)", with the date. The owner is named by role only.
- No record holds an absolute path of a machine, a scratch path or a secret. The product is called qayaba.
- `npm run previous-forms:check` scans the records for banned terms, dead paths and dead `file:line` citations. It checks that a full path exists. It checks that a line is inside the file only for a bare file name with one match ([ADR-0011](adr/0011-root-cause-fix-policy.md), Enforcement, row 7). Correction 2026-10-30: since `a4cde318` (RFC-0002 Q1, option B of open question 1 below) the gate skips the path and citation checks for `docs/architecture/` and keeps its banned-term rules, with the retired-name rules exempting the folder one by one (`exemptPrefixes`); so a record's citation of a deleted file is expected and the gate no longer checks it. The correctness of a citation is checked once, against the pinned commit, when a record is written or reviewed.

## Where rejected explanations live

[Rejected explanations](rejected-explanations.md) holds the refuted hypotheses (H03, H05, H10, H13, H14, H26, H27, then N03, N07, Q02, Q03, Q05, Q06, Q07): the claim, why it failed, what it never explained, and the narrower mechanism the refuters found. A narrower mechanism is a new hypothesis. It is refuted again before any fix ([ADR-0011](adr/0011-root-cause-fix-policy.md), rule 1). A refuted hypothesis gets an entry there, not an RFC. A proposal the owner declines gets the status Rejected.

## Index

Decisions (ADR):

| Id | Title | Status | Decision or hypothesis |
|---|---|---|---|
| [ADR-0001](adr/0001-design-pillars.md) | Design pillars | Accepted; the P1-P7 numbering, the review questions, the review procedure and the open questions as proposed (ADR-0013) | The owner's statements of 2026-10-28 13:36Z; no D# |
| [ADR-0002](adr/0002-architecture-direction.md) | Architecture direction | Accepted; which additions are scheduled, Decision 5 and the open questions as recommended (ADR-0013) | Owner, 13:08Z, 13:36Z, 13:58Z, 15:04Z; D12 cited by analogy |
| [ADR-0003](adr/0003-learning-layer-rebuild.md) | Learning layer: delete and rebuild one lesson kind | Accepted | D1, D2, D3, D4, D14 |
| [ADR-0004](adr/0004-response-value-oracle-removal.md) | Remove the response value oracle | Accepted | D5 |
| [ADR-0005](adr/0005-coverage-enforce-activation.md) | When change coverage moves to enforce | Accepted | D6 |
| [ADR-0006](adr/0006-bundle-mutation-switch.md) | Bundle mutation gets its own switch | Accepted | D7 |
| [ADR-0007](adr/0007-code-target-removal.md) | Remove the code target | Accepted | D8 |
| [ADR-0008](adr/0008-product-version-source.md) | The served version comes from the product | Accepted | D9 |
| [ADR-0009](adr/0009-campaign-freeze-on-server.md) | The server freezes campaign runs | Accepted | D10 |
| [ADR-0010](adr/0010-maintainer-removal.md) | Remove the self-maintainer | Accepted | D11 |
| [ADR-0011](adr/0011-root-cause-fix-policy.md) | Root-cause fix policy and measurement conditions | Accepted | D12, D13 |
| [ADR-0012](adr/0012-owner-decisions-rfc-0002-0010.md) | Owner decisions on RFC-0002 to RFC-0010 | Accepted | The 60 open questions of RFC-0002 to RFC-0010 (Correction 2026-10-29: this index said 56) |
| [ADR-0013](adr/0013-owner-decisions-remaining-questions.md) | Owner decisions on the remaining open questions | Accepted | RFC-0001 OD-1 to OD-20, the open points of ADR-0001 to ADR-0011, the README's open questions |
| [ADR-0014](adr/0014-owner-decisions-rfc-0011.md) | Owner decisions on RFC-0011 | Accepted | RFC-0011 Q1 to Q8 |
| [ADR-0015](adr/0015-owner-decisions-2026-10-30.md) | Owner decisions of 2026-10-30: forbid `test.skip`, and decide without asking | Accepted | The owner's answers of 2026-10-30 (feature document L26) and the rules taken under them |
| [ADR-0016](adr/0016-refactor-review-base-causes.md) | The refactor review's base causes, one task each | Accepted | The refactor review of 2026-10-30 (feature document L31) and the owner's rules of L30 |
| [ADR-0017](adr/0017-time-authority-answers.md) | RFC-0012's answers: one time authority | Accepted | RFC-0012's questions, under ADR-0015 point 2 |
| [ADR-0018](adr/0018-owner-decisions-rfc-0013.md) | RFC-0013's answers: the learning slice | Accepted | RFC-0013's questions, under ADR-0015 point 2 |
| [ADR-0019](adr/0019-owner-decisions-rfc-0014.md) | RFC-0014's answers: the signal that replaces the diff tiers | Accepted | RFC-0014's questions, under ADR-0015 point 2 |
| [ADR-0020](adr/0020-owner-decisions-platform-steps-2-6.md) | Decisions left open for platform steps 2-6 | Accepted | T13's mapping, under ADR-0015 point 2 |
| [ADR-0021](adr/0021-owner-decisions-platform-step-3.md) | Decisions left open for platform step 3 | Accepted | T13 U5's mapping, under ADR-0015 point 2; amends ADR-0020 row 2 |
| [ADR-0022](adr/0022-owner-decisions-platform-step-4.md) | Decisions left open for platform step 4 | Accepted | T13 U6's mapping, under ADR-0015 point 2; carries out ADR-0020 row 1 and OD-16 |
| [ADR-0023](adr/0023-owner-decisions-rfc-0015.md) | RFC-0015's answers: one execution contract | Accepted | RFC-0015's questions, under ADR-0015 point 2 |
| [ADR-0024](adr/0024-shell-exceptions-list-stays-frozen.md) | The shell exceptions list stays frozen at 27 | Accepted | Platform step 6's first bullet, under ADR-0015 point 2; amends the migration plan |
| [ADR-0025](adr/0025-delivered-specs-do-not-intercept-requests.md) | Delivered specs do not intercept requests | Accepted | The owner, 2026-11-01: "Qayaba no debe poder hacer stubs, eso tapa errores." |
| [ADR-0026](adr/0026-arm-decline-under-the-root-cause-mandate.md) | The branch gap's arm decline, chosen under the owner's mandate to fix the mechanisms at root | Accepted by the parent orchestrator; open to the owner's revision | The owner, 2026-11-01: "se deben tratar los mecanismos que causan el error de forma transversal y corregirlo de raiz" (feature document `odd/tasks/branch-gap-mechanisms.md`, S1); the decline itself was not requested in those words |
| [ADR-0027](adr/0027-agent-runtime-choice-is-a-setting.md) | The agent runtime is a setting, and the removed mode machinery stays retired | Accepted; the design's forks are RFC-0020's | The owner, 2026-11-01: "solo la opcion de elegir entre opencode o codex para ejecutar qayaba", under "hexagonal architecture and DDD" and "no duplicate logic or responsibilities" |
| [ADR-0028](adr/0028-rfc-0020-answers.md) | RFC-0020's answers: the second runtime's five forks, and the layering rule | Accepted | The owner, 2026-11-01: "aplica las recomendaciones de q1-q5" and "el codigo solo debe acoplarse a las implementaciones en las capas de infraestructura, las otras capas son agnosticas al runtime" |

Proposals (RFC):

| Id | Title | Status | Decision or hypothesis |
|---|---|---|---|
| [RFC-0001](rfc/0001-dormant-features.md) | Dormant features: keep, redesign or delete | Accepted: D1-D14 recorded in ADR-0003 to ADR-0011; OD-1 to OD-20 (ADR-0013) | The audit of 46 dormant members; D1-D14 |
| [RFC-0002](rfc/0002-platform-steps-0-1.md) | Platform steps 0-1: encode the target, delete what is dead | Accepted (ADR-0012) | The work order (ADR-0002); D1, D2, D5, D8, D11 |
| [RFC-0003](rfc/0003-coverage-dump-harvest.md) | Harvest coverage dumps off the event loop (H06) | Accepted (ADR-0012) | H06, confirmed |
| [RFC-0004](rfc/0004-log-level-from-outcome.md) | Derive the log level from the typed outcome (H11) | Accepted (ADR-0012) | H11, confirmed (narrow form) |
| [RFC-0005](rfc/0005-suite-store-single-writer.md) | One writer for the suite store (H20) | Accepted (ADR-0012) | H20, confirmed (narrowed form) |
| [RFC-0006](rfc/0006-review-answer-crosses-whole.md) | The reviewer's answer crosses to the decision whole (N02) | Accepted (ADR-0012) | N02, confirmed (phase 3b) |
| [RFC-0007](rfc/0007-dev-write-attribution.md) | Charge a DEV write only with evidence the spec caused it (N04) | Accepted (ADR-0012) | N04, confirmed (phase 3b) |
| [RFC-0008](rfc/0008-acceptance-records-what-it-ran.md) | A regeneration's acceptance records what it ran (N06) | Accepted (ADR-0012) | N06, confirmed (phase 3b) |
| [RFC-0009](rfc/0009-pack-record-matches-prompt.md) | The Context Pack's id record lists what the prompt prints (N09) | Accepted (ADR-0012) | N09, confirmed (phase 3b) |
| [RFC-0010](rfc/0010-tool-call-record-outcome.md) | Derive a tool call's record from its outcome (N12) | Accepted (ADR-0012) | N12, confirmed (phase 3b) |
| [RFC-0011](rfc/0011-multi-hop-cross-repo-impact.md) | Multi-hop cross-repository impact | Accepted (ADR-0014) | Owner's observation of 2026-10-30 (feature document L21), confirmed by reading |
| [RFC-0012](rfc/0012-one-time-authority.md) | One time authority for a run | Accepted | ADR-0016 R2, ADR-0002 addition 7 (T33) |
| [RFC-0013](rfc/0013-learning-slice.md) | The learning slice: one lesson kind, a server-side freeze, a kill criterion | Accepted | ADR-0003 D1-D4 and D14, ADR-0009 D10 (T20) |
| [RFC-0014](rfc/0014-diff-tier-signal.md) | The signal that replaces the diff tiers | Accepted | ADR-0001 open question 3 (T22) |
| [RFC-0015](rfc/0015-verdict-from-uninstrumented-execution.md) | One execution contract; the verdict never comes from an instrumented execution | Accepted (ADR-0023) | T40 (feature document L73-L75), implemented as T41 |
| [RFC-0016](rfc/0016-context-map-precondition.md) | The context map is a precondition of a run; incremental, framework-free rebuild | Proposed | T44, T45 (feature document L83, L85) |
| [RFC-0017](rfc/0017-defects-from-verified-facts.md) | A defect is a verified fact, not the shape of a failing test | Proposed (implemented under ADR-0015 point 2) | The owner's questions of 2026-11-01 (feature document `odd/tasks/no-stubs-fact-based-defects.md`, L2) |
| [RFC-0019](rfc/0019-arm-decline-by-basis.md) | An arm no test can take leaves the regeneration by a decline the engine checks | Accepted by the parent orchestrator (ADR-0026); open to the owner's revision | The branch gap review (feature document `odd/tasks/branch-gap-mechanisms.md`, S7) |
| [RFC-0020](rfc/0020-second-agent-runtime-beside-opencode.md) | A second agent runtime, chosen by configuration, beside OpenCode | Accepted (ADR-0028); the scope is ADR-0027's | The owner's request of 2026-11-01 (ADR-0027) |

Other:

| Page | What it holds | Hypotheses |
|---|---|---|
| [Rejected explanations](rejected-explanations.md) | The refuted hypotheses and the run index | H03, H05, H10, H13, H14, H26, H27; later N03, N07, Q02, Q03, Q05, Q06, Q07 |

These tables list every record through ADR-0028 and RFC-0020, except RFC-0018 (not indexed yet) (Correction 2026-10-31: this sentence said ADR-0017 and RFC-0012 while the tables already held ADR-0022 and RFC-0014; ADR-0023, ADR-0024 and RFC-0015 were missing); a later record is added to its table by the change that adds it.

Documents outside this folder that the records build on:

| Document | Role |
|---|---|
| `docs/engine-platform-architecture.md` | The plan adopted as the base ([ADR-0002](adr/0002-architecture-direction.md), Decision 1): dependency rule, placement rule, migration steps 0-6. |
| `docs/architecture-remediation.md` | The review and remediation plan of 2026-10-25. Its run state machine (P2) and hexagonal re-cut (P3) were finished before the first run ([ADR-0002](adr/0002-architecture-direction.md), Context). No record edits it. See open question 3. |

## Where the owner's questions are

| Record | Section | Numbering |
|---|---|---|
| ADR-0001, ADR-0002 | Open questions | 1, 2, 3, ... (decided: ADR-0013) |
| ADR-0003, ADR-0008, ADR-0009, ADR-0011 | Not decided here | bullets (decided: ADR-0013) |
| ADR-0004, ADR-0005, ADR-0006 | Not decided here | 1, 2, ... (decided: ADR-0013) |
| ADR-0007, ADR-0010 | Not decided here | points A, B, C, D (decided: ADR-0013) |
| RFC-0001 | Owner decisions needed | OD-1 to OD-20 (decided: ADR-0013) |
| RFC-0002 | Owner decisions needed | Q1 to Q15, then the points inherited from the ADRs (decided: ADR-0012) |
| RFC-0003 | Owner decisions needed | 1 to 5 (decided: ADR-0012) |
| RFC-0004, RFC-0005 | Owner decisions needed | F1 to F5 in each (decided: ADR-0012) |
| RFC-0006 to RFC-0010 | Owner decisions needed | F1, N1, ... in each (decided: ADR-0012) |
| RFC-0020 | Owner decisions needed | Q1 to Q5 (decided: ADR-0028) |

Each question carries its recommended answer. The owner answered all of them on 2026-10-28, as recommended: [ADR-0012](adr/0012-owner-decisions-rfc-0002-0010.md) and [ADR-0013](adr/0013-owner-decisions-remaining-questions.md) record the answers.

## Open questions

Questions about this index. Decided 2026-10-28 ([ADR-0013](adr/0013-owner-decisions-remaining-questions.md)): 1 as option B (commit G1), 2 by narrowing the ignore rule to everything but the records (commit `aff06b95`), 3 as recommended (option A).

### 1. How does a record keep citing code that a later step deletes?

The records cite files that platform step 1 deletes ([RFC-0002](rfc/0002-platform-steps-0-1.md) lists them). The previous-forms gate skips only `odd/`, six named files and binary files (`scripts/check-previous-forms.ts:54-63`) and fails a document that names a path or `file:line` that no longer exists (`scripts/check-previous-forms.ts:117-138`). The first deletion of a cited file would fail CI. Today the records pass: the gate run over main 4105c582 plus these records reports 0 violations, and a separate check finds every cited `path:line` inside its file at that commit.

What the gate does with a citation of a deleted file, tried on a synthetic record through the gate's own check function:

| Spelling (`<dir>` is a top-level directory of the repository, such as `src`) | Flagged |
|---|---|
| `<dir>/file.ts:12` | yes, dead path |
| a bare file name plus a line (`file.ts` then `:12`) | yes, dead citation |
| `4105c582:<dir>/file.ts:12` | yes, dead path |
| `git show 4105c582:<dir>/file.ts` | yes, dead path |
| `4105c582/<dir>/file.ts:12` | no, and only by accident: its first segment, the commit id, is not a top-level directory (`scripts/check-previous-forms.ts:121`) |

| Option | What it removes | What it costs |
|---|---|---|
| A. Skip `docs/architecture/` entirely, as `odd/` | Every failure from the records | The banned-term rules stop applying to the records too, so a record can call a retired thing by its old name unnoticed. |
| B. Skip only the path and citation checks for the folder; keep the banned-term rules ([RFC-0002](rfc/0002-platform-steps-0-1.md) Q1, commit G1) | The dead-path and dead-citation failures | One predicate in the gate script and a test, in a commit of its own (CI is governance-sensitive). After it, CI no longer checks that a record's path was right when written. |
| C. Cite through a commit-pinned form | Nothing today: the gate has no pinned form, and the one spelling it misses is a loophole | A gate change to recognise the form, then every citation rewritten (the records hold over a thousand). |
| D. Update the records when code moves | The failure at its source | Dated records stop showing what the code looked like when the decision was made, and every step 1 commit also edits records. |

Recommended: B. The header pins the commit, so a citation of a deleted file is expected, not an error: `git show 4105c582:<path>` opens it. B is the smallest gate change, it keeps the banned-term rules, and the gate already treats `odd/` the same way for the same reason. After B, correctness of a citation is checked once, against the pinned commit, when a record is written or reviewed. The retired-name rules that ADR-0004, ADR-0005, ADR-0007 and ADR-0010 add must not apply to the folder, because the records name those terms on purpose. The owner answers it as [RFC-0002](rfc/0002-platform-steps-0-1.md) Q1; [ADR-0007](adr/0007-code-target-removal.md) point C and [ADR-0010](adr/0010-maintainer-removal.md) point D are the same question.

### 2. Can git hold the records?

At 4105c582 `.gitignore:71` ignores `/docs/architecture/`. Its comment (`.gitignore:69`) says the line hides a third-party diagram tool checkout and the diagrams it generates. No path under `docs/architecture/` is tracked at that commit, and `scripts/check-previous-forms.ts:168` lists files with `git ls-files`, so while the line stands git does not take the records and CI does not scan them.

| Option | Cost |
|---|---|
| A. Remove the line in the commit that adds the records | Any diagram the tool writes there would show up as untracked. The tool checkout itself stays ignored by `.gitignore:70`. |
| B. Narrow the line to the folder the tool writes to | The tool's output folder is not named anywhere in the repository, so it has to be found first. |
| C. Move the records to another folder | Every link, id and file name of the records changes. |

Recommended: A. No generated diagram is tracked at 4105c582, and the records are maintained docs. Ship it with the commit that adds the records, so the gate and review see them from the first commit.

### 3. What happens to `docs/architecture-remediation.md`?

[ADR-0010](adr/0010-maintainer-removal.md) and [RFC-0002](rfc/0002-platform-steps-0-1.md) leave to this index whether that plan is edited or marked superseded. The gate skips it by name (`scripts/check-previous-forms.ts:56`), so leaving it costs nothing at the gate.

| Option | Cost |
|---|---|
| A. Leave it unedited | A reader may take its mentions of the maintainer as current. This index states what it is. |
| B. Add a one-line pointer to this index at its top | One commit on a dated plan, with no reader who needs it that the index above does not serve. |
| C. Mark it Superseded | It is not superseded as a whole: P2 and P3 are finished and the platform plan continues them. |

Recommended: A. A record that replaces part of it carries the Superseded status itself.
