import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitLeadReview,
  MAX_SPEC_CHARS,
  renderLeadReview,
  REVIEW_ACTION,
  type FlowUnderReview,
} from "@contexts/qa-run-orchestration/application/coordination/lead-review.ts";
import { FLOW_OUTCOME } from "@contexts/qa-run-orchestration/application/coordination/flow-outcomes.ts";

function flow(over: Partial<FlowUnderReview> = {}): FlowUnderReview {
  return {
    id: "cart",
    objective: "the cart total",
    acceptance: ["the total adds the line prices"],
    outcome: { id: over.id ?? "cart", kind: FLOW_OUTCOME.DELIVERED, specs: [`flows/${over.id ?? "cart"}.spec.ts`] },
    concerns: [],
    verified: true,
    sessionOpen: true,
    runSpec: { calls: 2, maxCalls: 8, lastStatus: "passed" },
    spec: "test('total', async () => {});",
    ...over,
  };
}

const answer = (review: unknown[]): string => `Here it is:\n${JSON.stringify({ review })}`;

test("the review shows the lead, per flow, what it asked for, what came of it, the run_spec facts and the spec the sidekick wrote", () => {
  const text = renderLeadReview(
    [
      flow(),
      flow({ id: "login", objective: "sign in works", outcome: { id: "login", kind: FLOW_OUTCOME.FAILED, reason: "failed: the button never appeared" }, verified: false, runSpec: { calls: 3, maxCalls: 8, lastStatus: "failed", lastFailure: "locator('Sign in') not found on /login" }, spec: undefined, summary: "could not find the button", concerns: ["the page may differ on DEV"] }),
    ],
    { turn: 1, maxTurns: 3 },
  );
  for (const expected of ["cart", "the cart total", "the total adds the line prices", "test('total'", "login", "sign in works", "the button never appeared", "locator('Sign in') not found on /login", "could not find the button", "the page may differ on DEV", "3 of 8"]) {
    assert.ok(text.includes(expected), expected);
  }
  for (const action of Object.values(REVIEW_ACTION)) assert.ok(text.includes(`"${action}"`), action);
});

test("a spec longer than the review holds is cut, and says so", () => {
  const line = "  await expect(page.getByRole('row')).toHaveCount(3);\n";
  const spec = line.repeat(Math.ceil((MAX_SPEC_CHARS + 500) / line.length));
  const text = renderLeadReview([flow({ spec })], { turn: 1, maxTurns: 3 });
  assert.ok(!text.includes(spec));
  assert.match(text, /cut at \d+ characters/);
});

test("on the last turn the lead is told it can only accept or drop", () => {
  assert.match(renderLeadReview([flow()], { turn: 3, maxTurns: 3 }), /last review/i);
});

test("an accept of a flow whose spec passed run_spec on its current bytes is taken", () => {
  const admitted = admitLeadReview(answer([{ flow: "cart", action: "accept" }]), [flow()], { revisionsAllowed: true });
  assert.equal(admitted.readable, true);
  assert.deepEqual(admitted.accepted, ["cart"]);
  assert.deepEqual(admitted.orders, []);
});

test("an accept of a spec that has not passed run_spec on its current bytes is sent back with the orchestrator's facts while a review turn is left, and stands otherwise", () => {
  const unverified = flow({ verified: false, runSpec: { calls: 2, maxCalls: 8, lastStatus: "failed", lastFailure: "expected 3, got 0 on /shops" } });
  const sent = admitLeadReview(answer([{ flow: "cart", action: "accept" }]), [unverified], { revisionsAllowed: true });
  assert.equal(sent.orders.length, 1);
  assert.equal(sent.orders[0]!.action, REVIEW_ACTION.REVISE);
  assert.match(sent.orders[0]!.instruction, /expected 3, got 0 on \/shops/);
  assert.equal(sent.refused[0]!.flowId, "cart");
  const late = admitLeadReview(answer([{ flow: "cart", action: "accept" }]), [unverified], { revisionsAllowed: false });
  assert.deepEqual(late.orders, []);
  assert.deepEqual(late.accepted, ["cart"], "the run's execution judges it");
  assert.equal(late.refused.length, 1, "the gap is recorded");
});

test("a spec that can no longer be run is accepted as it is", () => {
  const spent = flow({ verified: false, runSpec: { calls: 8, maxCalls: 8, lastStatus: "failed" } });
  const admitted = admitLeadReview(answer([{ flow: "cart", action: "accept" }]), [spent], { revisionsAllowed: true });
  assert.deepEqual(admitted.orders, []);
  assert.deepEqual(admitted.accepted, ["cart"]);
});

test("a revise reaches the same sidekick with the lead's instruction; with its session gone it is a replace", () => {
  const open = admitLeadReview(answer([{ flow: "cart", action: "revise", instruction: "Assert the total, not the count." }]), [flow()], { revisionsAllowed: true });
  assert.deepEqual(open.orders, [{ flowId: "cart", action: REVIEW_ACTION.REVISE, instruction: "Assert the total, not the count." }]);
  const gone = admitLeadReview(answer([{ flow: "cart", action: "revise", instruction: "Assert the total." }]), [flow({ sessionOpen: false })], { revisionsAllowed: true });
  assert.equal(gone.orders[0]!.action, REVIEW_ACTION.REPLACE);
});

test("a revise with no instruction, or any revision once no review turn is left, is refused", () => {
  const bare = admitLeadReview(answer([{ flow: "cart", action: "revise" }]), [flow()], { revisionsAllowed: true });
  assert.deepEqual(bare.orders, []);
  assert.equal(bare.refused.length, 1);
  const late = admitLeadReview(answer([{ flow: "cart", action: "replace", instruction: "again" }]), [flow()], { revisionsAllowed: false });
  assert.deepEqual(late.orders, []);
  assert.equal(late.refused.length, 1);
});

test("a flow that showed an app defect is never sent back to be made green", () => {
  const defect = flow({ appDefect: "the server answered 500 on /cart", verified: false });
  for (const action of [REVIEW_ACTION.REVISE, REVIEW_ACTION.REPLACE]) {
    const admitted = admitLeadReview(answer([{ flow: "cart", action, instruction: "make it pass" }]), [defect], { revisionsAllowed: true });
    assert.deepEqual(admitted.orders, [], action);
    assert.match(admitted.refused[0]!.reason, /app defect/);
  }
  const accepted = admitLeadReview(answer([{ flow: "cart", action: "accept" }]), [defect], { revisionsAllowed: true });
  assert.deepEqual(accepted.orders, [], "an accepted app defect is not sent back either");
  assert.deepEqual(accepted.accepted, ["cart"]);
});

test("a flow that delivered nothing may be dropped with the lead's reason; one that delivered may not", () => {
  const failed = flow({ outcome: { id: "cart", kind: FLOW_OUTCOME.FAILED, reason: "x" }, spec: undefined, verified: false });
  const dropped = admitLeadReview(answer([{ flow: "cart", action: "drop", reason: "the change does not touch the cart" }]), [failed], { revisionsAllowed: true });
  assert.deepEqual(dropped.dropped, [{ flowId: "cart", reason: "the change does not touch the cart" }]);
  const kept = admitLeadReview(answer([{ flow: "cart", action: "drop", reason: "redundant" }]), [flow()], { revisionsAllowed: true });
  assert.deepEqual(kept.dropped, []);
  assert.equal(kept.refused.length, 1);
});

test("an answer that cannot be read, names no flow it was shown, or names one twice changes nothing beyond its first word on each flow", () => {
  assert.equal(admitLeadReview("I think it is fine", [flow()], { revisionsAllowed: true }).readable, false);
  const odd = admitLeadReview(
    answer([{ flow: "ghost", action: "drop" }, { flow: "cart", action: "revise", instruction: "first" }, { flow: "cart", action: "revise", instruction: "second" }, { flow: "cart", action: "sing" }]),
    [flow()],
    { revisionsAllowed: true },
  );
  assert.deepEqual(odd.orders.map((o) => o.instruction), ["first"]);
});

test("the lead's instruction is bounded and scrubbed before it reaches a sidekick", () => {
  const admitted = admitLeadReview(answer([{ flow: "cart", action: "revise", instruction: `use token sk-ant-api03-${"a".repeat(40)} ${"y".repeat(5000)}` }]), [flow()], { revisionsAllowed: true });
  const instruction = admitted.orders[0]!.instruction;
  assert.ok(instruction.length <= 1200);
  assert.ok(!instruction.includes("sk-ant-api03-aaaa"));
});
