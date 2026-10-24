import { test } from "node:test";
import assert from "node:assert/strict";
import { CORRECTION_ORIGIN, DEFAULT_CORRECTION_INSTRUCTION, admitLeadCorrection, flowOfFinding, renderLeadCorrection, type FlowUnderCorrection, type ReviewerFinding } from "@contexts/qa-run-orchestration/application/coordination/lead-correction.ts";
import { REVIEW_ACTION } from "@contexts/qa-run-orchestration/application/coordination/lead-review.ts";

const flows: FlowUnderCorrection[] = [
  { id: "cart", objective: "the cart total", specFile: "flows/cart.spec.ts", sessionOpen: true, spec: "test('total', ...)" },
  { id: "login", objective: "sign in works", specFile: "flows/login.spec.ts", sessionOpen: false },
];
const findings: ReviewerFinding[] = [
  { text: "the total is never asserted", spec: "e2e/flows/cart.spec.ts" },
  { text: "flows/login.spec.ts asserts only the URL" },
  { text: "a selector is a CSS class" },
];

test("a finding belongs to the flow whose spec its citation names, or failing that its text names, and to none otherwise", () => {
  assert.equal(flowOfFinding(findings[0]!, flows), "cart");
  assert.equal(flowOfFinding(findings[1]!, flows), "login");
  assert.equal(flowOfFinding(findings[2]!, flows), undefined);
  assert.equal(flowOfFinding({ text: "x", spec: "e2e/other.spec.ts" }, flows), undefined);
});

test("the prompt shows each flow with its own findings and lists the findings that cite no flow, numbered", () => {
  const text = renderLeadCorrection(flows, findings);
  assert.ok(text.includes("Flow `cart`") && text.includes("1. the total is never asserted"));
  assert.ok(text.includes("Flow `login`") && text.includes("2. flows/login.spec.ts asserts only the URL"));
  assert.ok(text.includes("3. a selector is a CSS class"));
});

test("the lead routes a loose finding to a flow, and a flow's own findings go with the order whatever the lead lists", () => {
  const answer = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [3], instruction: "assert the total" }] });
  const admitted = admitLeadCorrection(answer, flows, findings);
  assert.equal(admitted.readable, true);
  const cart = admitted.orders.find((o) => o.flowId === "cart")!;
  assert.deepEqual(cart.findings, ["the total is never asserted", "a selector is a CSS class"]);
  assert.equal(cart.instruction, "assert the total");
  assert.equal(cart.action, REVIEW_ACTION.REVISE);
  assert.deepEqual(admitted.unrouted, []);
});

test("a flow with findings the lead did not name is sent them with the orchestrator's instruction, and a closed session is replaced", () => {
  const admitted = admitLeadCorrection(JSON.stringify({ corrections: [] }), flows, findings);
  const login = admitted.orders.find((o) => o.flowId === "login")!;
  assert.deepEqual(login.findings, ["flows/login.spec.ts asserts only the URL"]);
  assert.equal(login.instruction, DEFAULT_CORRECTION_INSTRUCTION);
  assert.equal(login.action, REVIEW_ACTION.REPLACE, "its sidekick's session is gone");
  assert.deepEqual(admitted.unrouted, ["a selector is a CSS class"]);
});

test("a finding that cites one flow is never moved to another", () => {
  const answer = JSON.stringify({ corrections: [{ flow: "login", action: "revise", findings: [1], instruction: "x" }] });
  const admitted = admitLeadCorrection(answer, flows, findings);
  assert.deepEqual(admitted.orders.find((o) => o.flowId === "login")!.findings, ["flows/login.spec.ts asserts only the URL"]);
  assert.deepEqual(admitted.orders.find((o) => o.flowId === "cart")!.findings, ["the total is never asserted"]);
  assert.ok(admitted.refused.some((r) => r.flowId === "login" && r.finding === 1));
});

test("a rebutted finding is sent to nobody and comes back as the rebuttal the run checks; a rebuttal without its basis is not taken", () => {
  const answer = JSON.stringify({ rebuttals: [{ finding: 1, basis: "execution", ref: "cart › total", reason: "it passed" }, { finding: 2, basis: "opinion", ref: "x", reason: "y" }] });
  const admitted = admitLeadCorrection(answer, flows, findings);
  assert.deepEqual(admitted.rebuttals, [{ finding: "the total is never asserted", basis: "execution", ref: "cart › total", reason: "it passed" }]);
  assert.equal(admitted.orders.some((o) => o.flowId === "cart"), false);
  assert.ok(admitted.orders.some((o) => o.flowId === "login"));
});

test("an unreadable answer still sends each flow its own findings, and leaves the loose ones unrouted", () => {
  const admitted = admitLeadCorrection("I think it is fine", flows, findings);
  assert.equal(admitted.readable, false);
  assert.deepEqual(admitted.orders.map((o) => o.flowId).sort(), ["cart", "login"]);
  assert.deepEqual(admitted.unrouted, ["a selector is a CSS class"]);
});

test("a fact the run observed is corrected, never rebutted: the prompt offers no rebuttal and one the lead gives anyway is not taken", () => {
  const observed = [{ text: "test \"total\" in flows/cart.spec.ts failed: expected 3 rows", spec: "flows/cart.spec.ts" }];
  const text = renderLeadCorrection(flows, observed, CORRECTION_ORIGIN.EXECUTION);
  assert.ok(!text.includes('"rebuttals"'), "the answer it asks for has no rebuttals");
  const answer = JSON.stringify({ corrections: [], rebuttals: [{ finding: 1, basis: "execution", ref: "total", reason: "flaky DEV" }] });
  const admitted = admitLeadCorrection(answer, flows, observed, CORRECTION_ORIGIN.EXECUTION);
  assert.deepEqual(admitted.rebuttals, []);
  assert.deepEqual(admitted.orders.map((o) => [o.flowId, o.findings]), [["cart", [observed[0]!.text]]], "the flow is sent the failure all the same");
  assert.deepEqual(renderLeadCorrection(flows, findings), renderLeadCorrection(flows, findings, CORRECTION_ORIGIN.REVIEW), "the reviewer's findings are the default");
});
