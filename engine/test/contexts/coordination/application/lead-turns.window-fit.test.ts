/*
 * No fixed character count cuts the spec a lead's review or correction turn shows it: the spec is whole while the prompt fits the
 * lead's window, and over it the specs give way as references (the spec file, its lines), the last flow's first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLeadReview, renderLeadReview, type FlowUnderReview } from "@contexts/coordination/application/lead-review.ts";
import { assembleLeadCorrection, renderLeadCorrection, type FlowUnderCorrection, type CorrectionFinding } from "@contexts/coordination/application/lead-correction.ts";
import { FLOW_OUTCOME } from "@contexts/coordination/application/flow-outcomes.ts";
import { WINDOW_FIT_REASON, type WindowFitOutcome } from "@kernel/prompt-sections.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const windowOf = (bytes: number) => (size: number): WindowFitOutcome => (size <= bytes ? "fits" : "over");
const roomy = windowOf(10_000_000);
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/* A spec well over the 8,000 characters a review used to be cut at, its last line distinct. */
const specOf = (name: string): string => `${"  await expect(page.getByRole('row')).toHaveCount(3);\n".repeat(220)}  await expect(page).toHaveURL('/${name}-done');\n`;

function flow(id: string, over: Partial<FlowUnderReview> = {}): FlowUnderReview {
  return {
    id,
    objective: `the ${id} flow`,
    acceptance: [],
    outcome: { id, kind: FLOW_OUTCOME.DELIVERED, specs: [`flows/${id}.spec.ts`] },
    answer: { kind: "read", concerns: [] },
    verified: true,
    sessionOpen: true,
    runSpec: { calls: 2, maxCalls: 8, lastStatus: "passed" },
    specFile: `flows/${id}.spec.ts`,
    spec: specOf(id),
    ...over,
  };
}

const turn = { turn: 1, maxTurns: 3 };

test("a long spec reaches the review whole, however long, while the window is unknown or holds it", () => {
  const flows = [flow("cart"), flow("login")];
  assert.ok(flows[0]!.spec!.length > 8_000);
  for (const text of [renderLeadReview(redaction, flows, turn), assembleLeadReview(redaction, flows, turn, undefined, roomy).text]) {
    assert.ok(text.includes("/cart-done") && text.includes("/login-done"));
    assert.doesNotMatch(text, /cut at \d+ characters/);
  }
});

test("a review over the lead's window shows the last flow's spec as a reference to its file first, and records it", () => {
  const flows = [flow("cart"), flow("login")];
  const whole = assembleLeadReview(redaction, flows, turn, undefined, roomy);
  const prompt = assembleLeadReview(redaction, flows, turn, undefined, windowOf(bytesOf(whole.text) - 3_000));
  assert.ok(prompt.text.includes("/cart-done"), "the first flow's spec is whole");
  assert.equal(prompt.text.includes("/login-done"), false, "the last flow's spec gave way");
  assert.match(prompt.text, /flows\/login\.spec\.ts \(222 line\(s\)\)[^\n]*not shown here, to fit the window/);
  assert.deepEqual(prompt.sectionItems["flows"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: 1 }]);
});

test("a review whose window holds nothing more still names every spec, never drops a flow", () => {
  const flows = [flow("cart"), flow("login")];
  const prompt = assembleLeadReview(redaction, flows, turn, undefined, windowOf(1));
  assert.equal(prompt.text.includes("-done"), false);
  for (const id of ["cart", "login"]) assert.ok(prompt.text.includes(`flows/${id}.spec.ts`));
});

const flowsToCorrect: FlowUnderCorrection[] = ["cart", "login"].map((id) => ({ id, objective: `the ${id} flow`, specFile: `flows/${id}.spec.ts`, sessionOpen: true, spec: specOf(id) }));
const findings: CorrectionFinding[] = flowsToCorrect.map((f) => ({ text: `${f.specFile} asserts only the URL`, spec: f.specFile }));

test("a long spec reaches the correction whole while the window holds it, and over it gives way as a reference, the last flow first", () => {
  assert.ok(renderLeadCorrection(redaction, flowsToCorrect, findings).includes("/login-done"));
  const whole = assembleLeadCorrection(redaction, flowsToCorrect, findings, undefined, roomy);
  assert.ok(whole.text.includes("/cart-done") && whole.text.includes("/login-done"));
  assert.doesNotMatch(whole.text, /cut at \d+ characters/);

  const prompt = assembleLeadCorrection(redaction, flowsToCorrect, findings, undefined, windowOf(bytesOf(whole.text) - 3_000));
  assert.ok(prompt.text.includes("/cart-done"));
  assert.equal(prompt.text.includes("/login-done"), false);
  assert.match(prompt.text, /flows\/login\.spec\.ts \(222 line\(s\)\)[^\n]*not shown here, to fit the window/);
  assert.deepEqual(prompt.sectionItems["flows"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: 1 }]);
});

test("a spec that fits is byte-identical whatever the window knows", () => {
  const flows = [flow("cart", { spec: "test('total', async () => {});" })];
  assert.equal(assembleLeadReview(redaction, flows, turn).text, assembleLeadReview(redaction, flows, turn, undefined, roomy).text);
  const under = [{ ...flowsToCorrect[0]!, spec: "test('total', ...)" }];
  assert.equal(assembleLeadCorrection(redaction, under, [findings[0]!]).text, assembleLeadCorrection(redaction, under, [findings[0]!], undefined, roomy).text);
});

/* A coverage gap: one unit per changed file, each text naming the lines no test ran. */
const gapFiles = Array.from({ length: 60 }, (_, i) => `src/area-${i}/module-${i}.ts`);
const gapUnits: CorrectionFinding[] = gapFiles.map((file, i) => ({ text: `changed lines NOT exercised by any test, by use case:\n  - ${file}: lines ${i + 1}-${i + 9}`, file }));
const placedFlows: FlowUnderCorrection[] = [
  { id: "cart", objective: "the cart flow", specFile: "flows/cart.spec.ts", sessionOpen: true, spec: specOf("cart"), candidates: ["uc-cart"], seedFiles: gapFiles.slice(0, 30) },
  { id: "login", objective: "the login flow", specFile: "flows/login.spec.ts", sessionOpen: true, spec: specOf("login"), candidates: ["uc-login"], seedFiles: gapFiles.slice(30, 40) },
];

test("every unit of a coverage gap reaches the lead whole while the lead's window holds it, however many the gap has", () => {
  const prompt = assembleLeadCorrection(redaction, placedFlows, gapUnits, "coverage", roomy);
  for (const [i, unit] of gapUnits.entries()) assert.ok(prompt.text.includes(`${i + 1}. ${unit.text}`), `unit ${i + 1}`);
  assert.doesNotMatch(prompt.text, /left out|not listed/);
});

test("over the lead's window the units no flow owns give way to the files they are about, every number still named and the omission recorded", () => {
  const whole = assembleLeadCorrection(redaction, [], gapUnits, "coverage", roomy);
  const prompt = assembleLeadCorrection(redaction, [], gapUnits, "coverage", windowOf(Math.floor(bytesOf(whole.text) * 0.7)));
  assert.equal(prompt.windowFit?.outcome, "fits");
  for (const file of gapFiles) assert.ok(prompt.text.includes(file), file);
  assert.doesNotMatch(prompt.text, /lines \d+-\d+/, "the units' own text is a reference now");
  assert.doesNotMatch(prompt.text, /left out|not corrected/);
  for (const number of [1, 17, 60]) assert.match(prompt.text, new RegExp(`\\b${number}\\b`));
  assert.deepEqual(prompt.sectionItems["unrouted"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: 60 }]);
});

test("a window that holds less still names every file of the gap with the findings it numbers, the findings of one file together", () => {
  const sharedFiles = gapUnits.map((unit, i) => ({ ...unit, file: gapFiles[i % 20]! }));
  const prompt = assembleLeadCorrection(redaction, [], sharedFiles, "coverage", windowOf(1));
  for (const file of gapFiles.slice(0, 20)) assert.ok(prompt.text.includes(file), file);
  assert.ok(prompt.text.includes(`${gapFiles[0]}: findings 1, 21, 41 (3)`));
  assert.ok(prompt.text.includes(`${gapFiles[19]}: findings 20, 40, 60 (3)`));
  assert.equal(prompt.windowFit?.degraded[0]?.step, 2);
});

test("a window that holds nothing more shows a flow's own units by file after its spec gave way, the findings still numbered under the flow", () => {
  const prompt = assembleLeadCorrection(redaction, placedFlows, gapUnits, "coverage", windowOf(1));
  assert.equal(prompt.text.includes("/cart-done"), false, "the spec gave way");
  for (const file of gapFiles.slice(0, 40)) assert.ok(prompt.text.includes(file), file);
  assert.deepEqual(prompt.windowFit?.degraded.map((d) => d.id), ["unrouted", "flows"]);
  assert.deepEqual(prompt.sectionItems["flows"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: 2 }, { class: "truncation", reason: WINDOW_FIT_REASON, count: 40 }]);
});
