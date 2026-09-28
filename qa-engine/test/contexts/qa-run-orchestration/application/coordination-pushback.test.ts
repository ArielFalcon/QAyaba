import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPushback,
  createDelegationBrief,
  validateDelegationAuthority,
  type AcceptanceStatus,
  type DelegationBrief,
  type DelegationResult,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

/* Pushback is the external authority check on a sidekick's DelegationResult: what it reports as
   findings, and whether it blocks the delegation. */

const CRITERION = "Failing cases pass on re-execute";

function brief(overrides: Partial<Parameters<typeof createDelegationBrief>[0]> = {}): DelegationBrief {
  return createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "Repair failing QA specs",
    task: "Fix the failing tests",
    scope: { readablePaths: ["e2e/"], writablePaths: ["e2e/specs/"], allowedCommands: [] },
    acceptanceCriteria: [CRITERION],
    ...overrides,
  });
}

function result(overrides: Partial<DelegationResult> = {}): DelegationResult {
  return {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "fixed selectors",
    filesChanged: [{ path: "e2e/specs/login.spec.ts" }],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    acceptance: [],
    ...overrides,
  };
}

const reasonsOf = (b: DelegationBrief, r: DelegationResult) => validateDelegationAuthority(b, r).map((f) => f.reason);

/* ── authority and scope ─────────────────────────────────────────────────────────────────────── */

test("a result for another delegation is a foreign brief and is blocked", () => {
  assert.deepEqual(reasonsOf(brief(), result({ runId: "other-run" })), ["foreign-brief"]);
  const [finding] = validateDelegationAuthority(brief(), result({ delegationId: "d9", runId: "other-run" }));
  assert.match(finding!.detail, /d9/, "the finding names the delegation the result answered");
  assert.match(finding!.detail, /other-run/, "the finding names the run the result answered");
  const pushed = applyPushback(brief(), result({ delegationId: "d2" }));
  assert.equal(pushed.status, "blocked");
  assert.equal(pushed.recommendation, "escalate");
});

test("a brief whose authority was widened is an authority violation and is blocked", () => {
  const widened = { ...brief(), authority: { ...brief().authority, canExpandScope: true } } as unknown as DelegationBrief;
  assert.deepEqual(reasonsOf(widened, result()), ["authority-violation"]);
  assert.match(validateDelegationAuthority(widened, result())[0]!.detail, /canExpandScope/, "the finding names the widened flag");
  assert.equal(applyPushback(widened, result()).status, "blocked");
});

test("a blocked delegation's summary names the fatal findings", () => {
  const pushed = applyPushback(brief(), result({ runId: "other-run", filesChanged: [{ path: "src/hack.ts" }] }));
  assert.match(pushed.summary, /foreign-brief/);
  assert.match(pushed.summary, /path-outside-scope/);
});

/* ── validation plan ─────────────────────────────────────────────────────────────────────────── */

test("a completed result missing a planned validation reports it as a missing artifact, naming the step", () => {
  const findings = validateDelegationAuthority(
    brief({ validationPlan: [{ id: "typecheck", description: "tsc passes" }] }),
    result({ validation: [{ id: "lint", ok: true }] }),
  );
  assert.deepEqual(findings.map((f) => f.reason), ["missing-artifact"]);
  assert.match(findings[0]!.detail, /typecheck/);
});

test("a completed result whose planned validation failed contradicts acceptance, naming the step", () => {
  const findings = validateDelegationAuthority(
    brief({ validationPlan: [{ id: "typecheck", description: "tsc passes" }] }),
    result({ validation: [{ id: "typecheck", ok: false }] }),
  );
  assert.deepEqual(findings.map((f) => f.reason), ["acceptance-contradiction"]);
  assert.match(findings[0]!.detail, /typecheck/);
});

test("a result that did not complete is not checked against the validation plan or the acceptance report", () => {
  const b = brief({ validationPlan: [{ id: "typecheck", description: "tsc passes" }] });
  for (const status of ["blocked", "needs-lead", "failed"] as const) {
    assert.deepEqual(reasonsOf(b, result({ status, summary: "stuck", acceptance: [{ criterion: 1, status: "unmet" }] })), [], status);
  }
});

/* ── non-fatal findings ──────────────────────────────────────────────────────────────────────── */

test("a non-fatal finding downgrades a completed result to completed-with-concerns and keeps its recommendation", () => {
  const pushed = applyPushback(brief({ validationPlan: [{ id: "typecheck", description: "tsc passes" }] }), result());
  assert.equal(pushed.status, "completed-with-concerns");
  assert.equal(pushed.recommendation, "accept");
  assert.equal(pushed.summary, "fixed selectors");
  assert.ok(pushed.concerns.some((c) => c.startsWith("missing-artifact")));
});

test("an acceptance report defect is a non-fatal finding: the result keeps its recommendation but is not a clean completion", () => {
  const defective = result({ acceptanceReportDefect: { reason: "acceptance-report-missing", detail: "no report for 1 criteria" } });
  assert.deepEqual(reasonsOf(brief(), defective), ["acceptance-report-missing"]);
  const pushed = applyPushback(brief(), defective);
  assert.equal(pushed.status, "completed-with-concerns");
  assert.equal(pushed.recommendation, "accept");
  assert.ok(pushed.concerns.some((c) => c.startsWith("acceptance-report-missing")));
});

test("one fatal finding among non-fatal ones still blocks the delegation", () => {
  const pushed = applyPushback(
    brief({ validationPlan: [{ id: "typecheck", description: "tsc passes" }] }),
    result({ filesChanged: [{ path: "src/hack.ts" }] }),
  );
  assert.equal(pushed.status, "blocked");
});

test("a needs-lead result asking an architecture question reports it and stays needs-lead", () => {
  const needsLead = result({ status: "needs-lead", unresolvedQuestions: ["Which retry policy applies?", "Is this an architecture change?"] });
  assert.deepEqual(reasonsOf(brief(), needsLead), ["architecture-decision-required"]);
  const [architecture] = validateDelegationAuthority(brief(), needsLead);
  assert.match(architecture!.detail, /architecture change/, "the finding names the question that needs a decision");
  assert.doesNotMatch(architecture!.detail, /retry policy/, "and only that question");
  const twoQuestions = result({ status: "needs-lead", unresolvedQuestions: ["Which architecture layer owns retries?", "Should the architecture split the module?"] });
  assert.deepEqual(reasonsOf(brief(), twoQuestions), ["architecture-decision-required", "architecture-decision-required"], "one finding per question");
  assert.equal(applyPushback(brief(), needsLead).status, "needs-lead");
  assert.deepEqual(reasonsOf(brief(), result({ status: "needs-lead", unresolvedQuestions: ["Which retry policy applies?"] })), []);
  assert.deepEqual(reasonsOf(brief(), result({ status: "completed", unresolvedQuestions: ["Is this an architecture change?"] })), []);
});

test("a blocked result names a missing dependency or an insufficient scope only when it says so", () => {
  assert.deepEqual(reasonsOf(brief(), result({ status: "blocked", summary: "a dependency is not installed" })), ["dependency-unavailable"]);
  assert.deepEqual(reasonsOf(brief(), result({ status: "blocked", summary: "the fix needs files outside my scope" })), ["insufficient-scope"]);
  assert.deepEqual(reasonsOf(brief(), result({ status: "blocked", summary: "stuck" })), []);
  assert.deepEqual(reasonsOf(brief(), result({ status: "completed", summary: "updated a dependency within scope" })), []);
});

/* ── the acceptance report decides; concerns are notes ──────────────────────────────────────── */

const TWO_CRITERIA = [CRITERION, "No writes outside scope"];
const reported = (...statuses: AcceptanceStatus[]) => statuses.map((status, i) => ({ criterion: i + 1, status }));

test("a criterion the sidekick reports unmet blocks the delegation, naming the criterion", () => {
  const b = brief({ acceptanceCriteria: TWO_CRITERIA });
  const r = result({ acceptance: reported("met", "unmet") });
  const findings = validateDelegationAuthority(b, r);
  assert.deepEqual(findings.map((f) => f.reason), ["acceptance-contradiction"]);
  assert.match(findings[0]!.detail, /No writes outside scope/);
  const pushed = applyPushback(b, r);
  assert.equal(pushed.status, "blocked");
  assert.equal(pushed.recommendation, "escalate");
});

test("a completed-with-concerns result reporting an unmet criterion is blocked too", () => {
  const pushed = applyPushback(
    brief({ acceptanceCriteria: TWO_CRITERIA }),
    result({ status: "completed-with-concerns", acceptance: reported("unmet", "met") }),
  );
  assert.equal(pushed.status, "blocked");
});

test("met and unverified criteria never block", () => {
  for (const statuses of [["met", "met"], ["unverified", "unverified"], ["met", "unverified"]] as AcceptanceStatus[][]) {
    const pushed = applyPushback(brief({ acceptanceCriteria: TWO_CRITERIA }), result({ acceptance: reported(...statuses) }));
    assert.equal(pushed.status, "completed", statuses.join(","));
    assert.equal(pushed.recommendation, "accept", statuses.join(","));
  }
});

test("concerns are notes only: prose saying a criterion failed never blocks a report without an unmet criterion", () => {
  for (const concern of [
    "fails acceptance criterion 1",
    "doesn't pass, violating criterion 2",
    "the retry flow is not implemented",
    "validation failed on DEV",
    `Cannot satisfy: ${CRITERION}`,
  ]) {
    const pushed = applyPushback(
      brief({ acceptanceCriteria: TWO_CRITERIA }),
      result({ acceptance: reported("unverified", "met"), concerns: [concern] }),
    );
    assert.equal(pushed.status, "completed", concern);
    assert.deepEqual(pushed.concerns, [concern]);
  }
});
