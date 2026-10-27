/* The graders of a run's critical stages: whether the change's pages were grounded, whether specs green through run_spec stayed green, how many run_spec calls were refused and whether the sidekicks' reports match their run_spec calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { ContextEvidence, RunEvaluationEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import { UNREADABLE_ANSWER } from "@kernel/unreadable-answer.ts";
import { evidence } from "./evidence-fixtures.ts";

const score = (name: string, over: Partial<RunEvaluationEvidence>) => gradeEvidence(evidence(over), [name]).find((s) => s.name === name);

function context(packIds: string[], over: Partial<ContextEvidence> = {}, packOver: { idsOverflow?: number } = {}): ContextEvidence {
  return {
    delivered: [{ source: "context-pack", ids: packIds, bytes: 100, omitted: 0, omissions: [], ...packOver }],
    relevantIds: ["route:/cart", "route:/shops/:city"],
    relevantGroups: [],
    changedTestIds: [],
    changedElement: undefined,
    snapshots: [],
    toolSequence: [],
    fileReads: undefined,
    freshness: undefined,
    ...over,
  };
}

test("change_pages_grounded is the share of the change's pages the delivered Context Pack holds a live tree of, naming the others", () => {
  const s = score("change_pages_grounded", { context: context(["dom:/login#role:button:1", "dom:/cart#role:link:2"]) });
  assert.equal(s?.value, 1 / 2);
  assert.equal(s?.comment, "not grounded: /shops/:city");
  assert.equal(score("change_pages_grounded", { context: context(["dom:/cart#a", "dom:/shops/:city#b"]) })?.value, 1);
  assert.equal(score("change_pages_grounded", { context: context(["dom:/cart/extra#a"]) })?.value, 0, "a page whose address only starts like a change page is not it");
});

test("change_pages_grounded says nothing without change pages, without a delivered pack, or when a missing page may be past the id cap", () => {
  assert.equal(score("change_pages_grounded", { context: undefined }), undefined);
  assert.equal(score("change_pages_grounded", { context: context(["dom:/cart#a"], { relevantIds: [] }) }), undefined);
  assert.equal(score("change_pages_grounded", { context: { ...context([]), delivered: [] } }), undefined);
  assert.equal(score("change_pages_grounded", { context: context(["dom:/cart#a"], {}, { idsOverflow: 3 }) }), undefined);
  assert.equal(score("change_pages_grounded", { context: context(["dom:/cart#a", "dom:/shops/:city#b"], {}, { idsOverflow: 3 }) })?.value, 1, "every page found needs no list past the cap");
});

test("run_spec_final_agreement is the share of specs green through run_spec on their final bytes that also passed the final execution", () => {
  const s = score("run_spec_final_agreement", {
    verdict: "fail",
    runSpecCalls: [
      { path: "flows/cart.spec.ts", sha256: "old", outcome: "failed", refusal: undefined },
      { path: "flows/cart.spec.ts", sha256: "final-cart", outcome: "passed", refusal: undefined },
      { path: "flows/menu.spec.ts", sha256: "final-menu", outcome: "passed", refusal: undefined },
    ],
    deliveredSpecs: [
      { path: "e2e/flows/cart.spec.ts", sha256: "final-cart", passed: true },
      { path: "e2e/flows/menu.spec.ts", sha256: "final-menu", passed: false },
    ],
  });
  assert.equal(s?.value, 1 / 2);
  assert.match(String(s?.comment), /failed the final execution on the same bytes: e2e\/flows\/menu\.spec\.ts/);
});

test("run_spec_final_agreement grades only specs whose final bytes passed run_spec and whose final result is known", () => {
  const over = (deliveredSpecs: RunEvaluationEvidence["deliveredSpecs"]) => score("run_spec_final_agreement", { runSpecCalls: [{ path: "flows/cart.spec.ts", sha256: "passed-bytes", outcome: "passed", refusal: undefined }], deliveredSpecs });
  assert.equal(over([{ path: "flows/cart.spec.ts", sha256: "edited-after", passed: false }]), undefined, "bytes changed after the passing call were never proven");
  assert.equal(over([{ path: "flows/cart.spec.ts", sha256: "passed-bytes", passed: undefined }]), undefined);
  assert.equal(over([{ path: "flows/other.spec.ts", sha256: "passed-bytes", passed: false }]), undefined, "the same bytes under another path are another spec");
  assert.equal(score("run_spec_final_agreement", { deliveredSpecs: [{ path: "flows/cart.spec.ts", sha256: "x", passed: true }] }), undefined);
});

test("closed_loop_refusals is the share of run_spec calls refused, with each refusal code counted", () => {
  const refused = (refusal: string) => ({ path: "flows/a.spec.ts", sha256: undefined, outcome: "refused", refusal });
  const s = score("closed_loop_refusals", { runSpecCalls: [refused("no-writes"), refused("no-writes"), refused("invalid-request"), { path: "flows/a.spec.ts", sha256: "x", outcome: "passed", refusal: undefined }] });
  assert.equal(s?.value, 3 / 4);
  assert.equal(s?.comment, "3 of 4 refused: no-writes ×2, invalid-request ×1");
  const clean = score("closed_loop_refusals", { runSpecCalls: [{ path: "flows/a.spec.ts", sha256: "x", outcome: "failed", refusal: undefined }] });
  assert.equal(clean?.value, 0);
  assert.equal(clean?.comment, undefined);
  assert.equal(score("closed_loop_refusals", { runSpecCalls: [] }), undefined, "a run that made no call has no loop to grade");
});

test("sidekick_report_consistent fails when a sidekick gave up on a spec that had just passed run_spec, or claimed done on one that had not", () => {
  const report = (status: string, lastRunSpec: string | undefined, attempt = 1) => ({ delegationId: `run-1-flow-${status}`, attempt, status, lastRunSpec });
  const gaveUp = score("sidekick_report_consistent", { sidekickReports: [report("failed", "passed"), report("completed", "passed")] });
  assert.equal(gaveUp?.value, false);
  assert.equal(gaveUp?.comment, "flow-failed turn 1: reported failed, last run_spec passed");
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [report("completed", "failed", 2)] })?.comment, "flow-completed turn 2: reported completed, last run_spec failed");
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [report("blocked", "failed"), report("completed", "passed")] })?.value, true);
});

test("sidekick_report_consistent says nothing when no report can be checked against a run_spec call", () => {
  const report = (status: string, lastRunSpec: string | undefined) => ({ delegationId: "run-1-flow-cart", attempt: 1, status, lastRunSpec });
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [] }), undefined);
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [report("failed", undefined)] }), undefined);
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [report("needs-lead", "passed"), report("completed-with-concerns", "failed")] }), undefined);
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [report("completed-with-concerns", "passed")] }), undefined, "an unmet DEV's state prevents, recorded with a spec that passed, is not an inconsistent report");
});

test("sidekick_report_consistent never reads an answer that could not be read as a report of failure", () => {
  const unreadable = { delegationId: "run-1-flow-cart", attempt: 1, status: UNREADABLE_ANSWER, lastRunSpec: "passed" };
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [unreadable] }), undefined);
  assert.equal(score("sidekick_report_consistent", { sidekickReports: [unreadable, { ...unreadable, delegationId: "run-1-flow-b", status: "completed" }] })?.value, true);
});

test("a run that has not finished is graded by none of them", () => {
  const over: Partial<RunEvaluationEvidence> = {
    finished: false,
    verdict: null,
    context: context([]),
    runSpecCalls: [{ path: "flows/a.spec.ts", sha256: "x", outcome: "refused", refusal: "no-writes" }],
    sidekickReports: [{ delegationId: "run-1-flow-a", attempt: 1, status: "failed", lastRunSpec: "passed" }],
  };
  assert.deepEqual(gradeEvidence(evidence(over), ["change_pages_grounded", "run_spec_final_agreement", "closed_loop_refusals", "sidekick_report_consistent"]), []);
});
