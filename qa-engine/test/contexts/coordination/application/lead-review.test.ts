import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitLeadReview,
  changePagesOf,
  MAX_SPEC_CHARS,
  renderLeadReview,
  REVIEW_ACTION,
  type FlowUnderReview,
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
  const text = renderLeadReview(redaction, 
    [
      flow(),
      flow({ id: "login", objective: "sign in works", outcome: { id: "login", kind: FLOW_OUTCOME.FAILED, reason: "failed: the button never appeared" }, verified: false, runSpec: { calls: 3, maxCalls: 8, lastStatus: "failed", lastFailure: "locator('Sign in') not found on /login" }, spec: undefined, summary: "could not find the button", concerns: ["the page may differ on DEV"] }),
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

test("the change pages no flow visits and those no passing flow covers are named; a page a passing flow visits is not", () => {
  const pages = changePagesOf(["/cart", "/login", "/orders", "/shops/:city"], [
    { routes: ["/cart"], review: flow() },
    { routes: ["/login"], review: flow({ id: "login", verified: false, runSpec: { calls: 2, maxCalls: 8, lastStatus: "failed" } }) },
    { routes: ["/shops/madrid"], review: flow({ id: "shops", runSpec: undefined, verified: false }) },
  ]);
  assert.deepEqual(pages, { routes: ["/cart", "/login", "/orders", "/shops/:city"], unvisited: ["/orders"], unproven: ["/login"] });
});

test("with every change page covered by a passing flow, or no change pages, there is nothing to name", () => {
  assert.equal(changePagesOf(["/cart"], [{ routes: ["/cart"], review: flow() }]), undefined);
  assert.equal(changePagesOf([], [{ routes: ["/cart"], review: flow() }]), undefined);
});

test("the review names the change pages left unvisited and unproven, and without them says nothing of change pages", () => {
  const changePages = { routes: ["/cart", "/login", "/orders"], unvisited: ["/orders"], unproven: ["/login"] };
  const text = renderLeadReview(redaction, [flow()], { turn: 1, maxTurns: 3 }, changePages);
  assert.ok(text.includes("/orders") && text.includes("/login"));
  assert.ok(text.indexOf("/orders") !== text.indexOf("/login"));
  assert.ok(!renderLeadReview(redaction, [flow()], { turn: 1, maxTurns: 3 }).includes("/orders"));
});
