import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRunReport, type ValueSignals, type RunReportInput } from "./value-report";
import { infraErrorGloss } from "./infra-error-gloss";

const baseSignals: ValueSignals = {
  coverageRatio: null,
  coverageMeasured: false,
  
  reviewerApproved: null,
};

test("renderRunReport: a fail run reads as a real bug found, distinct from an engine error", () => {
  const out = renderRunReport({ ...baseReport, verdict: "fail", passed: 0, failed: 1, signals: baseSignals });
  assert.match(out, /real bug|defect/i);
});

/* ── renderRunReport (default: plain, deterministic) ────────────────────────────── */

const baseReport: RunReportInput = {
  app: "petclinic",
  sha: "a1b2c3d4e5f6",
  mode: "diff",
  target: "e2e",
  shadow: true,
  verdict: "pass",
  passed: 3,
  failed: 0,
  specCount: 3,
  specNames: ["login", "add-owner", "add-pet"],
  signals: { coverageRatio: 0.82, coverageMeasured: true, coveragePolicy: "signal", reviewerApproved: true, reviewerRationale: "covers the new validation branch" },
  errorClass: null,
};

test("run report: an infra-error run is worded by the class that closed it, never as a DEV outage", () => {
  for (const errorClass of ["E-STEP-BUDGET", "E-TIME-BUDGET", "E-NO-DECISION", "E-INFRA"] as const) {
    const out = renderRunReport({ ...baseReport, verdict: "infra-error", passed: 0, failed: 0, specCount: 0, specNames: [], errorClass });
    assert.ok(out.includes(infraErrorGloss(errorClass)), errorClass);
    assert.doesNotMatch(out, /\bDEV\b/, errorClass);
  }
  const unclassified = renderRunReport({ ...baseReport, verdict: "infra-error", passed: 0, failed: 0, specCount: 0, specNames: [], errorClass: null });
  assert.ok(unclassified.includes(infraErrorGloss(null)));
});

test("run report: shadow green run frames the WOULD-do action and the value signals", () => {
  const out = renderRunReport(baseReport);
  assert.match(out, /run value report .* petclinic @ a1b2c3d4e/);
  assert.match(out, /✓ PASS/);
  assert.match(out, /3 passed · 0 failed/);
  assert.match(out, /SHADOW \(preview — no PR\/Issue\)/);
  assert.match(out, /action\s+would open an auto-merge suite PR/);
  assert.match(out, /produced\s+3 specs · login, add-owner, add-pet/);
  assert.match(out, /change-cov\s+82%\s+signal · measured/);
  assert.ok(!/oracle/.test(out), "the report has no oracle row");
  assert.match(out, /reviewer\s+approved · covers the new validation branch/);
});

test("run report: default output is plain (no ANSI escapes) so pipes/redirects stay clean", () => {
  const out = renderRunReport(baseReport);
  assert.ok(!out.includes("\x1b["), "default render must contain no ANSI escape codes");
});

test("run report: color mode wraps the verdict in ANSI (matches the TUI palette)", () => {
  const out = renderRunReport(baseReport, { color: true });
  assert.ok(out.includes("\x1b["), "color render must contain ANSI escape codes");
  assert.match(out, /\x1b\[38;5;42m/); /* green — the pass/approved color */
});

test("run report: reviewer rejection surfaces the rationale (the keystone publish gate's reason)", () => {
  const out = renderRunReport({ ...baseReport, signals: { ...baseReport.signals, reviewerApproved: false, reviewerRationale: "assertions do not check the persisted owner" } });
  assert.match(out, /reviewer\s+rejected · assertions do not check the persisted owner/);
  assert.match(out, /action\s+would file an Issue \(the reviewer rejected the suite\)/);
});

test("run report: unmeasured coverage reads as 'not measured', never a false 0%", () => {
  const out = renderRunReport({ ...baseReport, signals: { ...baseReport.signals, coverageMeasured: false, coverageRatio: null } });
  assert.match(out, /change-cov\s+not measured \(unknown/);
  assert.ok(!/change-cov\s+0%/.test(out));
});

test("run report: non-shadow run says what it DID", () => {
  const out = renderRunReport({ ...baseReport, shadow: false });
  assert.ok(!out.includes("SHADOW"));
  assert.match(out, /action\s+open an auto-merge suite PR/);
});

test("run report: a skipped run carries no specs and no side effect", () => {
  const out = renderRunReport({ ...baseReport, verdict: "skipped", passed: 0, failed: 0, specCount: 0, specNames: [], signals: baseSignals });
  assert.match(out, /produced\s+no new specs/);
  assert.match(out, /action\s+would skip the commit \(no test-worthy change\)/);
  assert.match(out, /• SKIPPED/);
});

/* The action row of every verdict, as the operator reads it, word for word: what the run did, or would do in shadow mode. */
const ACTION_ROWS: ReadonlyArray<[RunReportInput["verdict"], boolean | null, string]> = [
  ["pass", true, "open an auto-merge suite PR with the new tests"],
  ["pass", null, "open an auto-merge suite PR with the new tests"],
  ["pass", false, "file an Issue (the reviewer rejected the suite)"],
  ["fail", null, "file an Issue — a real bug was found (the run succeeded)"],
  ["fail", false, "file an Issue — a real bug was found (the run succeeded)"],
  ["invalid", null, "file an Issue (the generated specs failed the static gate)"],
  ["flaky", true, "quarantine the flaky case (no PR, no Issue)"],
  ["infra-error", null, "treat the run as inconclusive (infrastructure, not a code bug)"],
  ["skipped", null, "skip the commit (no test-worthy change)"],
];

for (const [verdict, reviewerApproved, action] of ACTION_ROWS) {
  test(`the action row of a ${verdict} run (reviewer ${String(reviewerApproved)}) says what the run did, and in shadow mode what it would do`, () => {
    const actionRow = (shadow: boolean): string | undefined =>
      renderRunReport({ ...baseReport, verdict, shadow, signals: { ...baseSignals, reviewerApproved } }).split("\n").find((line) => line.trimStart().startsWith("action"));
    assert.equal(actionRow(false), `  ${"action".padEnd(12)}${action}`);
    assert.equal(actionRow(true), `  ${"action".padEnd(12)}would ${action}`);
  });
}
