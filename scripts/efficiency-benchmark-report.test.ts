/* Comparing two labels' snapshots: efficiency numbers side by side, the guardrails that decide
   whether an efficiency gain was bought with quality, and an explicit line for every case. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIFF_TIER_NAMES } from "@contexts/generation/domain/diff-stat.ts";
import { compareSnapshots, renderReport, type CaseMeasurement, type EfficiencySnapshot, type TurnMeasurement } from "./efficiency-benchmark.ts";

const summary = (overrides: Partial<CaseMeasurement["coarse"]["firstPass"]> = {}) => ({
  totalCalls: 30, callsBeforeFirstWrite: 26, writeCount: 2, commandCount: 1, subagentCount: 0, repeatedCallCount: 3, ...overrides,
});

function measurement(overrides: { firstPass?: Partial<ReturnType<typeof summary>>; exhausted?: boolean | null; guardrails?: Partial<CaseMeasurement["guardrails"]> } = {}): CaseMeasurement {
  return {
    coarse: { firstPass: summary(overrides.firstPass), grounding: summary({ totalCalls: 0, callsBeforeFirstWrite: 0, writeCount: 0, commandCount: 0, repeatedCallCount: 0 }), wholeRunExcludingGrounding: summary({ totalCalls: 40 }) },
    exhausted: overrides.exhausted === undefined ? false : overrides.exhausted,
    guardrails: {
      verdict: "pass", specsProduced: 1, staticPass: true, executePass: true, coverageRatio: 0.8, reviewerApproved: true, errorClass: null,
      preExecAmbiguityCatches: null, deterministicSelectorBlocks: null, catalogGateFailClosed: null,
      ...overrides.guardrails,
    },
  };
}

const turn = (overrides: Partial<TurnMeasurement> = {}): TurnMeasurement => ({
  round: 0, promptBytes: 5000, totalCalls: 10, callsBeforeFirstWrite: 6, redundantReadCount: 2, promptProvidedReadCount: 1, pathProvidedReadCount: 3, codeRead: 4, memory: 2,
  stepsUsed: null, maxSteps: null, ...overrides,
});

const withTurns = (...turns: TurnMeasurement[]): CaseMeasurement => ({ ...measurement(), turns });

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

test("a run whose error class changed between the labels is called out with both classes, so a silent skip that became a loud infra-error shows", () => {
  const baseline = snapshot("baseline", { checkout: measurement({ guardrails: { verdict: "skipped", errorClass: null } }) });
  const after = snapshot("after", { checkout: measurement({ guardrails: { verdict: "infra-error", errorClass: "E-STEP-BUDGET" } }) });

  const comparison = compareSnapshots(baseline, after);
  assert.deepEqual(comparison.rows[0]!.guardrailChanges.sort(), ["errorClass", "verdict"]);
  const text = renderReport(comparison);
  assert.match(text, /error class none/);
  assert.match(text, /error class E-STEP-BUDGET/);
});

test("a snapshot taken before the error class was recorded reads as unknown, never as none, and is not called a change", () => {
  const legacy = measurement();
  delete (legacy.guardrails as Partial<CaseMeasurement["guardrails"]>).errorClass;
  const comparison = compareSnapshots(snapshot("a", { c: legacy }), snapshot("b", { c: measurement({ guardrails: { errorClass: "E-STEP-BUDGET" } }) }));
  const text = renderReport(comparison);
  assert.match(text, /error class unknown/);
  assert.doesNotMatch(text, /error class undefined/);
  assert.deepEqual(comparison.rows[0]!.guardrailChanges, [], "an unknown side is not evidence of a change");
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

test("per-turn figures are reported one line per turn, with the content-provided and path-provided reads apart", () => {
  const measuredTurns: CaseMeasurement = withTurns(
    turn(),
    turn({ round: 1, promptBytes: 4000, totalCalls: null, callsBeforeFirstWrite: null, redundantReadCount: null, promptProvidedReadCount: null, pathProvidedReadCount: null, codeRead: null, memory: null }),
  );
  const text = renderReport(compareSnapshots(snapshot("before", { checkout: measurement() }), snapshot("after", { checkout: measuredTurns })));
  const lines = text.split("\n").filter((l) => l.includes("turn round"));
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /round 0: prompt 5000 B · calls 10 · before 1st write 6 · redundant reads 2 · reads provided by content 1 · by path 3 · code reads 4 · memory 2/);
  assert.match(lines[1] ?? "", /round 1: prompt 4000 B · calls n\/a/, "an unrecorded figure reads as unknown, never as zero");
});

test("a snapshot taken before turns were measured renders exactly as it did, with no turn line", () => {
  const text = renderReport(compareSnapshots(snapshot("before", { checkout: measurement() }), snapshot("after", { checkout: measurement() })));
  assert.doesNotMatch(text, /turn round/);
});

/* ── steps used against the step limit ── */

const turnLines = (text: string): string[] => text.split("\n").filter((l) => l.includes("turn round"));
const caseTurns = (...pairs: Array<[stepsUsed: number | null, maxSteps: number | null]>): CaseMeasurement =>
  withTurns(...pairs.map(([stepsUsed, maxSteps], round) => turn({ round, stepsUsed, maxSteps })));

test("a turn's steps used, step limit and their ratio are reported, the ratio computed from the two", () => {
  const text = renderReport(compareSnapshots(
    snapshot("before", { checkout: measurement() }),
    snapshot("after", { checkout: caseTurns([12, 40], [40, 40]) }),
  ));
  const [first, second] = turnLines(text);
  assert.match(first ?? "", /steps used 12 · max steps 40 · step use 0\.30/);
  assert.match(second ?? "", /steps used 40 · max steps 40 · step use 1\.00/);
});

test("a turn with no steps used, or no step limit, reports its ratio as unknown, never as zero", () => {
  const text = renderReport(compareSnapshots(
    snapshot("before", { checkout: measurement() }),
    snapshot("after", { checkout: caseTurns([null, 40], [12, null], [null, null]) }),
  ));
  const [unobserved, unlimited, neither] = turnLines(text);
  assert.match(unobserved ?? "", /steps used n\/a · max steps 40 · step use n\/a/);
  assert.match(unlimited ?? "", /steps used 12 · max steps n\/a · step use n\/a/);
  assert.match(neither ?? "", /steps used n\/a · max steps n\/a · step use n\/a/);
  assert.doesNotMatch(text, /step use 0/);
});

test("a step limit that is not a positive whole number is no limit: the ratio is unknown, never infinite or negative", () => {
  for (const unusable of [0, -5, 2.5]) {
    const text = renderReport(compareSnapshots(snapshot("a", { c: measurement() }), snapshot("b", { c: caseTurns([5, unusable]) })));
    assert.match(turnLines(text)[0] ?? "", new RegExp(`steps used 5 · max steps ${unusable} · step use n/a`), `limit ${unusable}`);
    assert.doesNotMatch(text, /Infinity|NaN/);
  }
});

test("a snapshot taken before steps were recorded reads them as unknown, never as undefined or zero", () => {
  const legacyTurn: Partial<TurnMeasurement> = turn();
  delete legacyTurn.stepsUsed;
  delete legacyTurn.maxSteps;
  const text = renderReport(compareSnapshots(snapshot("a", { c: withTurns(legacyTurn as TurnMeasurement) }), snapshot("b", { c: measurement() })));
  assert.match(turnLines(text)[0] ?? "", /steps used n\/a · max steps n\/a · step use n\/a/);
  assert.doesNotMatch(text, /undefined/);
});

test("a label's step use is the mean of its turns' known ratios, and a turn with an unknown ratio is left out and counted, not averaged in as zero", () => {
  const baseline = snapshot("baseline", { a: caseTurns([10, 40], [30, 40], [null, 40], [12, null]) });
  const after = snapshot("after", { a: caseTurns([10, 40]) });

  const { stepUse } = compareSnapshots(baseline, after);

  assert.deepEqual([stepUse.a.meanRatio, stepUse.a.known, stepUse.a.unknown], [0.5, 2, 2]);
  assert.deepEqual([stepUse.b.meanRatio, stepUse.b.known, stepUse.b.unknown], [0.25, 1, 0]);
});

test("a label's step use spans all of its measured cases, and skips a case with no data or no turns without counting it", () => {
  const baseline = snapshot("baseline", { a: caseTurns([10, 40]), b: caseTurns([30, 40], [null, null]), pruned: null, bare: measurement() });

  const { stepUse } = compareSnapshots(baseline, snapshot("after", {}));

  assert.deepEqual([stepUse.a.meanRatio, stepUse.a.known, stepUse.a.unknown], [0.5, 2, 1]);
});

test("a label with no known ratio has an unknown step use, not a zero one", () => {
  const { stepUse } = compareSnapshots(
    snapshot("a", { c: caseTurns([null, 40], [5, null]) }),
    snapshot("b", { c: measurement() }),
  );

  assert.deepEqual([stepUse.a.meanRatio, stepUse.a.known, stepUse.a.unknown], [null, 0, 2]);
  assert.deepEqual([stepUse.b.meanRatio, stepUse.b.known, stepUse.b.unknown], [null, 0, 0]);
});

test("the report states each label's step use with the turns it counted and the turns it left out", () => {
  const text = renderReport(compareSnapshots(
    snapshot("baseline", { a: caseTurns([10, 40], [30, 40], [null, 40]) }),
    snapshot("after", { a: caseTurns([null, null]) }),
  ));
  const lines = text.split("\n");

  const baselineLine = lines.find((l) => l.includes("baseline") && l.includes("mean 0.50"));
  assert.match(baselineLine ?? "", /known 2/);
  assert.match(baselineLine ?? "", /unknown 1/);
  const afterLine = lines.find((l) => l.includes("after") && l.includes("mean n/a"));
  assert.match(afterLine ?? "", /known 0/);
  assert.match(afterLine ?? "", /unknown 1/);
});

/* ── the tier a case declares, and its sessions ── */

const [SMALLEST_TIER, MIDDLE_TIER] = DIFF_TIER_NAMES;

/** The snapshot with the tiers set on its entries as written, so a value no size class names can be planted. */
const declaring = (snap: EfficiencySnapshot, tiers: Record<string, unknown>): EfficiencySnapshot =>
  ({ ...snap, cases: Object.fromEntries(Object.entries(snap.cases).map(([name, entry]) => [name, name in tiers ? { ...entry, tier: tiers[name] } : entry])) }) as EfficiencySnapshot;

test("each label's block names the tier its case declared", () => {
  const text = renderReport(compareSnapshots(
    declaring(snapshot("baseline", { checkout: measurement() }), { checkout: SMALLEST_TIER }),
    declaring(snapshot("after", { checkout: measurement() }), { checkout: MIDDLE_TIER }),
  ));
  assert.match(text, new RegExp(`tier ${SMALLEST_TIER}`));
  assert.match(text, new RegExp(`tier ${MIDDLE_TIER}`));
  assert.doesNotMatch(text, /tier undeclared/);
});

test("a case that declares no tier, or one no size class names, reads as undeclared", () => {
  const text = renderReport(compareSnapshots(
    snapshot("baseline", { checkout: measurement() }),
    declaring(snapshot("after", { checkout: measurement() }), { checkout: "enormous" }),
  ));
  assert.equal(text.match(/tier undeclared/g)?.length, 2, "one for each label");
  assert.doesNotMatch(text, /enormous/);
});

test("a case's sessions are reported in total and for the generator, and unknown when the run recorded no turn", () => {
  const withSessions: CaseMeasurement = { ...measurement(), sessions: { total: 4, generator: 2 } };

  const text = renderReport(compareSnapshots(snapshot("a", { c: withSessions }), snapshot("b", { c: measurement() })));

  assert.match(text, /sessions total 4 · generator 2/);
  assert.match(text, /sessions n\/a/);
});

/* ── the gate-signal guardrails ── */

test("the three gate-signal guardrails are reported: the number for a signal that ran, n/a for one that never did", () => {
  const recorded = measurement({ guardrails: { preExecAmbiguityCatches: 2, deterministicSelectorBlocks: null, catalogGateFailClosed: 0 } });

  const text = renderReport(compareSnapshots(snapshot("a", { c: recorded }), snapshot("b", { c: recorded })));

  assert.match(text, /pre-exec ambiguity catches 2/);
  assert.match(text, /deterministic selector blocks n\/a/);
  assert.match(text, /catalog gate fail-closed 0/);
});

test("a gate-signal guardrail whose value differs between the labels is called out", () => {
  const comparison = compareSnapshots(
    snapshot("a", { c: measurement({ guardrails: { preExecAmbiguityCatches: 2, deterministicSelectorBlocks: 1, catalogGateFailClosed: 0 } }) }),
    snapshot("b", { c: measurement({ guardrails: { preExecAmbiguityCatches: 1, deterministicSelectorBlocks: 1, catalogGateFailClosed: 3 } }) }),
  );

  assert.deepEqual(comparison.rows[0]!.guardrailChanges.sort(), ["catalogGateFailClosed", "preExecAmbiguityCatches"]);
  assert.match(renderReport(comparison), /guardrails changed:.*preExecAmbiguityCatches/);
});

test("a snapshot taken before the gate signals were recorded reads them as n/a, never as undefined or zero, and is not called a change", () => {
  const legacy = measurement();
  for (const key of ["preExecAmbiguityCatches", "deterministicSelectorBlocks", "catalogGateFailClosed"] as const) {
    delete (legacy.guardrails as Partial<CaseMeasurement["guardrails"]>)[key];
  }

  const comparison = compareSnapshots(snapshot("a", { c: legacy }), snapshot("b", { c: measurement({ guardrails: { preExecAmbiguityCatches: 3 } }) }));
  const text = renderReport(comparison);

  assert.match(text, /pre-exec ambiguity catches n\/a/);
  assert.doesNotMatch(text, /undefined/);
  assert.deepEqual(comparison.rows[0]!.guardrailChanges, [], "an unknown side is not evidence of a change");
});
