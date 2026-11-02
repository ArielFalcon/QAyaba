# Plan diff: show what backs a use case

Branch: main. Delivery: single change set, no commit until the owner asks.
Test runner: `npm test -- "<glob>"` (a bare directory argument is read as a file, so always pass a glob).

## Why (measured, 53 stored plan turns of name-webapp)

- The `## Commit diff` section is 58.5% of the plan prompt in aggregate (median 52.7%, max 75.8%: 410,338 of 552,417 bytes).
- In the worst change (281 changed files, 238 with a diff block), **202 files (83% of the diff bytes, 300,533 of 362,625) seed no use-case candidate at all**.
- `.md` is 13.4% and `.scss` 16.1% of all diff bytes; neither can decide a Playwright flow.
- No single file exceeds 20 KB (largest 16,814 B), so the cost is many small pieces, not one large file.
- Three plan turns of 53 timed out at 180 s, at prompts of 44 KB, 183 KB and 499 KB: prompt size does not order the outcome. This change targets the bytes, not the timeout, and must not be sold as a timeout fix.

## Specs

S1. **A diff piece is shown only when it is backed.** A piece is backed when `piece.candidateIds` is non-empty (its changed lines overlap a use-case candidate's seeds, which `planDiff` already computes). Every other piece is withheld.

S2. **Fallback, never an empty diff.** When no piece of the diff is backed, or when the run carries no candidates, every piece keeps today's treatment (ranked for showing, `referenceOnly` only for test/generated/low-relevance). A change with no candidate must not reach the plan with an empty diff.

S3. **Formatting-only pieces are withheld.** A piece whose added lines equal its removed lines after normalising runs of whitespace (and ignoring blank lines) changes no behaviour: it is withheld with the reason `formatting-only`. This comparison is pure text, language-agnostic, and never needs a parser.

S4. **Exactly one reason per withheld piece.** `PlanReferenceWhy` gains `no-candidate` and `formatting-only`. Every piece that is not shown appears in `plan.referenceOnly` with one reason, in diff order. No piece is both shown and referenced, and no piece is in neither.

S5. **Completeness is asserted.** For any diff and any candidates: the multiset union of shown pieces and referenced pieces equals every piece the diff produced, each exactly once. The change map keeps every changed file, unfiltered.

S6. **The section says what it withheld.** After the shown fence, one line states how many pieces and how many bytes were withheld from the commit diff ("N of M pieces, R bytes, held back: ..."), with the counts per reason. Counts only; no free-form prose.

S7. **Nothing else changes.** The change map, the map line format, the reference line format, the window fit, the redaction and the fence mode stay exactly as they are.

## Explicitly out of scope (with the reason)

- **Symbol attribution** (the piece's enclosing symbol, its declaration before/after, added decisions). It needs symbol ranges, which the generation context does not hold, and a new seam to receive them. The data does not yet show it is needed: the measured win is S1 and S3.
- **Dropping hunks whose added lines are all imports, types or comments.** The reader that decides "this line is no code" lives in `objective-signal/infrastructure/statement-code-lines.ts`, and reaching it from `generation` would be a cross-context infrastructure import. It must arrive as an injected function if it is done at all.

## Tasks

| ID | Task | Spec | Surface |
|---|---|---|---|
| T1 | Selection in the domain: backing, fallback, formatting-only, the two new reasons, one reason per withheld piece | S1-S4 | `engine/src/contexts/generation/domain/plan-diff.ts` |
| T2 | Render the withheld count line and the new reason texts | S6 | `engine/src/contexts/generation/infrastructure/prompt-builders/plan-diff-section.ts` |
| T3 | Tests: the completeness invariant, the fallback, formatting-only, one reason per piece, the count line | S1-S6 | `engine/test/contexts/generation/**` |
| T4 | Gate: typecheck, arch:check, the generation and evaluation suites | - | - |

## Acceptance checks

- A diff whose pieces all overlap a candidate shows exactly those pieces and withholds the rest with `no-candidate`.
- A diff with no candidates shows every piece as today, and withholds only test/generated/low-relevance.
- A piece whose only change is reindentation is withheld as `formatting-only` and appears in no fence.
- The number of pieces in the fence plus the number referenced equals the diff's piece count, for a diff with mixed cases.
- The section's withheld line states the three counts.

## Risks

- **Over-filtering.** `candidateIds` comes from seed overlap, not reachability. A file that reaches a candidate without seeding it would be withheld. Mitigated by S2's fallback, by the change map keeping every file with its `+A -R`, and by the withheld line naming the counts. Validated in a campaign with `plan_candidate_coverage` and `delivered_candidate_coverage`.
- **The plan reading less.** The plan writes acceptance criteria from what it sees. A withheld hunk can be read from the working copy by location, which the reference line gives.

## Log

L1. Origin: the stored-run analysis of the 53 plan turns above, not a single request. It found the `## Commit diff` section to be the plan prompt's dominant cost and that 83% of its bytes seed no use-case candidate.

E1. One campaign replicate, `name-webapp@2de1f7a75e0d21558a5d00327bc7c3491fcfa95e`, the change whose plan turn had timed out at 180 s (`run-2de1f7a-mvxznjt8-df74806c`). Arm B with the change: `run-2de1f7a-mvzu8bqv-8ccf93fe`, campaign `plan-diff-backed-2026-11-02-b`.

| Fact | Before | After |
|---|---|---|
| plan prompt | 498,831 B | 281,193 B (−43.6%) |
| `## Commit diff` section | 371,285 B | 157,215 B (−57.6%) |
| file blocks in the fence | 216 | 39 |
| reference lines | 151 | 551 |
| plan turn | timeout, 180.0 s | completed, 93.9 s |
| admitted plan | — | 11 flows, 16 candidates, 0 drops |

The withheld line read: `532 of 629 pieces, 366401 bytes, held back by the selection: 400 no-use-case candidate, 132 app test file`. Of the 532, 132 were already withheld before this change by the file-kind rule; the new withholding is the 400.

E2. Deviation corrected before the commit: the withheld line first read `held back:`, which reads as the section's total and undercounts whenever the window fit sheds ranked pieces too. It now reads `held back by the selection:` (S6).

E3. Not proven, and not to be claimed:

- **One replicate.** Three of 53 stored plan turns timed out at 44 KB, 183 KB and 499 KB, so prompt size does not order the outcome. This change moves bytes; it is not shown to remove the timeout.
- **The net saving is not the fence alone.** References grew from 151 to 551 lines; part of what leaves the fence is paid back in the reference list.
- **`plan_candidate_coverage` and `delivered_candidate_coverage` are unmeasured.** The run was cancelled by the operator in `generate` (`cancelled by operator`, verdict `infra-error`), so the plan was admitted but no verdict, coverage or delivery followed. The admitted plan citing 16 candidates with 0 drops is the only coverage evidence, and it is not the grader.
- **The wiring-hunk risk of S1 is untested.** A hunk of a seeding file that does not overlap the seed is withheld; no run has shown whether the lead needed one.

E4. The first attempt at E1 measured nothing: it reported a byte-identical section because the orchestrator process still held the pre-change module (booted 2026-11-01T22:39Z, file changed 2026-11-02T23:18). `engine/` is a read-only bind mount and `tsx` loads modules at start, so an engine change needs `docker compose up -d --no-build --no-deps agents orchestrator` before any run measures it. The same recreate is what picked up a rotated `OPENCODE_API_KEY`.
