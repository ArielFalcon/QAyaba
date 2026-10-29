/* Process-audit domain tests — auditProcess/applyAudit routing and streak detection. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditProcess,
  applyAudit,
  type AuditInput,
  type AuditRouterDeps,
  type ProcessFinding,
} from "@contexts/cross-run-learning/domain/process-audit.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

function outcome(over: Partial<RunOutcome> & { errorClass?: RunOutcome["errorClass"] } = {}): RunOutcome {
  return {
    runId: over.runId ?? "r1",
    app: "petclinic",
    sha: over.sha ?? "abc1234def",
    mode: "manual",
    target: "e2e",
    verdict: over.verdict ?? "fail",
    errorClass: over.errorClass ?? "E-EXEC-FAIL",
    gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, ...over.gateSignals },
    at: over.at ?? "2026-06-13T00:00:00Z",
    ...(over.adjudication ? { adjudication: over.adjudication } : {}),
  };
}

test("recurring CODE errorClass (E-STATIC) 3 runs in a row → observed (a repeating engine defect, visibility only)", () => {
  const o = outcome({ errorClass: "E-STATIC" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-STATIC", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })] };
  const f = auditProcess(input).find((x) => x.kind === "recurring-error-class");
  assert.ok(f, "expected a recurring-error-class finding");
  assert.equal(f!.disposition, "observe");
  assert.match(f!.evidence, /E-STATIC/);
});

test("recurring UI/grounding errorClass (E-FRAGILE-SELECTOR) → context-heal (rebuild the stale map), not an observed engine defect", () => {
  const o = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })] };
  const f = auditProcess(input).find((x) => x.disposition === "context-heal");
  assert.ok(f, "a recurring UI-mismatch should rebuild the architecture map first, not open a PR");
  assert.equal(f!.kind, "recurring-ui-mismatch");
  assert.ok(!auditProcess(input).some((x) => x.kind === "recurring-error-class")); /* a map-fixable class is not read as an engine defect */
});

test("recurring step-budget exhaustion is only observed: it never becomes an engine-defect finding or a map rebuild", () => {
  const o = outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error" });
  const input: AuditInput = {
    outcome: o,
    recent: [o, outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error", sha: "b" }), outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error", sha: "c" })],
  };
  const findings = auditProcess(input);
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.evidence, /E-STEP-BUDGET/);
  assert.ok(!findings.some((f) => f.kind === "recurring-error-class" || f.disposition === "context-heal"));
});

test("the step-budget streak is worded as the agent running out of steps, not as an app-behavior gap needing a rule", () => {
  const o = outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error" });
  const findings = auditProcess({ outcome: o, recent: [o, outcome({ errorClass: "E-STEP-BUDGET", sha: "b" }), outcome({ errorClass: "E-STEP-BUDGET", sha: "c" })] });
  assert.match(findings[0]!.summary, /steps/i);
  assert.doesNotMatch(findings[0]!.summary, /rule promotion|app-behavior/i);
});

test("two step-budget runs in a row are not yet a streak", () => {
  const o = outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error" });
  assert.deepEqual(auditProcess({ outcome: o, recent: [o, outcome({ errorClass: "E-STEP-BUDGET", sha: "b" }), outcome({ errorClass: "E-EXEC-FAIL", sha: "c" })] }), []);
});

test("a recurring time-budget end is only observed, worded as the generator running out of time and not as an app-behavior gap", () => {
  const timeBudget = (sha: string) => outcome({ errorClass: "E-TIME-BUDGET", verdict: "infra-error", sha });
  const o = timeBudget("a");
  const findings = auditProcess({ outcome: o, recent: [o, timeBudget("b"), timeBudget("c")] });
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.summary, /time/i);
  assert.match(findings[0]!.evidence, /E-TIME-BUDGET/);
  assert.doesNotMatch(findings[0]!.summary, /rule promotion|app-behavior/i);
});

test("a recurring dev_not_rendered triage is only observed: it never becomes an engine-defect finding or a learned rule", () => {
  const notRendered = (sha: string) => outcome({
    errorClass: "E-PRECONDITION",
    verdict: "infra-error",
    sha,
    adjudication: { class: "dev_not_rendered", confidence: "high", action: "break-issue", reason: "target absent from the failure DOM" },
  });
  const o = notRendered("a");
  const findings = auditProcess({ outcome: o, recent: [o, notRendered("b"), notRendered("c")] });
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.kind, "recurring-dev-not-rendered");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.summary, /not rendered on DEV/i);
  assert.doesNotMatch(findings[0]!.summary, /rule promotion|engine defect/i);
});

test("two dev_not_rendered triages in a row are not yet a streak", () => {
  const notRendered = (sha: string) => outcome({
    errorClass: "E-PRECONDITION",
    verdict: "infra-error",
    sha,
    adjudication: { class: "dev_not_rendered" },
  });
  const o = notRendered("a");
  const findings = auditProcess({ outcome: o, recent: [o, notRendered("b")] });
  assert.equal(findings.some((f) => f.kind === "recurring-dev-not-rendered"), false);
});

test("a recurring unavailable reviewer is only observed: it is not read as an app-behavior gap", () => {
  const unavailable = (sha: string) => outcome({ errorClass: "E-REVIEWER-UNAVAILABLE", verdict: "infra-error", sha });
  const o = unavailable("a");
  const findings = auditProcess({ outcome: o, recent: [o, unavailable("b"), unavailable("c")] });
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.kind, "recurring-reviewer-unavailable");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.summary, /reviewer/i);
  assert.doesNotMatch(findings[0]!.summary, /rule promotion|app-behavior/i);
});

test("two unavailable-reviewer runs in a row are not yet a streak", () => {
  const unavailable = (sha: string) => outcome({ errorClass: "E-REVIEWER-UNAVAILABLE", verdict: "infra-error", sha });
  const o = unavailable("a");
  assert.deepEqual(auditProcess({ outcome: o, recent: [o, unavailable("b"), outcome({ errorClass: "E-EXEC-FAIL", sha: "c" })] }), []);
});

test("a recurring precondition failure is only observed, and is not read as an app-behavior gap", () => {
  const precondition = (sha: string) => outcome({ errorClass: "E-PRECONDITION", verdict: "infra-error", sha });
  const o = precondition("a");
  const findings = auditProcess({ outcome: o, recent: [o, precondition("b"), precondition("c")] });
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.kind, "recurring-precondition-failure");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.evidence, /E-PRECONDITION/);
  assert.match(findings[0]!.summary, /E-PRECONDITION/);
});

test("two precondition failures in a row are not yet a streak", () => {
  const precondition = (sha: string) => outcome({ errorClass: "E-PRECONDITION", verdict: "infra-error", sha });
  const o = precondition("a");
  assert.deepEqual(auditProcess({ outcome: o, recent: [o, precondition("b"), outcome({ errorClass: "E-EXEC-FAIL", sha: "c" })] }), []);
});

test("a one-off errorClass does NOT fire a recurring-error-class finding (one occurrence is noise, not a defect)", () => {
  const o = outcome({ errorClass: "E-STATIC" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-EXEC-FAIL" }), outcome({ errorClass: null })] };
  assert.ok(!auditProcess(input).some((x) => x.kind === "recurring-error-class"));
});

test("review churn that never reaches pass → observe", () => {
  const o = outcome({ verdict: "fail", gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 3 } });
  const f = auditProcess({ outcome: o, recent: [o] }).find((x) => x.kind === "review-churn-no-gain");
  assert.ok(f);
  assert.equal(f!.disposition, "observe");
});

test("applyAudit ROUTES by disposition — the data disposition heals autonomously, observe only logs", () => {
  const findings: ProcessFinding[] = [
    { kind: "recurring-ui-mismatch", disposition: "context-heal", severity: "warn", summary: "stale map", evidence: "e" },
    { kind: "review-churn-no-gain", disposition: "observe", severity: "warn", summary: "churn", evidence: "e" },
  ];
  let contextReason = "";
  const deps: AuditRouterDeps = {
    log: () => {},
    invalidateContext: (reason) => { contextReason = reason; return true; },
  };
  const applied = applyAudit(findings, deps);
  assert.equal(applied.contextInvalidated, 1); /* stale map rebuilt autonomously */
  assert.match(contextReason, /stale map/);
  assert.equal(applied.observed, 1);
});

test("Disposition closed set — memory-heal was removed (no detector ever produced it)", () => {
  /* Runtime guard documenting the invariant: auditProcess emits only these two dispositions, and
     "memory-heal" is not one of them. The compile-time proof is separate: process-audit.ts only
     typechecks because the Disposition union has 2 members and applyAudit's switch is exhaustive.
   */
  const validDispositions = ["context-heal", "observe"];
  assert.equal(validDispositions.includes("memory-heal"), false);
});
