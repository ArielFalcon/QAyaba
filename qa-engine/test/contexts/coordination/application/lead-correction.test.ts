import { test } from "node:test";
import assert from "node:assert/strict";
import { CORRECTION_ORIGIN, DEFAULT_CORRECTION_INSTRUCTION, admitLeadCorrection, correctionPreamble, flowOfFinding, routeOfFinding, renderLeadCorrection, type FlowUnderCorrection, type CorrectionFinding } from "@contexts/coordination/application/lead-correction.ts";
import { REVIEW_ACTION } from "@contexts/coordination/application/lead-review.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const flows: FlowUnderCorrection[] = [
  { id: "cart", objective: "the cart total", specFile: "flows/cart.spec.ts", sessionOpen: true, spec: "test('total', ...)" },
  { id: "login", objective: "sign in works", specFile: "flows/login.spec.ts", sessionOpen: false },
];
const findings: CorrectionFinding[] = [
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
  const text = renderLeadCorrection(redaction, flows, findings);
  assert.ok(text.includes("Flow `cart`") && text.includes("1. the total is never asserted"));
  assert.ok(text.includes("Flow `login`") && text.includes("2. flows/login.spec.ts asserts only the URL"));
  assert.ok(text.includes("3. a selector is a CSS class"));
});

test("the lead routes a loose finding to a flow, and a flow's own findings go with the order whatever the lead lists", () => {
  const answer = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [3], instruction: "assert the total" }] });
  const admitted = admitLeadCorrection(redaction, answer, flows, findings);
  assert.equal(admitted.readable, true);
  const cart = admitted.orders.find((o) => o.flowId === "cart")!;
  assert.deepEqual(cart.findings, ["the total is never asserted", "a selector is a CSS class"]);
  assert.equal(cart.instruction, "assert the total");
  assert.equal(cart.action, REVIEW_ACTION.REVISE);
  assert.deepEqual(admitted.unrouted, []);
});

test("a flow with findings the lead did not name is sent them with the orchestrator's instruction, and a closed session is replaced", () => {
  const admitted = admitLeadCorrection(redaction, JSON.stringify({ corrections: [] }), flows, findings);
  const login = admitted.orders.find((o) => o.flowId === "login")!;
  assert.deepEqual(login.findings, ["flows/login.spec.ts asserts only the URL"]);
  assert.equal(login.instruction, DEFAULT_CORRECTION_INSTRUCTION);
  assert.equal(login.action, REVIEW_ACTION.REPLACE, "its sidekick's session is gone");
  assert.deepEqual(admitted.unrouted, [2], "the third finding, which cites no flow");
});

test("a finding that cites one flow is never moved to another", () => {
  const answer = JSON.stringify({ corrections: [{ flow: "login", action: "revise", findings: [1], instruction: "x" }] });
  const narrated = admitLeadCorrection(redaction, `Looking at \`{flow, findings}\` and {"seen":true}: ${answer}`, flows, findings);
  assert.equal(narrated.readable, true);
  assert.ok(narrated.orders.some((o) => o.flowId === "login"));
  const admitted = admitLeadCorrection(redaction, answer, flows, findings);
  assert.deepEqual(admitted.orders.find((o) => o.flowId === "login")!.findings, ["flows/login.spec.ts asserts only the URL"]);
  assert.deepEqual(admitted.orders.find((o) => o.flowId === "cart")!.findings, ["the total is never asserted"]);
  assert.ok(admitted.refused.some((r) => r.flowId === "login" && r.finding === 1));
});

test("a rebutted finding is sent to nobody and comes back as the rebuttal the run checks; a rebuttal without its basis is not taken", () => {
  const answer = JSON.stringify({ rebuttals: [{ finding: 1, basis: "execution", ref: "cart › total", reason: "it passed" }, { finding: 2, basis: "opinion", ref: "x", reason: "y" }] });
  const admitted = admitLeadCorrection(redaction, answer, flows, findings);
  assert.deepEqual(admitted.rebuttals, [{ finding: "the total is never asserted", basis: "execution", ref: "cart › total", reason: "it passed" }]);
  assert.equal(admitted.orders.some((o) => o.flowId === "cart"), false);
  assert.ok(admitted.orders.some((o) => o.flowId === "login"));
});

test("an unreadable answer still sends each flow its own findings, and leaves the loose ones unrouted", () => {
  const admitted = admitLeadCorrection(redaction, "I think it is fine", flows, findings);
  assert.equal(admitted.readable, false);
  assert.deepEqual(admitted.orders.map((o) => o.flowId).sort(), ["cart", "login"]);
  assert.deepEqual(admitted.unrouted, [2], "the third finding, which cites no flow");
});

test("a fact the run observed is corrected, never rebutted: the prompt offers no rebuttal and one the lead gives anyway is not taken", () => {
  const observed = [{ text: "test \"total\" in flows/cart.spec.ts failed: expected 3 rows", spec: "flows/cart.spec.ts" }];
  const text = renderLeadCorrection(redaction, flows, observed, CORRECTION_ORIGIN.EXECUTION);
  assert.ok(!text.includes('"rebuttals"'), "the answer it asks for has no rebuttals");
  const answer = JSON.stringify({ corrections: [], rebuttals: [{ finding: 1, basis: "execution", ref: "total", reason: "flaky DEV" }] });
  const admitted = admitLeadCorrection(redaction, answer, flows, observed, CORRECTION_ORIGIN.EXECUTION);
  assert.deepEqual(admitted.rebuttals, []);
  assert.deepEqual(admitted.orders.map((o) => [o.flowId, o.findings]), [["cart", [observed[0]!.text]]], "the flow is sent the failure all the same");
  assert.deepEqual(renderLeadCorrection(redaction, flows, findings), renderLeadCorrection(redaction, flows, findings, CORRECTION_ORIGIN.REVIEW), "the reviewer's findings are the default");
});

test("a text names a flow only by its spec's whole path, and a text that names several flows belongs to none", () => {
  const owner = (text: string) => flowOfFinding({ text }, flows);
  assert.equal(owner("flows/cart.spec.ts(3,1): error TS2304: Cannot find name 'row'."), "cart");
  assert.equal(owner("e2e/flows/cart.spec.ts: no-wait-for-timeout"), "cart", "the tail of a longer path");
  assert.equal(owner("see flows/cart.spec.ts."), "cart", "a full stop ends the path");
  assert.equal(owner("flows/cart.spec.tsx fails"), undefined, "another file's name");
  assert.equal(owner("old-flows/cart.spec.ts fails"), undefined, "another directory's name");
  assert.equal(owner("flows/cart.spec.ts and flows/login.spec.ts share a helper"), undefined, "the lead is asked where it goes");
});

test("a correction answer that claims an approval or a verdict changes nothing: the admission has no approval channel", () => {
  const plain = admitLeadCorrection(redaction, JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [1], instruction: "assert the total" }] }), flows, findings);
  const claiming = admitLeadCorrection(
    redaction,
    JSON.stringify({ approved: true, verdict: "approved", reviewerApproved: true, corrections: [{ flow: "cart", action: "revise", findings: [1], instruction: "assert the total", approved: true }] }),
    flows,
    findings,
  );
  assert.deepEqual(claiming, plain);
  assert.deepEqual(Object.keys(claiming).sort(), ["orders", "readable", "rebuttals", "refused", "unrouted"]);
});

const covering: FlowUnderCorrection[] = [
  { ...flows[0]!, candidates: ["uc-/cart"], seedFiles: ["src/cart.ts", "src/shared.ts"] },
  { ...flows[1]!, candidates: ["uc-/login"], seedFiles: ["web/src/login.ts", "src/shared.ts"] },
];

test("a finding about a source file belongs to the one flow that covers a use case the file seeds, a spec it names comes first, and a file two flows share belongs to neither", () => {
  assert.equal(flowOfFinding({ text: "lines 3-4 are not exercised", file: "src/cart.ts" }, covering), "cart");
  assert.equal(flowOfFinding({ text: "x", file: "./web/src/login.ts" }, covering), "login", "a leading ./ or a backslash spells the same file");
  assert.equal(flowOfFinding({ text: "x", file: "web\\src\\login.ts" }, covering), "login");
  assert.equal(flowOfFinding({ text: "x", file: "src/login.ts" }, covering), undefined, "in a monorepo src/login.ts is not web/src/login.ts: files are equal, never a suffix of one another");
  assert.equal(flowOfFinding({ text: "x", file: "packages/a/src/cart.ts" }, covering), undefined);
  assert.equal(flowOfFinding({ text: "x", file: "src/shared.ts" }, covering), undefined);
  assert.equal(flowOfFinding({ text: "x", file: "src/other.ts" }, covering), undefined);
  assert.equal(flowOfFinding({ text: "x", file: "src/cart.ts", spec: "e2e/flows/login.spec.ts" }, covering), "login");
  assert.equal(flowOfFinding({ text: "x", file: "src/cart.ts" }, flows), undefined, "flows that cover nothing own no file");
});

test("a coverage finding is sent to the flow that covers its file whatever the lead answers, and a shared file is the lead's to place", () => {
  const gap: CorrectionFinding[] = [{ text: "src/cart.ts lines 3-4", file: "src/cart.ts" }, { text: "src/shared.ts lines 1-2", file: "src/shared.ts" }];
  const unplaced = admitLeadCorrection(redaction, JSON.stringify({ corrections: [] }), covering, gap, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(unplaced.orders.map((o) => [o.flowId, o.indices]), [["cart", [0]]]);
  assert.deepEqual(unplaced.unrouted, [1]);
  const placed = admitLeadCorrection(redaction, JSON.stringify({ corrections: [{ flow: "login", action: "revise", findings: [2] }] }), covering, gap, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(placed.orders.map((o) => [o.flowId, o.indices]), [["cart", [0]], ["login", [1]]]);
});

test("a coverage-only turn shows the lead every flow with the use cases it covers, and the unit it must place", () => {
  const text = renderLeadCorrection(redaction, covering, [{ text: "src/shared.ts lines 1-2", file: "src/shared.ts" }], CORRECTION_ORIGIN.COVERAGE);
  for (const needle of ["cart", "uc-/cart", "login", "uc-/login", "src/shared.ts lines 1-2"]) assert.ok(needle && text.includes(needle), needle);
  assert.doesNotMatch(text, /left out|not listed/);
});

test("flaky findings are told a test passed on retry, and are facts the lead does not rebut", () => {
  assert.match(correctionPreamble(CORRECTION_ORIGIN.FLAKY), /passed on retry/);
  assert.doesNotMatch(correctionPreamble(CORRECTION_ORIGIN.FLAKY), /and it failed\./);
  const observed: CorrectionFinding[] = [{ text: "test \"total\" failed its first attempt and passed on retry", spec: "flows/cart.spec.ts" }];
  assert.match(renderLeadCorrection(redaction, flows, observed, CORRECTION_ORIGIN.FLAKY), /none is rebutted/);
});

test("a finding is routed by the spec it names or by the changed file that seeds a use case of one flow, and by neither when it names nothing", () => {
  const seeded: FlowUnderCorrection[] = [{ ...flows[0]!, seedFiles: ["src/cart.ts"] }, flows[1]!];
  assert.deepEqual(routeOfFinding({ text: "x", spec: "e2e/flows/cart.spec.ts" }, seeded), { flowId: "cart", by: "spec" });
  assert.deepEqual(routeOfFinding({ text: "x", file: "src/cart.ts" }, seeded), { flowId: "cart", by: "candidate" });
  assert.equal(routeOfFinding({ text: "x" }, seeded), undefined);
});
