# Root-cause fixes 2026-10-28: confirmed causes, removed at the root, in the approved order

Objective: implement the accepted records (docs/architecture/, ADR-0011, ADR-0012) in the approved order. Branch: fix/root-cause-2026-10-28 (worktree qayaba-root-cause), rebased on main 4105c582. Delivery: work-unit commits on this branch; push, PR and merge stay with the owner. Test runner: npm test (node:test via tsx, Node v24.11.0); the full gate of AGENTS.md "Commands" closes every task.

## Specs

- S1. The brief (L1), whose rules hold for every task: "Never push, merge, or touch other existing worktrees." "Never print credentials or tokens." "If a fix needs a product or architecture decision, STOP and ask me — do not choose." Only confirmed causes are fixed, test-first, one commit per root cause, superseded patches removed, before and after measured ([ADR-0011](../../docs/architecture/adr/0011-root-cause-fix-policy.md)).
- S2. "no agregues mas parches a main, ten esos descubrimientos como informacion para el proceso de refactor": every change lands on this branch.
- S3. "las replicas van a demorar demasiado las 3 por separado una tras otra, lanza 1 sola" and "habiamos quedado en 1 sola replica, por que lanzaste 3?": one replicate per measurement; one against one shows a direction, not proof.
- S4. "respecto a las 13 recomendaciones estoy de acuerdo con todo" (D1-D13) and "me parece bien ese diseño para la capa de aprendizaje" (D14): ADR-0003 to ADR-0011. "Apruebo todas las decisiones con tu recomendación": every recommended answer of RFC-0002 to RFC-0010, recorded in ADR-0012. Each task implements its record as accepted, nothing more.
- S5. The owner's code implementation standard in AGENTS.md (commit 855457c1) is every task's done-criteria: precedent and reuse first, the smallest change, the rule searched across the whole codebase, the full gate green.
- S6. "me parece bien el orden": platform steps 0-1, then one slice per confirmed family, then platform steps 4-6.

## Tasks

| ID | Specs | Work | Route | Status | Commit |
|---|---|---|---|---|---|
| T1 | S4-S6 | RFC-0002 step 0: placement rule and decision table in AGENTS.md (Q14), pointer to ADR-0001, test-support sentence; inventory appendix root-cause-2026-10-28-inventory.md | inline | pending | |
| T2 | S4 | RFC-0002 Q1 (G1): previous-forms skips path and citation checks under docs/architecture/; own commit, before the first deletion. Risk item 5 (CI) | inline | pending | |
| T3 | S4 | RFC-0002 step 1: deletions in the order D11, D1 with D2, D8, D5 (Q9); twins and dead code; derived stored run outcome last (Z). D2 statement only on the owner's authorization (Q8); D11's GitHub part only on the owner's go. Risk items 1, 3, 5 | inline; a writer only by the Writer trigger | pending | |
| T4 | S1, S4 | RFC-0005 (H20): one writer for the suite store; ahead of the after-replicates | inline | pending | |
| T5 | S1, S4 | RFC-0003 (H06): coverage dump harvest off the event loop, one worker per call | inline | pending | |
| T6 | S1, S4 | RFC-0004 (H11): log level derived from the typed outcome | inline | pending | |
| T7 | S1, S4 | RFC-0006 (N02 residual): an agent's answer crosses whole; a loss is loud, never an approval | inline | pending | |
| T8 | S1, S4 | RFC-0007 (N04): a write the spec caused, measured against a control load; own commit. Risk item 2 (guard) | inline | pending | |
| T9 | S1, S4 | RFC-0008 (N06): an acceptance records what it ran | inline | pending | |
| T10 | S1, S4 | RFC-0009 (N09): the pack record lists what the prompt carried | inline | pending | |
| T11 | S1, S4 | RFC-0010 (N12): a tool call's record carries its outcome | inline | pending | |
| T12 | S1, S3 | After-measurement: one replicate on the owner's go, conditions of ADR-0011 (12-entry snapshot, freeze off) | owner's go | pending | |
| T13 | S6 | Platform steps 4-6 | later | pending | |

Route rule: every task runs inline unless the Writer trigger fires (independent units launched together); an independent verifier only for a task that names a high-risk item (T2, T3, T8).

## Log

- L1 (2026-10-28 10:21Z, the brief, verbatim):

  > 
  > ultracode 
  > 
  > <pasted_content id="692e">
  > Root-cause architecture investigation — QAyaba
  > Goal
  > Find the systemic root causes in QAyaba’s architecture that keep producing
  > recurring failures across executions — including ones that were patched over
  > or never detected — and fix them at the root with solutions that fit the
  > existing architecture. A one-off error is NOT a target; a structural defect
  > that explains a family of failures is.
  > Setup
  > Repo: Create a dedicated worktree from main(branch fix/root-cause-<date>). All edits and commits happen there.Never push, merge, or touch other existing worktrees. Create all needed woktrees as you understand are optimal for sub-agent work.
  > Record a baseline first: test suite result and current failure rates.
  > Telemetry sources: OpenTelemetry traces (Grafana), app logs, run history and evaluation results via the public API (/telemetry/*).Never print credentials or tokens. This project uses Loki, Tempo, has evals and graders.
  > Phases (parallelize inside each phase, not across them)
  > Map (parallel):a. Architecture: layers, boundaries, data flow, ADRs, conventions.b. Telemetry harvest: every failed or degraded execution with trace ID, span, error, phase, config. Separate infra-error from code failures.c. Patch archaeology: git history of fix commits — files and areas fixed repeatedly, workarounds, retries, try/except swallowing, TODO/HACK.
  > Taxonomy: cluster failures by mechanism (not by message text).Each cluster: count, affected runs, first/last seen, example trace IDs.
  > Hypotheses: for each cluster with recurrence, propose a root cause.Each hypothesis MUST include:
  > the causal chain from architectural defect → symptom, with file:line;
  > ≥3 concrete trace/run IDs it explains, and which failures it does NOT;
  > a falsifiable prediction (what else must be true if it is right);
  > which past patches it explains.
  > Refutation (independent agents, one per hypothesis): try to DISPROVE it — check the prediction, look for alternative explanations, reproduce it when possible. Verdict: confirmed / plausible / refuted, with evidence.Only “confirmed” moves on. Discard anything refuted; report “plausible”as open questions, never fix them.
  > Design: for each confirmed cause, one fix that removes the cause for the whole family, consistent with the architecture and ADRs. Name the patches it makes redundant. If a fix needs a product or architecture decision, STOP and ask me — do not choose.
  > Implement (worktree): test-first — a test that reproduces the failure mechanism (RED), then the fix (GREEN). One commit per root cause.Remove the patches the fix supersedes.
  > Verify: full suite against the baseline; re-run the affected scenarios and compare failure rates before/after. A fix without measured improvement is reported as unproven.
  > Evidence rules (non-negotiable)
  > No claim without evidence: trace/run IDs, log lines, or file:line.
  > Never generalize from one run. Recurrence must be shown with counts.
  > Do not attack symptoms nor straw men: if the evidence does not support a cause, say “not enough evidence” instead.
  > Label every conclusion as confirmed (evidence) or hypothesis.
  > Final report
  > Per root cause: failure family + counts, causal chain, evidence, refuter
  > verdict, fix, patches removed, tests, before/after metrics, commit.
  > Plus: refuted hypotheses (and why), open questions, residual risks.
  > </pasted_content id="692e">
  > 
  > 

- L2 (2026-10-28): investigation done. Phase 3 confirmed H06, H11, H20; phase 3b confirmed N02, N04, N06, N09, N12 alive on main (N01, N18 already removed at the root); the test-quality strand confirmed none. Before-measurement: run-ed28973-mvs7oo0f-17041c71 on 4105c582 (one replicate).
- L3 (2026-10-28 ~20:30Z): records committed (aff06b95 tracks docs/architecture records in .gitignore, 0794e37f the records); branch rebased on 4105c582; previous-forms clean. The owner asked to economize quota ("agiliza un poco el proceso que queda poco para el limite de cuota"); implementation starts with T1 on the owner's go.
