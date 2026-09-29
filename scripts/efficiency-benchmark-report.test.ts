/* Comparing two labels' snapshots: efficiency numbers side by side, the guardrails that decide
   whether an efficiency gain was bought with quality, and an explicit line for every case. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSnapshots, renderReport, type CaseMeasurement, type EfficiencySnapshot } from "./efficiency-benchmark.ts";

const summary = (overrides: Partial<CaseMeasurement["coarse"]["firstPass"]> = {}) => ({
  totalCalls: 30, callsBeforeFirstWrite: 26, writeCount: 2, commandCount: 1, subagentCount: 0, repeatedCallCount: 3, ...overrides,
});

function measurement(overrides: { firstPass?: Partial<ReturnType<typeof summary>>; exhausted?: boolean | null; guardrails?: Partial<CaseMeasurement["guardrails"]> } = {}): CaseMeasurement {
  return {
    coarse: { firstPass: summary(overrides.firstPass), grounding: summary({ totalCalls: 0, callsBeforeFirstWrite: 0, writeCount: 0, commandCount: 0, repeatedCallCount: 0 }), wholeRunExcludingGrounding: summary({ totalCalls: 40 }) },
    exhausted: overrides.exhausted === undefined ? false : overrides.exhausted,
    guardrails: { verdict: "pass", specsProduced: 1, staticPass: true, executePass: true, coverageRatio: 0.8, reviewerApproved: true, ...overrides.guardrails },
  };
}

const snapshot = (label: string, cases: Record<string, CaseMeasurement | null>): EfficiencySnapshot => ({
  label,
  takenAt: "2026-09-28T12:00:00.000Z",
  cases: Object.fromEntries(Object.entries(cases).map(([name, data], i) => [name, { runId: `${label}-run-${i}`, data }])),
});

test("a case measured under both labels is compared side by side", () => {
  const baseline = snapshot("baseline", { checkout: measurement({ firstPass: { callsBeforeFirstWrite: 26 } }) });
  const after = snapshot("after", { checkout: measurement({ firstPass: { callsBeforeFirstWrite: 9 } }) });

  const { rows } = compareSnapshots(baseline, after);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.caseName, "checkout");
  assert.equal(rows[0]!.a.status, "measured");
  assert.equal(rows[0]!.b.status, "measured");
  const text = renderReport(compareSnapshots(baseline, after));
  assert.match(text, /checkout/);
  assert.match(text, /baseline/);
  assert.match(text, /after/);
  assert.match(text, /before 1st write 26/);
  assert.match(text, /before 1st write 9/);
});

test("a case one label has no data for is reported missing for that label, never omitted", () => {
  const baseline = snapshot("baseline", { checkout: measurement(), search: measurement() });
  const after = snapshot("after", { checkout: measurement() });

  const comparison = compareSnapshots(baseline, after);

  assert.deepEqual(comparison.rows.map((r) => r.caseName), ["checkout", "search"]);
  assert.equal(comparison.rows[1]!.b.status, "missing");
  assert.match(renderReport(comparison), /search[\s\S]*after[^\n]*missing/i);
});

test("a case whose runs' records were pruned (null data) is missing for that label", () => {
  const comparison = compareSnapshots(snapshot("baseline", { checkout: null }), snapshot("after", { checkout: measurement() }));
  assert.equal(comparison.rows[0]!.a.status, "missing");
  assert.equal(comparison.rows[0]!.b.status, "measured");
});

test("a case only the second label has is listed too, missing for the first", () => {
  const comparison = compareSnapshots(snapshot("baseline", {}), snapshot("after", { extra: measurement() }));
  assert.deepEqual(comparison.rows.map((r) => [r.caseName, r.a.status, r.b.status]), [["extra", "missing", "measured"]]);
});

test("guardrails that differ between the labels are called out", () => {
  const baseline = snapshot("baseline", { checkout: measurement({ guardrails: { verdict: "pass", specsProduced: 1 } }) });
  const after = snapshot("after", { checkout: measurement({ guardrails: { verdict: "skipped", specsProduced: 0 } }) });

  const [row] = compareSnapshots(baseline, after).rows;

  assert.deepEqual(row!.guardrailChanges.sort(), ["specsProduced", "verdict"]);
  const changedLine = renderReport(compareSnapshots(baseline, after)).split("\n").find((l) => l.includes("guardrails changed"));
  assert.ok(changedLine, "the report must call out the changed guardrails");
  assert.match(changedLine, /verdict/);
  assert.match(changedLine, /specsProduced/);
});

test("identical guardrails report no change", () => {
  const [row] = compareSnapshots(snapshot("a", { c: measurement() }), snapshot("b", { c: measurement() })).rows;
  assert.deepEqual(row!.guardrailChanges, []);
});

test("unknown values read as unknown, never as a zero: exhaustion for Codex and an unmeasured coverage", () => {
  const codexRun = measurement({ exhausted: null, guardrails: { coverageRatio: null, executePass: null, reviewerApproved: null } });
  const text = renderReport(compareSnapshots(snapshot("a", { c: codexRun }), snapshot("b", { c: codexRun })));
  assert.match(text, /step limit n\/a/);
  assert.match(text, /coverage unknown/);
  assert.match(text, /execute n\/a/);
});

test("a run that hit the step limit is reported as such", () => {
  const text = renderReport(compareSnapshots(snapshot("a", { c: measurement({ exhausted: true }) }), snapshot("b", { c: measurement({ exhausted: false }) })));
  assert.match(text, /step limit hit/);
  assert.match(text, /step limit not hit/);
});

/* The explorer's session is not observed, so its calls never reach the persisted run events: an empty
   grounding window means "not measured", never "the explorer made no calls". */
test("an empty grounding window reads as not measured, never as zero calls", () => {
  const text = renderReport(compareSnapshots(snapshot("a", { c: measurement() }), snapshot("b", { c: measurement() })));
  const groundingLine = text.split("\n").find((l) => l.trim().startsWith("grounding:"));
  assert.ok(groundingLine, "the report must say something about grounding");
  assert.match(groundingLine, /n\/a/);
  assert.match(groundingLine, /explorer unobserved/);
  assert.doesNotMatch(groundingLine, /calls 0/);
});

test("a grounding window that did record calls reports them", () => {
  const observed = measurement();
  observed.coarse.grounding = summary({ totalCalls: 7 });
  const text = renderReport(compareSnapshots(snapshot("a", { c: observed }), snapshot("b", { c: observed })));
  const groundingLine = text.split("\n").find((l) => l.trim().startsWith("grounding:"));
  assert.match(groundingLine!, /calls 7/);
});

test("a case whose run had not finished when the snapshot was taken says so instead of reading as pruned", () => {
  const baseline = snapshot("baseline", { checkout: measurement() });
  const after: EfficiencySnapshot = { label: "after", takenAt: "2026-09-28T12:00:00.000Z", cases: { checkout: { runId: "after-run-0", data: null, notFinished: true } } };

  const text = renderReport(compareSnapshots(baseline, after));

  assert.match(text, /after[^\n]*not finished/i);
  assert.doesNotMatch(text, /after[^\n]*no recorded data/i);
});
