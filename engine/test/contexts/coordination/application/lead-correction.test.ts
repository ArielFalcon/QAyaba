import { test } from "node:test";
import assert from "node:assert/strict";
import { CORRECTION_ORIGIN, DEFAULT_CORRECTION_INSTRUCTION, admitLeadCorrection, correctionPreamble, flowOfFinding, routeOfFinding, routesOfFindings, renderLeadCorrection, type FlowUnderCorrection, type CorrectionFinding } from "@contexts/coordination/application/lead-correction.ts";
import { REVIEW_ACTION } from "@contexts/coordination/application/lead-review.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const flows: FlowUnderCorrection[] = [
  { id: "cart", objective: "the cart total", specFile: "flows/cart.spec.ts", sessionOpen: true, spec: "test('total', ...)" },
  { id: "login", objective: "sign in works", specFile: "flows/login.spec.ts", sessionOpen: false },
];
const findings: CorrectionFinding[] = [
  { id: "F1", text: "the total is never asserted", spec: "e2e/flows/cart.spec.ts" },
  { id: "F2", text: "flows/login.spec.ts asserts only the URL" },
  { id: "F3", text: "a selector is a CSS class" },
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

test("a correction whose closing answer does not read is unreadable, never the earlier draft", () => {
  const draft = JSON.stringify({ corrections: [{ flow: "login", action: "revise", findings: [1], instruction: "draft" }] });
  const final = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [2], instruction: "final" }] });
  for (const closing of [`${final.slice(0, -1)},}`, final.slice(0, Math.floor(final.length / 2)), `${final}\n{"note":1}`]) {
    const admitted = admitLeadCorrection(redaction, `Draft: ${draft}\nRevised: ${closing}`, flows, findings);
    assert.equal(admitted.readable, false, closing);
    assert.equal(admitted.orders.some((o) => o.instruction === "draft"), false, closing);
  }
});

test("a rebutted finding is sent to nobody and comes back as the rebuttal the run checks; a rebuttal without its basis is not taken", () => {
  const answer = JSON.stringify({ rebuttals: [{ finding: 1, basis: "execution", ref: "cart › total", reason: "it passed" }, { finding: 2, basis: "opinion", ref: "x", reason: "y" }] });
  const admitted = admitLeadCorrection(redaction, answer, flows, findings);
  assert.deepEqual(admitted.rebuttals, [{ findingId: "F1", finding: "the total is never asserted", basis: "execution", ref: "cart › total", reason: "it passed" }]);
  assert.equal(admitted.orders.some((o) => o.flowId === "cart"), false);
  assert.ok(admitted.orders.some((o) => o.flowId === "login"));
});

test("a rebuttal by number names the finding at that number by its id, whatever text another finding shares", () => {
  const same = "the test asserts only that the page loaded";
  const twins: CorrectionFinding[] = [{ id: "F1", text: same, spec: "flows/cart.spec.ts" }, { id: "F2", text: same, spec: "flows/login.spec.ts" }];
  const answer = JSON.stringify({ rebuttals: [{ finding: 2, basis: "execution", ref: "flows/login.spec.ts", reason: "it ran green" }] });
  const admitted = admitLeadCorrection(redaction, answer, flows, twins);
  assert.deepEqual(admitted.rebuttals.map((r) => r.findingId), ["F2"]);
  assert.deepEqual(admitted.orders.map((o) => ({ flowId: o.flowId, indices: o.indices })), [{ flowId: "cart", indices: [0] }], "the twin the lead did not rebut still goes to its own flow");
});

test("a rebuttal of a finding that carries no id is an unreadable entry, never matched by the finding's text", () => {
  const answer = JSON.stringify({ rebuttals: [{ finding: 1, basis: "execution", ref: "cart › total", reason: "it passed" }] });
  const admitted = admitLeadCorrection(redaction, answer, flows, [{ text: "the total is never asserted", spec: "flows/cart.spec.ts" }]);
  assert.deepEqual(admitted.rebuttals, []);
  assert.deepEqual(admitted.unreadable.map((u) => u.where), ["rebuttals[0]"]);
  assert.deepEqual(admitted.orders.map((o) => o.flowId), ["cart"], "the finding stands and goes to its flow");
});

test("an order whose action is neither revise nor replace is unreadable and is never read as a revise", () => {
  const answer = JSON.stringify({ corrections: [{ flow: "cart", action: "accept", findings: [3], instruction: "assert the total" }, { flow: "ghost", action: "revise", findings: [1] }, { flow: "cart", findings: [3] }] });
  const admitted = admitLeadCorrection(redaction, answer, flows, findings);
  assert.deepEqual(admitted.unreadable.map((u) => u.where), ["corrections[0]", "corrections[1]", "corrections[2]"]);
  assert.match(admitted.unreadable[0]!.reason, /accept/);
  const cart = admitted.orders.find((o) => o.flowId === "cart")!;
  assert.equal(cart.instruction, DEFAULT_CORRECTION_INSTRUCTION, "the lead's instruction of an entry it could not read is not carried");
  assert.deepEqual(cart.findings, ["the total is never asserted"], "the finding that entry would have moved stays unrouted");
  assert.deepEqual(admitted.unrouted, [2]);
});

test("a finding number that is not a finding of the turn, and a rebuttal the engine cannot read, are unreadable parts of an answer that otherwise stands", () => {
  const answer = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [3, 9, "two"], instruction: "assert the total" }], rebuttals: [{ finding: 1, basis: "opinion", ref: "x", reason: "y" }, "no"] });
  const admitted = admitLeadCorrection(redaction, answer, flows, findings);
  assert.deepEqual(admitted.unreadable.map((u) => u.where).sort(), ["corrections[0].findings[1]", "corrections[0].findings[2]", "rebuttals[0]", "rebuttals[1]"]);
  assert.equal(admitted.orders.find((o) => o.flowId === "cart")!.instruction, "assert the total");
  assert.deepEqual(admitted.rebuttals, []);
});

test("a correction answer that reads whole has nothing unreadable, and one that cannot be read at all says so", () => {
  const whole = admitLeadCorrection(redaction, JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [3], instruction: "x" }] }), flows, findings);
  assert.deepEqual(whole.unreadable, []);
  const none = admitLeadCorrection(redaction, "I think it is fine", flows, findings);
  assert.deepEqual(none.unreadable.map((u) => u.where), ["answer"]);
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
  assert.deepEqual(Object.keys(claiming).sort(), ["orders", "readable", "rebuttals", "refused", "unreadable", "unrouted"]);
});

const covering: FlowUnderCorrection[] = [
  { ...flows[0]!, candidates: ["uc-/cart"], seedFiles: ["src/cart.ts", "src/shared.ts"] },
  { ...flows[1]!, candidates: ["uc-/login"], seedFiles: ["web/src/login.ts", "src/shared.ts"] },
];

test("a finding about a source file belongs to the one flow that covers a use case the file seeds, and a spec it names comes first", () => {
  assert.equal(flowOfFinding({ text: "lines 3-4 are not exercised", file: "src/cart.ts" }, covering), "cart");
  assert.equal(flowOfFinding({ text: "x", file: "./web/src/login.ts" }, covering), "login", "a leading ./ or a backslash spells the same file");
  assert.equal(flowOfFinding({ text: "x", file: "web\\src\\login.ts" }, covering), "login");
  assert.equal(flowOfFinding({ text: "x", file: "src/login.ts" }, covering), undefined, "in a monorepo src/login.ts is not web/src/login.ts: files are equal, never a suffix of one another");
  assert.equal(flowOfFinding({ text: "x", file: "packages/a/src/cart.ts" }, covering), undefined);
  assert.equal(flowOfFinding({ text: "x", file: "src/other.ts" }, covering), undefined);
  assert.equal(flowOfFinding({ text: "x", file: "src/cart.ts", spec: "e2e/flows/login.spec.ts" }, covering), "login");
  assert.equal(flowOfFinding({ text: "x", file: "src/cart.ts" }, flows), undefined, "flows that cover nothing own no file");
});

test("a file that seeds use cases of several flows belongs to the one that the file seeds directly, else to the first in plan order", () => {
  assert.equal(flowOfFinding({ text: "x", file: "src/shared.ts" }, covering), "cart", "neither seeds it directly: the first flow of the plan");
  const direct: FlowUnderCorrection[] = [{ ...covering[0]! }, { ...covering[1]!, directSeedFiles: ["src/shared.ts"] }];
  assert.deepEqual(routeOfFinding({ text: "x", file: "src/shared.ts" }, direct), { flowId: "login", by: "candidate" }, "the flow whose use case holds it as its own seed, not as a hub's code");
  assert.deepEqual(routeOfFinding({ text: "x", file: "./src\\shared.ts" }, direct), { flowId: "login", by: "candidate" });
});

test("a coverage finding the lead says nothing about goes to the one flow that owns its file, a shared file included", () => {
  const gap: CorrectionFinding[] = [{ text: "src/cart.ts lines 3-4", file: "src/cart.ts" }, { text: "src/shared.ts lines 1-2", file: "src/shared.ts" }];
  const unplaced = admitLeadCorrection(redaction, JSON.stringify({ corrections: [] }), covering, gap, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(unplaced.orders.map((o) => [o.flowId, o.indices]), [["cart", [0, 1]]]);
  assert.deepEqual(unplaced.unrouted, []);
});

test("the lead may give a finding about a file several flows hold to any of them, and it then reaches that flow alone", () => {
  const gap: CorrectionFinding[] = [{ text: "src/cart.ts lines 3-4", file: "src/cart.ts" }, { text: "src/shared.ts lines 1-2", file: "src/shared.ts" }];
  const moved = admitLeadCorrection(redaction, JSON.stringify({ corrections: [{ flow: "login", action: "revise", findings: [2] }] }), covering, gap, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(moved.orders.map((o) => [o.flowId, o.indices]), [["cart", [0]], ["login", [1]]], "the lead's order replaces the default owner");
  assert.deepEqual([moved.refused, moved.unrouted], [[], []]);
  const twice = admitLeadCorrection(redaction, JSON.stringify({ corrections: [{ flow: "login", action: "revise", findings: [2] }, { flow: "cart", action: "revise", findings: [1, 2] }] }), covering, gap, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(twice.orders.map((o) => [o.flowId, o.indices]), [["cart", [0]], ["login", [1]]], "the first order that takes it holds it");
  assert.match(twice.refused.find((r) => r.flowId === "cart" && r.finding === 2)!.reason, /flow login/);
});

test("the lead cannot give a finding about a file to a flow that does not hold the file: it stays with the flow that does", () => {
  const gap: CorrectionFinding[] = [{ text: "src/cart.ts lines 3-4", file: "src/cart.ts" }];
  const refused = admitLeadCorrection(redaction, JSON.stringify({ corrections: [{ flow: "login", action: "revise", findings: [1] }] }), covering, gap, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(refused.orders.map((o) => [o.flowId, o.indices]), [["cart", [0]]]);
  assert.match(refused.refused.find((r) => r.finding === 1)!.reason, /stays with flow cart/);
});

test("a file several flows hold goes by default to the flow whose spec's coverage ran it, then to the one whose use case it seeds directly, then to the first in plan order", () => {
  const direct: FlowUnderCorrection[] = [{ ...covering[0]! }, { ...covering[1]!, directSeedFiles: ["src/shared.ts"] }];
  assert.equal(flowOfFinding({ text: "x", file: "src/shared.ts", ranBy: ["flows/cart.spec.ts"] }, direct), "cart", "what the run executed over the seeds");
  assert.equal(flowOfFinding({ text: "x", file: "src/shared.ts", ranBy: ["flows/orders.spec.ts"] }, direct), "login", "a spec of no flow that holds the file is no evidence for one");
  assert.equal(flowOfFinding({ text: "x", file: "src/shared.ts", ranBy: ["flows/cart.spec.ts", "flows/login.spec.ts"] }, direct), "cart", "both ran it: a measured fact outranks the seeds, and the tie goes by spec path");
  assert.equal(flowOfFinding({ text: "x", file: "src/shared.ts", ranBy: ["flows/login.spec.ts"] }, covering), "login");
  assert.equal(flowOfFinding({ text: "x", file: "src/other.ts", ranBy: ["flows/cart.spec.ts"] }, covering), "cart", "the flow whose spec ran it owns it, whatever it seeds");
  assert.equal(flowOfFinding({ text: "x", file: "src/shared.ts", spec: "flows/login.spec.ts", ranBy: ["flows/cart.spec.ts"] }, covering), "login", "the spec it cites comes first");
});

test("the prompt names every flow that holds a shared file's finding, so the lead can give it to another of them", () => {
  const text = renderLeadCorrection(redaction, covering, [{ text: "src/shared.ts lines 1-2", file: "src/shared.ts" }, { text: "src/cart.ts lines 3-4", file: "src/cart.ts" }], CORRECTION_ORIGIN.COVERAGE);
  assert.match(text, /^- 1: .*`cart`.*`login`/m);
  assert.doesNotMatch(text, /^- 2: /m, "a file one flow holds is not offered elsewhere");
});

test("a coverage-only turn shows the lead every flow with the use cases it covers, and the unit it must place", () => {
  const text = renderLeadCorrection(redaction, covering, [{ text: "src/other.ts lines 1-2", file: "src/other.ts" }], CORRECTION_ORIGIN.COVERAGE);
  for (const needle of ["cart", "uc-/cart", "login", "uc-/login", "src/other.ts lines 1-2"]) assert.ok(needle && text.includes(needle), needle);
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

/* ── one ownership rule: the spec that evaluated it, then the least loaded, then the static route ─────── */

const trio: FlowUnderCorrection[] = [
  { id: "alpha", objective: "a", specFile: "flows/alpha.spec.ts", sessionOpen: true, seedFiles: ["src/hub.ts"], candidates: ["uc-a"] },
  { id: "beta", objective: "b", specFile: "flows/beta.spec.ts", sessionOpen: true, seedFiles: ["src/hub.ts"], candidates: ["uc-b"] },
  { id: "gamma", objective: "c", specFile: "flows/gamma.spec.ts", sessionOpen: true, seedFiles: ["src/hub.ts"], candidates: ["uc-c"] },
];
const evaluated = (line: number, ...ranBy: string[]): CorrectionFinding => ({ text: `decision ${line}`, file: "src/hub.ts", line, ranBy });
const assignment = (found: readonly CorrectionFinding[], plan: readonly FlowUnderCorrection[]) => routesOfFindings(found, plan).map((r) => r?.flowId);

test("a finding goes to the flow whose spec evaluated its decision although an earlier flow of the plan also seeds the file", () => {
  assert.deepEqual(routeOfFinding(evaluated(7, "flows/beta.spec.ts"), trio), { flowId: "beta", by: "evaluator" });
  assert.deepEqual(routeOfFinding(evaluated(7, "flows/gamma.spec.ts"), trio), { flowId: "gamma", by: "evaluator" });
});

test("findings several specs evaluated are spread over those flows by the fewest findings held, then by spec path, whatever the order of the flows array", () => {
  const found = [1, 2, 3, 4, 5].map((line) => evaluated(line, "flows/gamma.spec.ts", "flows/alpha.spec.ts"));
  const plans = [trio, [...trio].reverse(), [trio[1]!, trio[2]!, trio[0]!]];

  for (const plan of plans) assert.deepEqual(assignment(found, plan), ["alpha", "gamma", "alpha", "gamma", "alpha"]);
});

test("the load that spreads findings counts every finding the turn already gave a flow, whatever fact gave it", () => {
  const cited: CorrectionFinding[] = [1, 2, 3].map((n) => ({ text: `cart ${n}`, spec: "flows/alpha.spec.ts" }));
  const found = [...cited, evaluated(4, "flows/alpha.spec.ts", "flows/beta.spec.ts"), evaluated(5, "flows/alpha.spec.ts", "flows/beta.spec.ts")];

  assert.deepEqual(assignment(found, trio), ["alpha", "alpha", "alpha", "beta", "beta"]);
  assert.deepEqual(assignment(found, [...trio].reverse()), ["alpha", "alpha", "alpha", "beta", "beta"]);
});

test("a spec spelled differently from the flow's own still counts as evaluating, and a spec of no flow of the pass evaluates for none: the static route stands", () => {
  assert.equal(flowOfFinding(evaluated(3, "e2e/flows/beta.spec.ts"), trio), "beta");
  const direct: FlowUnderCorrection[] = [trio[0]!, { ...trio[1]!, directSeedFiles: ["src/hub.ts"] }, trio[2]!];
  assert.deepEqual(routeOfFinding(evaluated(3, "flows/elsewhere.spec.ts"), direct), { flowId: "beta", by: "candidate" });
  assert.deepEqual(routeOfFinding({ text: "x", file: "src/hub.ts", line: 3, ranBy: [] }, trio), { flowId: "alpha", by: "candidate" }, "never evaluated: today's static route, first of the plan");
});

test("a finding that cites or names a spec stays with it whatever ran the decision", () => {
  assert.deepEqual(routeOfFinding({ ...evaluated(3, "flows/beta.spec.ts"), spec: "flows/gamma.spec.ts" }, trio), { flowId: "gamma", by: "spec" });
  assert.deepEqual(routeOfFinding({ ...evaluated(3, "flows/beta.spec.ts"), text: "see flows/alpha.spec.ts" }, trio), { flowId: "alpha", by: "spec" });
});

test("the lead may still give an evaluated finding to a flow that evaluated it or holds the file, and the admission sends the default owner's findings to it", () => {
  const found = [evaluated(1, "flows/beta.spec.ts"), evaluated(2, "flows/beta.spec.ts")];
  const unplaced = admitLeadCorrection(redaction, JSON.stringify({ corrections: [] }), trio, found, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(unplaced.orders.map((o) => [o.flowId, o.indices]), [["beta", [0, 1]]]);

  const moved = admitLeadCorrection(redaction, JSON.stringify({ corrections: [{ flow: "gamma", action: "revise", findings: [2] }] }), trio, found, CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(moved.orders.map((o) => [o.flowId, o.indices]), [["beta", [0]], ["gamma", [1]]]);
  assert.deepEqual(moved.refused, []);
});

test("the prompt lists a finding evaluated by one flow under it and offers it to the other holders of the file", () => {
  const text = renderLeadCorrection(redaction, trio, [evaluated(1, "flows/beta.spec.ts")], CORRECTION_ORIGIN.COVERAGE);
  assert.match(text, /### Flow `beta`[\s\S]*decision 1/);
  assert.match(text, /^- 1: .*`alpha`.*`beta`.*`gamma`/m);
});
