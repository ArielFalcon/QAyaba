import { pageCandidate } from "../../../support/use-case-candidate.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitLeadReview,
  candidateGapsOf,
  MAX_SPEC_CHARS,
  renderLeadReview,
  REVIEW_ACTION,
  withSpecDigests,
  type FlowUnderReview,
  type SeenSpecs,
} from "@contexts/coordination/application/lead-review.ts";
import { FLOW_OUTCOME } from "@contexts/coordination/application/flow-outcomes.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

function flow(over: Partial<FlowUnderReview> = {}): FlowUnderReview {
  return {
    id: "cart",
    objective: "the cart total",
    acceptance: ["the total adds the line prices"],
    outcome: { id: over.id ?? "cart", kind: FLOW_OUTCOME.DELIVERED, specs: [`flows/${over.id ?? "cart"}.spec.ts`] },
    answer: { kind: "read", concerns: [] },
    verified: true,
    sessionOpen: true,
    runSpec: { calls: 2, maxCalls: 8, lastStatus: "passed" },
    spec: "test('total', async () => {});",
    ...over,
  };
}

const answer = (review: unknown[]): string => `Here it is:\n${JSON.stringify({ review })}`;

test("the review shows the lead, per flow, what it asked for, what came of it, the run_spec facts and the spec the sidekick wrote", () => {
  const text = renderLeadReview(redaction, 
    [
      flow(),
      flow({ id: "login", objective: "sign in works", outcome: { id: "login", kind: FLOW_OUTCOME.FAILED, reason: "failed: the button never appeared" }, verified: false, runSpec: { calls: 3, maxCalls: 8, lastStatus: "failed", lastFailure: "locator('Sign in') not found on /login" }, spec: undefined, answer: { kind: "read", summary: "could not find the button", concerns: ["the page may differ on DEV"] } }),
    ],
    { turn: 1, maxTurns: 3 },
  );
  for (const expected of ["cart", "the cart total", "the total adds the line prices", "test('total'", "login", "sign in works", "the button never appeared", "locator('Sign in') not found on /login", "could not find the button", "the page may differ on DEV", "3 of 8"]) {
    assert.ok(text.includes(expected), expected);
  }
});

test("the lead's role prompt names every review action the orchestrator admits", () => {
  const prompt = readFileSync(join(process.cwd(), "agents", "agent", "qa-lead.md"), "utf8");
  for (const action of Object.values(REVIEW_ACTION)) assert.ok(prompt.includes(`\`${action}\``), action);
});

test("a spec longer than the review holds is cut, and says so", () => {
  const line = "  await expect(page.getByRole('row')).toHaveCount(3);\n";
  const spec = line.repeat(Math.ceil((MAX_SPEC_CHARS + 500) / line.length));
  const text = renderLeadReview(redaction, [flow({ spec })], { turn: 1, maxTurns: 3 });
  assert.ok(!text.includes(spec));
  assert.match(text, /cut at \d+ characters/);
});

test("a review is read from the last object that holds one, past narration braces and earlier objects", () => {
  const text = `Considering \`{flow, action}\` and {"notes":"first"} here is my review: ${answer([{ flow: "cart", action: "accept" }])}`;
  const admitted = admitLeadReview(redaction, text, [flow()], { revisionsAllowed: true });
  assert.equal(admitted.readable, true);
  assert.deepEqual(admitted.accepted, ["cart"]);
});

test("on the last turn the lead is told it can only accept or drop", () => {
  assert.match(renderLeadReview(redaction, [flow()], { turn: 3, maxTurns: 3 }), /last review/i);
});

test("an accept of a flow whose spec passed run_spec on its current bytes is taken", () => {
  const admitted = admitLeadReview(redaction, answer([{ flow: "cart", action: "accept" }]), [flow()], { revisionsAllowed: true });
  assert.equal(admitted.readable, true);
  assert.deepEqual(admitted.accepted, ["cart"]);
  assert.deepEqual(admitted.orders, []);
});

test("an accept of a spec that has not passed run_spec on its current bytes is sent back with the orchestrator's facts while a review turn is left, and stands otherwise", () => {
  const unverified = flow({ verified: false, runSpec: { calls: 2, maxCalls: 8, lastStatus: "failed", lastFailure: "expected 3, got 0 on /shops" } });
  const sent = admitLeadReview(redaction, answer([{ flow: "cart", action: "accept" }]), [unverified], { revisionsAllowed: true });
  assert.equal(sent.orders.length, 1);
  assert.equal(sent.orders[0]!.action, REVIEW_ACTION.REVISE);
  assert.match(sent.orders[0]!.instruction, /expected 3, got 0 on \/shops/);
  assert.equal(sent.refused[0]!.flowId, "cart");
  assert.equal(sent.refused[0]!.code, "unverified-sent-back");
  assert.equal(sent.orders[0]!.overrideReason, "unverified-sent-back", "the order says it is not what the lead decided");
  const late = admitLeadReview(redaction, answer([{ flow: "cart", action: "accept" }]), [unverified], { revisionsAllowed: false });
  assert.deepEqual(late.orders, []);
  assert.deepEqual(late.accepted, ["cart"], "the run's execution judges it");
  assert.equal(late.refused.length, 1, "the gap is recorded");
});

test("a spec changed after its last passing call, with no call left to run it again, is accepted as it is", () => {
  const spent = flow({ verified: false, runSpec: { calls: 8, maxCalls: 8, lastStatus: "passed" } });
  const admitted = admitLeadReview(redaction, answer([{ flow: "cart", action: "accept" }]), [spent], { revisionsAllowed: true });
  assert.deepEqual(admitted.orders, []);
  assert.deepEqual(admitted.accepted, ["cart"]);
});

test("a revise reaches the same sidekick with the lead's instruction; with its session gone it is a replace", () => {
  const open = admitLeadReview(redaction, answer([{ flow: "cart", action: "revise", instruction: "Assert the total, not the count." }]), [flow()], { revisionsAllowed: true });
  assert.deepEqual(open.orders, [{ flowId: "cart", action: REVIEW_ACTION.REVISE, instruction: "Assert the total, not the count." }]);
  const gone = admitLeadReview(redaction, answer([{ flow: "cart", action: "revise", instruction: "Assert the total." }]), [flow({ sessionOpen: false })], { revisionsAllowed: true });
  assert.equal(gone.orders[0]!.action, REVIEW_ACTION.REPLACE);
});

test("a revise with no instruction, or any revision once no review turn is left, is refused", () => {
  const bare = admitLeadReview(redaction, answer([{ flow: "cart", action: "revise" }]), [flow()], { revisionsAllowed: true });
  assert.deepEqual(bare.orders, []);
  assert.equal(bare.refused.length, 1);
  const late = admitLeadReview(redaction, answer([{ flow: "cart", action: "replace", instruction: "again" }]), [flow()], { revisionsAllowed: false });
  assert.deepEqual(late.orders, []);
  assert.equal(late.refused.length, 1);
});

test("a flow that showed an app defect is never sent back to be made green", () => {
  const defect = flow({ appDefect: "the server answered 500 on /cart", verified: false });
  for (const action of [REVIEW_ACTION.REVISE, REVIEW_ACTION.REPLACE]) {
    const admitted = admitLeadReview(redaction, answer([{ flow: "cart", action, instruction: "make it pass" }]), [defect], { revisionsAllowed: true });
    assert.deepEqual(admitted.orders, [], action);
    assert.match(admitted.refused[0]!.reason, /app defect/);
  }
  const accepted = admitLeadReview(redaction, answer([{ flow: "cart", action: "accept" }]), [defect], { revisionsAllowed: true });
  assert.deepEqual(accepted.orders, [], "an accepted app defect is not sent back either");
  assert.deepEqual(accepted.accepted, ["cart"]);
});

test("a flow that delivered nothing may be dropped with the lead's reason; one that delivered may not", () => {
  const failed = flow({ outcome: { id: "cart", kind: FLOW_OUTCOME.FAILED, reason: "x" }, spec: undefined, verified: false });
  const dropped = admitLeadReview(redaction, answer([{ flow: "cart", action: "drop", reason: "the change does not touch the cart" }]), [failed], { revisionsAllowed: true });
  assert.deepEqual(dropped.dropped, [{ flowId: "cart", reason: "the change does not touch the cart" }]);
  const kept = admitLeadReview(redaction, answer([{ flow: "cart", action: "drop", reason: "redundant" }]), [flow()], { revisionsAllowed: true });
  assert.deepEqual(kept.dropped, []);
  assert.equal(kept.refused.length, 1);
});

test("an answer that cannot be read, names no flow it was shown, or names one twice changes nothing beyond its first word on each flow", () => {
  assert.equal(admitLeadReview(redaction, "I think it is fine", [flow()], { revisionsAllowed: true }).readable, false);
  const odd = admitLeadReview(redaction, 
    answer([{ flow: "ghost", action: "drop" }, { flow: "cart", action: "revise", instruction: "first" }, { flow: "cart", action: "revise", instruction: "second" }, { flow: "cart", action: "sing" }]),
    [flow()],
    { revisionsAllowed: true },
  );
  assert.deepEqual(odd.orders.map((o) => o.instruction), ["first"]);
});

test("the lead's instruction is bounded and scrubbed before it reaches a sidekick", () => {
  const admitted = admitLeadReview(redaction, answer([{ flow: "cart", action: "revise", instruction: `use token sk-ant-api03-${"a".repeat(40)} ${"y".repeat(5000)}` }]), [flow()], { revisionsAllowed: true });
  const instruction = admitted.orders[0]!.instruction;
  assert.ok(instruction.length <= 1200);
  assert.ok(!instruction.includes("sk-ant-api03-aaaa"));
});

test("an accept of a spec whose last run_spec call failed is sent back even when the flow has no call left, while a review turn is left", () => {
  const failing = flow({ verified: false, runSpec: { calls: 8, maxCalls: 8, lastStatus: "failed", lastFailure: "expected 3, got 0" } });
  const admitted = admitLeadReview(redaction, answer([{ flow: "cart", action: "accept" }]), [failing], { revisionsAllowed: true });
  assert.equal(admitted.orders[0]?.action, REVIEW_ACTION.REVISE);
  assert.match(admitted.orders[0]!.instruction, /expected 3, got 0/);
});

const required = [pageCandidate("/cart"), pageCandidate("/login"), pageCandidate("/orders"), pageCandidate("/shops/:city")];
const ADMISSION = { required, others: 0 };

test("the use cases no flow covers and those no passing flow covers are named; one a passing flow covers is not", () => {
  const gaps = candidateGapsOf(ADMISSION, new Set(), [
    { routes: ["/cart"], candidates: [], review: flow() },
    { routes: ["/login"], candidates: [], review: flow({ id: "login", verified: false, runSpec: { calls: 2, maxCalls: 8, lastStatus: "failed" } }) },
    { routes: [], candidates: ["uc-/shops/:city"], review: flow({ id: "shops", runSpec: undefined, verified: false }) },
  ]);
  assert.deepEqual([gaps?.unvisited.map((c) => c.id), gaps?.unproven.map((c) => c.id)], [["uc-/orders"], ["uc-/login"]]);
});

test("a use case the lead dropped with a reason is not named", () => {
  const gaps = candidateGapsOf(ADMISSION, new Set(["uc-/orders"]), [
    { routes: ["/cart", "/login", "/shops/madrid"], candidates: [], review: flow() },
  ]);
  assert.equal(gaps, undefined);
});

test("with every use case covered by a passing flow, or none to answer for, there is nothing to name", () => {
  assert.equal(candidateGapsOf({ required: [pageCandidate("/cart")], others: 0 }, new Set(), [{ routes: ["/cart"], candidates: [], review: flow() }]), undefined);
  assert.equal(candidateGapsOf({ required: [], others: 2 }, new Set(), [{ routes: ["/cart"], candidates: [], review: flow() }]), undefined);
});

test("the review names the use cases left uncovered and unproven, and without them says nothing of candidates", () => {
  const gaps = candidateGapsOf({ required, others: 2 }, new Set(), [{ routes: ["/cart"], candidates: [], review: flow() }])!;
  const text = renderLeadReview(redaction, [flow()], { turn: 1, maxTurns: 3 }, gaps);
  assert.ok(text.includes("uc-/orders") && text.includes("uc-/login"));
  assert.ok(!text.includes("uc-/cart"), "a use case a passing flow covers is not named");
  assert.match(text, /2 less direct/);
  assert.ok(!renderLeadReview(redaction, [flow()], { turn: 1, maxTurns: 3 }).includes("uc-/orders"));
});

test("an answer the orchestrator could not read, or a foreign brief's, is stated as the orchestrator's fact and never as what the sidekick says or concerns", () => {
  for (const kind of ["unreadable", "foreign-brief"] as const) {
    const text = renderLeadReview(redaction, [flow({ answer: { kind } })], { turn: 1, maxTurns: 3 });
    assert.ok(!/Sidekick says|Sidekick concerns/.test(text), kind);
    assert.match(text, /Sidekick answer: the orchestrator/, kind);
  }
  const read = renderLeadReview(redaction, [flow({ answer: { kind: "read", summary: "done", concerns: ["flaky"] } })], { turn: 1, maxTurns: 3 });
  assert.match(read, /Sidekick says: done/);
  assert.match(read, /Sidekick concerns: flaky/);
});

test("a run_spec failure is the last failure only when it was seen on the bytes the spec holds now, otherwise it is labelled as earlier bytes", () => {
  const runSpec = { calls: 3, maxCalls: 8, lastStatus: "failed", lastFailure: "locator not found" };
  const current = renderLeadReview(redaction, [flow({ verified: false, runSpec: { ...runSpec, lastFailureCurrent: true } })], { turn: 1, maxTurns: 3 });
  assert.match(current, /^Last failure: locator not found$/m);
  const earlier = renderLeadReview(redaction, [flow({ verified: false, runSpec: { ...runSpec, lastFailureCurrent: false } })], { turn: 1, maxTurns: 3 });
  assert.doesNotMatch(earlier, /^Last failure: /m);
  assert.match(earlier, /Last failure \(seen on earlier bytes[^)]*\): locator not found/);
});

test("the instruction that sends an unverified spec back names its last failure as of earlier bytes unless it was seen on the current ones", () => {
  const unverified = (lastFailureCurrent: boolean) => flow({ verified: false, runSpec: { calls: 1, maxCalls: 8, lastStatus: "failed", lastFailure: "boom", lastFailureCurrent } });
  const sent = (f: FlowUnderReview): string => admitLeadReview(redaction, answer([{ flow: "cart", action: "accept" }]), [f], { revisionsAllowed: true }).orders[0]!.instruction;
  assert.match(sent(unverified(false)), /last failure, seen on earlier bytes: boom/);
  assert.match(sent(unverified(true)), /last failure: boom/);
});

test("a flow whose spec bytes the lead was already shown in this session carries a digest instead of the spec; changed bytes are sent in full", () => {
  const seen: SeenSpecs = new Map();
  const first = withSpecDigests([flow({ spec: "a\nb\nc" })], seen, 1);
  assert.equal(first[0]!.spec, "a\nb\nc");
  const second = withSpecDigests([flow({ spec: "a\nb\nc" })], seen, 2);
  assert.equal(second[0]!.spec, undefined);
  assert.deepEqual({ ...second[0]!.specUnchanged!, sha256: undefined }, { sinceTurn: 1, sha256: undefined, lines: 3 });
  const text = renderLeadReview(redaction, second, { turn: 2, maxTurns: 3 });
  assert.match(text, /Spec: unchanged since review turn 1 \(sha256 [0-9a-f]{12}, 3 lines\)/);
  assert.ok(!text.includes("```ts"));
  const third = withSpecDigests([flow({ spec: "a\nb\nd" })], seen, 3);
  assert.equal(third[0]!.spec, "a\nb\nd");
  assert.equal(third[0]!.specUnchanged, undefined);
  assert.equal(withSpecDigests([flow({ spec: "a\nb\nd" })], seen, 4)[0]!.specUnchanged?.sinceTurn, 3, "the digest names the turn that last showed these bytes");
});

test("a spec the lead cannot be shown stays as it is: no digest for a flow with no spec", () => {
  assert.equal(withSpecDigests([flow({ spec: undefined })], new Map(), 1)[0]!.specUnchanged, undefined);
});
