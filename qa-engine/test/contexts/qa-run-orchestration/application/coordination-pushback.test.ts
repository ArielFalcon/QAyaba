import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPushback,
  createDelegationBrief,
  validateDelegationAuthority,
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
    ...overrides,
  };
}

const reasonsOf = (b: DelegationBrief, r: DelegationResult) => validateDelegationAuthority(b, r).map((f) => f.reason);

/* ── authority and scope ─────────────────────────────────────────────────────────────────────── */

test("a result for another delegation is a foreign brief and is blocked", () => {
  assert.deepEqual(reasonsOf(brief(), result({ runId: "other-run" })), ["foreign-brief"]);
  const pushed = applyPushback(brief(), result({ delegationId: "d2" }));
  assert.equal(pushed.status, "blocked");
  assert.equal(pushed.recommendation, "escalate");
});

test("a brief whose authority was widened is an authority violation and is blocked", () => {
  const widened = { ...brief(), authority: { ...brief().authority, canExpandScope: true } } as unknown as DelegationBrief;
  assert.deepEqual(reasonsOf(widened, result()), ["authority-violation"]);
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

test("a blocked result is not checked against the validation plan or the acceptance criteria", () => {
  const b = brief({ validationPlan: [{ id: "typecheck", description: "tsc passes" }] });
  assert.deepEqual(reasonsOf(b, result({ status: "blocked", summary: "stuck", concerns: [`Cannot satisfy: ${CRITERION}`] })), []);
});

/* ── non-fatal findings ──────────────────────────────────────────────────────────────────────── */

test("a non-fatal finding downgrades a completed result to completed-with-concerns and keeps its recommendation", () => {
  const pushed = applyPushback(brief({ validationPlan: [{ id: "typecheck", description: "tsc passes" }] }), result());
  assert.equal(pushed.status, "completed-with-concerns");
  assert.equal(pushed.recommendation, "accept");
  assert.equal(pushed.summary, "fixed selectors");
  assert.ok(pushed.concerns.some((c) => c.startsWith("missing-artifact")));
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

/* ── acceptance contradictions: what a concern must claim, and about which words ─────────────── */

const blocks = (concern: string, criterion = CRITERION) =>
  applyPushback(brief({ acceptanceCriteria: [criterion] }), result({ status: "completed-with-concerns", concerns: [concern] })).status === "blocked";

for (const concern of [
  `Cannot  satisfy: ${CRITERION}`,
  `The fix would fail to meet: ${CRITERION}`,
  `Cannot be  satisfied: ${CRITERION}`,
  `Cannot be met: ${CRITERION}`,
  `Cannot fulfill: ${CRITERION}`,
  `Cannot achieve: ${CRITERION}`,
  `It is not  met: ${CRITERION}`,
  `It might not be met: ${CRITERION}`,
  `It might not be  met: ${CRITERION}`,
  `It has not been met: ${CRITERION}`,
  `It has not been  met: ${CRITERION}`,
  `It is not fulfilled: ${CRITERION}`,
  `Criterion unfulfilled: ${CRITERION}`,
  `Requirement failed: ${CRITERION}`,
  `Acceptance  failed: ${CRITERION}`,
  `Acceptance has  failed: ${CRITERION}`,
  `The acceptance criterion has failed: ${CRITERION}`,
  `A minor violation of: ${CRITERION}`,
  `Notably the change violates: ${CRITERION}`,
  `No flaky tests appeared and the change violates: ${CRITERION}`,
]) {
  test(`a concern claiming the criterion is not met blocks: ${JSON.stringify(concern)}`, () => {
    assert.equal(blocks(concern), true);
  });
}

test("a negation three words before the claim still negates it", () => {
  assert.equal(blocks(`No known change violates: ${CRITERION}`), false);
});

test("a claim against a criterion with no meaningful words never blocks", () => {
  assert.equal(blocks("Cannot satisfy anything here", "ok"), false);
});

test("a concern must repeat at least 60% of the criterion's meaningful words", () => {
  const criterion = "checkout shows discount tax shipping";
  assert.equal(blocks("Cannot satisfy: checkout shows discount", criterion), true, "3 of 5 words");
  assert.equal(blocks("Cannot satisfy: checkout", criterion), false, "1 of 5 words");
});

test("function words never count toward a criterion's meaningful words", () => {
  assert.equal(blocks("Cannot satisfy: sent", "It must have been sent"), true);
});

test("two-letter words never count toward a criterion's meaningful words", () => {
  assert.equal(blocks("Cannot satisfy: loads", "UI loads"), true);
});

test("identical three-letter words match", () => {
  assert.equal(blocks("Cannot satisfy: api key set", "API key set"), true);
});

test("words match by a shared stem of four letters or more, in either direction", () => {
  assert.equal(blocks("Cannot satisfy: forms submit", "form submits"), true);
  assert.equal(blocks("Cannot satisfy: validate email", "validates emails"), true);
});

test("a word under four letters matches only itself, never as a stem", () => {
  assert.equal(blocks("Cannot satisfy: taxes", "tax"), false);
});

test("words that only share their first four letters do not match", () => {
  assert.equal(blocks("Cannot satisfy: repository exported", "report exported"), false);
});

test("punctuation separates words: quoted, bracketed and slash-joined criterion words still match", () => {
  assert.equal(blocks("Cannot satisfy: the checkout page shows no total with tax", 'The "checkout" page shows the "total" (with tax)'), true);
  assert.equal(blocks("Cannot satisfy: logout works", "login/logout works"), true);
});
