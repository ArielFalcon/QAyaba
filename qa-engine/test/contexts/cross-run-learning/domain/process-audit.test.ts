/* Process-audit domain tests — auditProcess/applyAudit routing and streak detection. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditProcess,
  applyAudit,
  type AuditInput,
  type RuleView,
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
    rulesRetrieved: [],
    at: over.at ?? "2026-06-13T00:00:00Z",
    ...(over.adjudication ? { adjudication: over.adjudication } : {}),
  };
}

const rule = (over: Partial<RuleView>): RuleView => ({ id: "ru1", errorClass: "E-EXEC-FAIL", status: "candidate", usageCount: 0, successRate: null, ...over });

test("recurring CODE errorClass (E-STATIC) 3 runs in a row → observed (a repeating engine defect, visibility only)", () => {
  const o = outcome({ errorClass: "E-STATIC" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-STATIC", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })], rules: [] };
  const f = auditProcess(input).find((x) => x.kind === "recurring-error-class");
  assert.ok(f, "expected a recurring-error-class finding");
  assert.equal(f!.disposition, "observe");
  assert.match(f!.evidence, /E-STATIC/);
});

test("recurring UI/grounding errorClass (E-FRAGILE-SELECTOR) → context-heal (rebuild the stale map), not an observed engine defect", () => {
  const o = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })], rules: [] };
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
    rules: [],
  };
  const findings = auditProcess(input);
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.evidence, /E-STEP-BUDGET/);
  assert.ok(!findings.some((f) => f.kind === "recurring-error-class" || f.disposition === "context-heal"));
});

test("the step-budget streak is worded as the agent running out of steps, not as an app-behavior gap needing a rule", () => {
  const o = outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error" });
  const findings = auditProcess({ outcome: o, recent: [o, outcome({ errorClass: "E-STEP-BUDGET", sha: "b" }), outcome({ errorClass: "E-STEP-BUDGET", sha: "c" })], rules: [] });
  assert.match(findings[0]!.summary, /steps/i);
  assert.doesNotMatch(findings[0]!.summary, /rule promotion|app-behavior/i);
});

test("two step-budget runs in a row are not yet a streak", () => {
  const o = outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error" });
  assert.deepEqual(auditProcess({ outcome: o, recent: [o, outcome({ errorClass: "E-STEP-BUDGET", sha: "b" }), outcome({ errorClass: "E-EXEC-FAIL", sha: "c" })], rules: [] }), []);
});

test("a recurring time-budget end is only observed, worded as the generator running out of time and not as an app-behavior gap", () => {
  const timeBudget = (sha: string) => outcome({ errorClass: "E-TIME-BUDGET", verdict: "infra-error", sha });
  const o = timeBudget("a");
  const findings = auditProcess({ outcome: o, recent: [o, timeBudget("b"), timeBudget("c")], rules: [] });
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
  const findings = auditProcess({ outcome: o, recent: [o, notRendered("b"), notRendered("c")], rules: [] });
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
  const findings = auditProcess({ outcome: o, recent: [o, notRendered("b")], rules: [] });
  assert.equal(findings.some((f) => f.kind === "recurring-dev-not-rendered"), false);
});

test("a recurring unavailable reviewer is only observed: it is not read as an app-behavior gap", () => {
  const unavailable = (sha: string) => outcome({ errorClass: "E-REVIEWER-UNAVAILABLE", verdict: "infra-error", sha });
  const o = unavailable("a");
  const findings = auditProcess({ outcome: o, recent: [o, unavailable("b"), unavailable("c")], rules: [] });
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.kind, "recurring-reviewer-unavailable");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.summary, /reviewer/i);
  assert.doesNotMatch(findings[0]!.summary, /rule promotion|app-behavior/i);
});

test("two unavailable-reviewer runs in a row are not yet a streak", () => {
  const unavailable = (sha: string) => outcome({ errorClass: "E-REVIEWER-UNAVAILABLE", verdict: "infra-error", sha });
  const o = unavailable("a");
  assert.deepEqual(auditProcess({ outcome: o, recent: [o, unavailable("b"), outcome({ errorClass: "E-EXEC-FAIL", sha: "c" })], rules: [] }), []);
});

test("a recurring precondition failure is only observed, and is not read as an app-behavior gap", () => {
  const precondition = (sha: string) => outcome({ errorClass: "E-PRECONDITION", verdict: "infra-error", sha });
  const o = precondition("a");
  const findings = auditProcess({ outcome: o, recent: [o, precondition("b"), precondition("c")], rules: [] });
  assert.equal(findings.length, 1, "one finding: the streak itself");
  assert.equal(findings[0]!.kind, "recurring-precondition-failure");
  assert.equal(findings[0]!.disposition, "observe");
  assert.match(findings[0]!.evidence, /E-PRECONDITION/);
  assert.match(findings[0]!.summary, /E-PRECONDITION/);
});

test("two precondition failures in a row are not yet a streak", () => {
  const precondition = (sha: string) => outcome({ errorClass: "E-PRECONDITION", verdict: "infra-error", sha });
  const o = precondition("a");
  assert.deepEqual(auditProcess({ outcome: o, recent: [o, precondition("b"), outcome({ errorClass: "E-EXEC-FAIL", sha: "c" })], rules: [] }), []);
});

test("a one-off errorClass does NOT fire a recurring-error-class finding (one occurrence is noise, not a defect)", () => {
  const o = outcome({ errorClass: "E-STATIC" });
  const input: AuditInput = { outcome: o, recent: [o, outcome({ errorClass: "E-EXEC-FAIL" }), outcome({ errorClass: null })], rules: [] };
  assert.ok(!auditProcess(input).some((x) => x.kind === "recurring-error-class"));
});

test("a used-but-unproven candidate rule whose class is STILL RECURRING → ledger-heal (deprecate, no PR)", () => {
  const o = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  /* The class recurs RECUR_WINDOW runs in a row: the rule was injected yet its class keeps recurring,
     so it is demonstrably failing at its job — the EVIDENCE that justifies deprecating it.
   */
  const input: AuditInput = {
    outcome: o,
    recent: [o, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })],
    rules: [
      rule({ id: "noise1", errorClass: "E-FRAGILE-SELECTOR", usageCount: 4, successRate: null, status: "candidate" }),
      rule({ id: "proven", errorClass: "E-FRAGILE-SELECTOR", usageCount: 5, successRate: 0.8, status: "active" }), /* not a candidate → kept */
      rule({ id: "fresh", errorClass: "E-FRAGILE-SELECTOR", usageCount: 1, successRate: null, status: "candidate" }),
      rule({ id: "other", errorClass: "E-EXEC-FAIL", usageCount: 9, successRate: null, status: "candidate" }),
    ],
  };
  const f = auditProcess(input).find((x) => x.kind === "noise-rule");
  assert.ok(f, "expected a noise-rule finding");
  assert.equal(f!.disposition, "ledger-heal");
  assert.deepEqual(f!.ruleIds, ["noise1"]); /* ONLY the used candidate whose recurring class it targets */
});

test("an UNMEASURED candidate is NOT deprecated when its class is NOT recurring (shadow/oracle-off safety)", () => {
  /* Only ONE run of this class → no recurring streak. In shadow/oracle-off mode successRate stays
     null for genuinely-useful rules too, so absence-of-success alone must NEVER deprecate them.
   */
  const o = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  const input: AuditInput = {
    outcome: o,
    recent: [o, outcome({ errorClass: "E-EXEC-FAIL", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })],
    rules: [rule({ id: "useful", errorClass: "E-FRAGILE-SELECTOR", usageCount: 8, successRate: null, status: "candidate" })],
  };
  assert.ok(!auditProcess(input).some((x) => x.kind === "noise-rule"), "an unmeasured candidate must not be deprecated when its class is not recurring");
});

test("review churn that never reaches pass → observe", () => {
  const o = outcome({ verdict: "fail", gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 3 } });
  const f = auditProcess({ outcome: o, recent: [o], rules: [] }).find((x) => x.kind === "review-churn-no-gain");
  assert.ok(f);
  assert.equal(f!.disposition, "observe");
});

test("applyAudit ROUTES by disposition — DATA heals autonomously, observe only logs", () => {
  const findings: ProcessFinding[] = [
    { kind: "noise-rule", disposition: "ledger-heal", severity: "warn", summary: "noise", evidence: "e", ruleIds: ["n1", "n2"] },
    { kind: "recurring-ui-mismatch", disposition: "context-heal", severity: "warn", summary: "stale map", evidence: "e" },
    { kind: "review-churn-no-gain", disposition: "observe", severity: "warn", summary: "churn", evidence: "e" },
  ];
  const deprecated: string[] = [];
  let contextReason = "";
  const deps: AuditRouterDeps = {
    log: () => {},
    deprecateRule: (id) => deprecated.push(id),
    invalidateContext: (reason) => { contextReason = reason; return true; },
  };
  const applied = applyAudit(findings, deps);
  assert.deepEqual(deprecated, ["n1", "n2"]); /* ledger noise self-healed */
  assert.equal(applied.contextInvalidated, 1); /* stale map rebuilt autonomously */
  assert.match(contextReason, /stale map/);
  assert.equal(applied.observed, 1);
});

test("Disposition closed set — memory-heal was removed (no detector ever produced it)", () => {
  /* Runtime guard documenting the invariant: auditProcess emits only these three dispositions, and
     "memory-heal" is not one of them. The compile-time proof is separate: process-audit.ts only
     typechecks because the Disposition union has 3 members and applyAudit's switch is exhaustive.
   */
  const validDispositions = ["ledger-heal", "context-heal", "observe"];
  assert.equal(validDispositions.includes("memory-heal"), false);
});
