import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { GENERATION_NOTE_MAX_CHARS } from "@contexts/generation/domain/generation-end.ts";
import {
  aggregateFlowOutcomes,
  FLOW_OUTCOME,
  type FlowOutcome,
} from "@contexts/qa-run-orchestration/application/coordination/flow-outcomes.ts";

const delivered = (id: string, ...specs: string[]): FlowOutcome => ({ id, kind: FLOW_OUTCOME.DELIVERED, specs });
const declined = (id: string, reason = "already covered by flows/x.spec.ts"): FlowOutcome => ({ id, kind: FLOW_OUTCOME.DECLINED, reason });
const timedOut = (id: string): FlowOutcome => ({ id, kind: FLOW_OUTCOME.TIMED_OUT });
const failed = (id: string, reason = "the sidekick failed"): FlowOutcome => ({ id, kind: FLOW_OUTCOME.FAILED, reason });
const needsLead = (id: string, reason = "needs a decision"): FlowOutcome => ({ id, kind: FLOW_OUTCOME.NEEDS_LEAD, reason });

test("one delivered flow is a delivery, whatever became of the others, and the others are listed as incomplete", () => {
  const result = aggregateFlowOutcomes([delivered("a", "flows/a.spec.ts"), timedOut("b"), failed("c"), needsLead("d"), declined("e")]);
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.specs, ["flows/a.spec.ts"]);
  assert.deepEqual(result.incompleteFlows.map((f) => [f.id, f.kind]), [["b", FLOW_OUTCOME.TIMED_OUT], ["c", FLOW_OUTCOME.FAILED], ["d", FLOW_OUTCOME.NEEDS_LEAD]]);
});

test("a flow that was declined with a reason is a decision, not an incomplete flow", () => {
  const result = aggregateFlowOutcomes([delivered("a", "flows/a.spec.ts"), declined("b")]);
  assert.deepEqual(result.incompleteFlows, []);
});

test("the specs of the delivered flows are all kept, in the order of the flows, each once", () => {
  const result = aggregateFlowOutcomes([delivered("a", "flows/a.spec.ts", "flows/shared.spec.ts"), delivered("b", "flows/shared.spec.ts", "flows/b.spec.ts")]);
  assert.deepEqual(result.specs, ["flows/a.spec.ts", "flows/shared.spec.ts", "flows/b.spec.ts"]);
});

test("a flow that delivered no spec is not a delivery", () => {
  const result = aggregateFlowOutcomes([{ id: "a", kind: FLOW_OUTCOME.DELIVERED, specs: [] }, declined("b")]);
  assert.notEqual(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.incompleteFlows.map((f) => f.id), ["a"], "and it is reported as a flow that did not finish");
});

test("flows that were all declined with a reason are a declared no-op, and the note carries every reason", () => {
  const result = aggregateFlowOutcomes([declined("a", "covered by login"), declined("b", "documentation only")]);
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.deepEqual(result.specs, []);
  assert.match(result.note ?? "", /covered by login/);
  assert.match(result.note ?? "", /documentation only/);
  assert.match(result.note ?? "", /\ba\b/);
});

test("a decline with no reason is silence: it decides nothing", () => {
  const result = aggregateFlowOutcomes([declined("a", "covered"), declined("b", "   ")]);
  assert.equal(result.end, GENERATION_END.UNDECIDED_EMPTY);
});

test("with nothing delivered, a flow that ran out of time ends the run on its time budget, even beside declines", () => {
  for (const outcomes of [[timedOut("a"), failed("b")], [declined("a"), timedOut("b")], [timedOut("a")]]) {
    assert.equal(aggregateFlowOutcomes(outcomes).end, GENERATION_END.TIME_BUDGET);
  }
});

test("with nothing delivered and no flow out of time, failures and unanswered flows are no decision, and the note says what became of each", () => {
  const result = aggregateFlowOutcomes([failed("a", "no spec on disk"), needsLead("b", "needs the login decision"), declined("c", "covered")]);
  assert.equal(result.end, GENERATION_END.UNDECIDED_EMPTY);
  assert.match(result.note ?? "", /no spec on disk/);
  assert.match(result.note ?? "", /needs the login decision/);
});

test("no flows at all is no decision", () => {
  assert.equal(aggregateFlowOutcomes([]).end, GENERATION_END.UNDECIDED_EMPTY);
});

test("a note stays within the bound a generation note has", () => {
  const long = "x".repeat(GENERATION_NOTE_MAX_CHARS);
  const result = aggregateFlowOutcomes([declined("a", long), declined("b", long)]);
  assert.ok((result.note ?? "").length <= GENERATION_NOTE_MAX_CHARS);
});
