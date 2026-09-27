/* Coordination contracts: proposal, pushback, router, escalation, lead context,
   FixLoop capability selection, telemetry, adaptive policy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";
import { WallClockBudget } from "@contexts/qa-run-orchestration/domain/wall-clock-budget.ts";
import {
  applyPushback,
  validateDelegationAuthority,
  buildProgressSnapshot,
  capabilityForFixLoopRound,
  createDelegationBrief,
  createLeadContext,
  appendLeadDecision,
  createCoordinationPort,
  DEFAULT_ADAPTIVE_POLICY,
  evidenceFromChangeAnalysis,
  evidenceFromValidation,
  CoordinationTelemetryRecorder,
  nextEscalation,
  canRetrySameCapability,
  advanceAfterNeedsLead,
  raiseCapabilityFloor,
  deriveAdaptiveSignals,
  proposeFromDecision,
  routeOrchestration,
  sameProgress,
  ESCALATION_LADDER,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

function budgets() {
  const cycle = CycleBudget.derive({ maxRetries: 2 });
  return { cycle, wallClock: WallClockBudget.derive({ cycleBudget: cycle, agentTimeoutMs: 1000 }) };
}

const scope = {
  readablePaths: ["e2e/"],
  writablePaths: ["e2e/specs/"],
  allowedCommands: [],
};

test("proposal wraps the decision verbatim with a recordedAt stamp", () => {
  const decision = {
    action: "delegate" as const,
    reason: "hard",
    evidence: [],
    nextCapability: "sidekick-standard" as const,
  };
  const proposal = proposeFromDecision(decision, 1234);
  assert.equal(proposal.decision, decision);
  assert.equal(proposal.recordedAt, 1234);
});

test("proposer delegates large/contradictory changes and keeps simple ones direct", async () => {
  const port = createCoordinationPort();
  const direct = await port.decide({
    runId: "r1",
    objective: "o",
    acceptanceCriteria: [],
    evidence: [evidenceFromChangeAnalysis({ action: "generate", reason: "feat", fileCount: 1 })],
    budgets: budgets(),
  });
  assert.equal(direct.action, "direct");
  const delegated = await port.decide({
    runId: "r1",
    objective: "o",
    acceptanceCriteria: [],
    evidence: [
      evidenceFromChangeAnalysis({ action: "generate", reason: "feat", fileCount: 12, contradiction: true }),
    ],
    budgets: budgets(),
  });
  assert.equal(delegated.action, "delegate");
  assert.equal(delegated.nextCapability, "sidekick-standard");
});

/* Intentional policy (not a missing-field accident): non-diff modes (manual/complete/exhaustive/
   context) never emit change-analysis evidence — RunQaUseCase only classifies in mode==="diff".
   Without that evidence the deterministic proposer stays on the direct/lead path. Documented so a
   future "delegate in complete" decision is explicit, not inferred from absent files=N.
 */
test("proposer stays direct when change-analysis evidence is absent (manual/complete shape)", async () => {
  const port = createCoordinationPort();
  const decision = await port.decide({
    runId: "r-manual",
    objective: "toggle dark mode",
    acceptanceCriteria: [],
    evidence: [evidenceFromValidation({ ok: true, errors: 0 })],
    budgets: budgets(),
  });
  assert.equal(decision.action, "direct");
  assert.match(decision.reason, /simple\/direct/);
});

test("pushback blocks writes outside scope and foreign briefs", () => {
  const brief = createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "o",
    task: "t",
    scope,
    acceptanceCriteria: ["ok"],
    validationPlan: [{ id: "v1", description: "pass" }],
  });
  const blocked = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "x",
    filesChanged: [{ path: "src/hack.ts" }],
    evidence: [],
    validation: [{ id: "v1", ok: true }],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.recommendation, "escalate");
});

/* A sidekick's "concerns" prose paraphrases the criterion in its own words rather than
   quoting it verbatim — a plain c.includes(criterion) substring check misses this and silently
   waves through a genuine acceptance contradiction. Matching by normalized key-term overlap
   catches it. */
test("acceptance-contradiction is detected from a PARAPHRASED concern, not just a verbatim substring match", () => {
  const brief = createDelegationBrief({
    delegationId: "d2",
    runId: "r2",
    objective: "o",
    task: "t",
    scope,
    acceptanceCriteria: ["Login form validates email format before submission"],
    validationPlan: [],
  });
  const result = {
    delegationId: "d2",
    runId: "r2",
    status: "completed" as const,
    summary: "done",
    filesChanged: [],
    evidence: [],
    validation: [],
    assumptions: [],
    /* Same substance, different words: no verbatim "Login form validates email format before
       submission" substring anywhere in this concern. */
    concerns: ["cannot satisfy criterion: the login form does not validate email formatting correctly"],
    unresolvedQuestions: [],
    recommendation: "accept" as const,
  };
  const findings = validateDelegationAuthority(brief, result);
  assert.ok(
    findings.some((f) => f.reason === "acceptance-contradiction"),
    "a paraphrased concern must still be recognized as contradicting the criterion, not only a verbatim substring match",
  );
});

/* An unrelated concern sharing zero key terms with the criterion must NOT be flagged — the
   normalized-overlap match must not degrade into "any concern at all contradicts everything". */
test("acceptance-contradiction is NOT raised when the concern shares no meaningful terms with the criterion", () => {
  const brief = createDelegationBrief({
    delegationId: "d3",
    runId: "r3",
    objective: "o",
    task: "t",
    scope,
    acceptanceCriteria: ["Login form validates email format before submission"],
    validationPlan: [],
  });
  const result = {
    delegationId: "d3",
    runId: "r3",
    status: "completed" as const,
    summary: "done",
    filesChanged: [],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: ["cannot satisfy criterion: the checkout page total omits sales tax"],
    unresolvedQuestions: [],
    recommendation: "accept" as const,
  };
  const findings = validateDelegationAuthority(brief, result);
  assert.equal(
    findings.some((f) => f.reason === "acceptance-contradiction"),
    false,
    "an unrelated concern must not be treated as contradicting a criterion it shares no meaningful terms with",
  );
});

/* A concern only contradicts a criterion when it says the criterion is NOT met. Reporting that
   something could not be verified, or that a criterion IS satisfied, shares the criterion's words
   but is not a contradiction and must never fatally block the delegation. */
function repairBrief() {
  return createDelegationBrief({
    delegationId: "d-fix",
    runId: "r-fix",
    objective: "Repair failing QA specs: login works",
    task: "Fix the failing tests",
    scope,
    acceptanceCriteria: ["Failing cases pass on re-execute", "No writes outside scope"],
  });
}

function repairResult(concern: string) {
  return {
    delegationId: "d-fix",
    runId: "r-fix",
    status: "completed-with-concerns" as const,
    summary: "fixed selectors",
    filesChanged: [{ path: "e2e/specs/login.spec.ts" }],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [concern],
    unresolvedQuestions: [],
    recommendation: "review" as const,
  };
}

/* Every concern below restates a criterion's key terms, so only the claim it makes about the
   criterion decides whether it blocks. */
for (const concern of [
  "Acceptance: could not re-execute the failing cases to confirm they pass (no test runner in scope)",
  "Acceptance criterion: could not verify that failing cases pass on re-execute",
  "Acceptance criterion satisfied: no writes outside scope (only e2e/specs/login.spec.ts)",
  "Acceptance criterion satisfied: failing cases pass on re-execute",
  "Verified the failing cases pass on re-execute; nothing contradicts the criterion",
  "No violations: failing cases pass on re-execute",
]) {
  test(`pushback does not block a delegation whose concern is not a contradiction: "${concern}"`, () => {
    const result = applyPushback(repairBrief(), repairResult(concern));
    assert.notEqual(result.status, "blocked");
    assert.notEqual(result.recommendation, "escalate");
  });
}

for (const concern of [
  "Cannot satisfy acceptance criterion: Failing cases pass on re-execute",
  "cannot satisfy: re-executing the failing cases would still not make them pass",
  "criterion not met: the failing cases keep failing when re-executed",
  "Acceptance criterion failed: failing cases do not pass on re-execute",
  "Acceptance criterion could not be met: failing cases pass on re-execute",
  "The change violates the criterion that failing cases pass on re-execute",
  "Acceptance criterion unmet: failing cases pass on re-execute",
]) {
  test(`pushback blocks a delegation whose concern says a criterion is not met: "${concern}"`, () => {
    const result = applyPushback(repairBrief(), repairResult(concern));
    assert.equal(result.status, "blocked");
    assert.equal(result.recommendation, "escalate");
  });
}

test("router order: infra and budget beat retry; no-progress escalates; FixLoop owns QA correction", () => {
  const snap = buildProgressSnapshot({ failureClass: "selector", failingNames: ["a"] });
  assert.equal(
    routeOrchestration({
      evidence: [],
      currentCapability: "sidekick-standard",
      current: snap,
      budgetExhausted: false,
      infraFailure: true,
    }).action,
    "abort-human",
  );
  assert.equal(
    routeOrchestration({
      evidence: [],
      currentCapability: "sidekick-standard",
      current: snap,
      budgetExhausted: true,
      infraFailure: false,
    }).action,
    "abort-human",
  );
  const escalated = routeOrchestration({
    evidence: [],
    currentCapability: "sidekick-standard",
    previous: snap,
    current: snap,
    budgetExhausted: false,
    infraFailure: false,
  });
  assert.equal(escalated.action, "escalate-sidekick");
  assert.equal(sameProgress(snap, snap), true);
  assert.equal(
    routeOrchestration({
      evidence: [evidenceFromValidation({ ok: false, errors: 1 })],
      currentCapability: "lead",
      current: snap,
      budgetExhausted: false,
      infraFailure: false,
      qaCorrectionOwnedByFixLoop: true,
    }).action,
    "continue-fix-loop",
  );
});

test("escalation ladder and FixLoop capability selection", () => {
  assert.deepEqual([...ESCALATION_LADDER], ["sidekick-standard", "sidekick-escalated", "lead"]);
  assert.equal(nextEscalation("sidekick-standard"), "sidekick-escalated");
  assert.equal(nextEscalation("lead"), "human");
  assert.equal(canRetrySameCapability({ capability: "sidekick-standard", sameFingerprint: true, needsLead: false }), false);
  assert.equal(advanceAfterNeedsLead("sidekick-standard"), "sidekick-escalated");
  assert.equal(advanceAfterNeedsLead("sidekick-escalated"), "lead");
  assert.equal(advanceAfterNeedsLead("lead"), "lead");
  assert.equal(raiseCapabilityFloor("sidekick-standard", "sidekick-escalated"), "sidekick-escalated");
  assert.equal(raiseCapabilityFloor("lead", "sidekick-escalated"), "lead");
  assert.equal(
    capabilityForFixLoopRound({
      orchestration: { action: "lead-takeover", reason: "x", evidence: [], nextCapability: "lead" },
      fallback: "sidekick-standard",
    }),
    "lead",
  );
  assert.equal(
    capabilityForFixLoopRound({
      orchestration: { action: "continue-fix-loop", reason: "x", evidence: [] },
      fallback: "lead",
    }),
    "lead",
  );
});

test("LeadContext accumulates decisions without OpencodeRunInput fields", () => {
  let lead = createLeadContext({ runId: "r1", objective: "cover form" });
  lead = appendLeadDecision(lead, {
    action: "direct",
    reason: "simple",
    evidence: [evidenceFromChangeAnalysis({ action: "generate", reason: "feat", fileCount: 1 })],
  });
  assert.equal(lead.decisions.length, 1);
  assert.equal(Object.hasOwn(lead, "diff"), false);
  assert.equal(Object.hasOwn(lead, "learnedRules"), false);
});

test("coordination telemetry records proposals", () => {
  const tel = new CoordinationTelemetryRecorder();
  tel.record({
    runId: "r1",
    kind: "proposal",
    action: "delegate",
    reason: "large change",
    at: 1,
  });
  assert.equal(tel.events.length, 1);
});

test("deriveAdaptiveSignals needs min samples; then raises escalate rate", () => {
  assert.equal(deriveAdaptiveSignals([], 5), undefined);
  const tel = new CoordinationTelemetryRecorder();
  for (let i = 0; i < 5; i++) {
    tel.record({
      runId: `r${i}`,
      kind: "delegation",
      reason: "x",
      durationMs: 100,
      at: i,
    });
    tel.record({
      runId: `r${i}`,
      kind: "escalation",
      reason: "no progress at sidekick-standard",
      at: i,
    });
  }
  const signals = deriveAdaptiveSignals(tel.events, 5);
  assert.ok(signals);
  assert.ok(signals!.recentEscalateRate >= 0.9);
  assert.equal(DEFAULT_ADAPTIVE_POLICY.delegationFileThreshold(signals!), 12);
});

test("deriveAdaptiveSignals scopes to one app's own events — another app's escalation trend never leaks in", () => {
  const tel = new CoordinationTelemetryRecorder();
  /* app "noisy": 5 delegations, all escalated (should raise ITS OWN threshold). */
  for (let i = 0; i < 5; i++) {
    tel.record({ runId: `noisy-${i}`, app: "noisy", kind: "delegation", reason: "x", durationMs: 100, at: i });
    tel.record({ runId: `noisy-${i}`, app: "noisy", kind: "escalation", reason: "no progress", at: i });
  }
  /* app "calm": 5 delegations, zero escalations. */
  for (let i = 0; i < 5; i++) {
    tel.record({ runId: `calm-${i}`, app: "calm", kind: "delegation", reason: "x", durationMs: 100, at: i });
  }
  const noisySignals = deriveAdaptiveSignals(tel.events, 5, { app: "noisy" });
  const calmSignals = deriveAdaptiveSignals(tel.events, 5, { app: "calm" });
  assert.ok(noisySignals);
  assert.ok(calmSignals);
  assert.ok(noisySignals!.recentEscalateRate >= 0.9, "the noisy app's own escalations must dominate its own rate");
  assert.equal(calmSignals!.recentEscalateRate, 0, "the calm app must not inherit the noisy app's escalation rate");
});

test("deriveAdaptiveSignals bounds derivation to a recent window — an old escalation burst ages out", () => {
  const tel = new CoordinationTelemetryRecorder();
  /* An old burst of escalated delegations, followed by many recent clean ones. Once the window
     (windowSize) is smaller than the total event count, the old burst must no longer dominate the
     "recent*" rates — proving these fields are windowed, not all-time. */
  for (let i = 0; i < 5; i++) {
    tel.record({ runId: `old-${i}`, kind: "delegation", reason: "x", durationMs: 100, at: i });
    tel.record({ runId: `old-${i}`, kind: "escalation", reason: "no progress", at: i });
  }
  for (let i = 0; i < 50; i++) {
    tel.record({ runId: `recent-${i}`, kind: "delegation", reason: "x", durationMs: 100, at: 1000 + i });
  }
  const allTime = deriveAdaptiveSignals(tel.events, 5, { windowSize: 10_000 });
  const windowed = deriveAdaptiveSignals(tel.events, 5, { windowSize: 20 });
  assert.ok(allTime);
  assert.ok(windowed);
  assert.ok(allTime!.recentEscalateRate > 0, "sanity: the old burst is visible without a window");
  assert.equal(windowed!.recentEscalateRate, 0, "a small recent window must exclude the aged-out escalation burst");
});

test("adaptive proposer raises file threshold when escalate rate is high", async () => {
  const tel = new CoordinationTelemetryRecorder();
  for (let i = 0; i < 5; i++) {
    tel.record({
      runId: `r${i}`,
      kind: "delegation",
      reason: "x",
      durationMs: 50,
      at: i,
    });
    tel.record({
      runId: `r${i}`,
      kind: "escalation",
      reason: "no progress",
      at: i,
    });
  }
  const port = createCoordinationPort({ telemetry: tel, adaptiveMinSamples: 5 });
  /* 10 files: default threshold 8 would delegate; adaptive escalate rate → threshold 12 → direct.
     Use a non-generate action so the half-threshold generate branch does not force delegate.
   */
  const decision = await port.decide({
    runId: "r-adapt",
    objective: "o",
    acceptanceCriteria: [],
    evidence: [evidenceFromChangeAnalysis({ action: "feat", reason: "feat", fileCount: 10 })],
    budgets: budgets(),
  });
  assert.equal(decision.action, "direct");
  assert.match(decision.reason, /fileThreshold=12/);
});

test("adaptive policy raises delegation threshold when escalate rate is high", () => {
  assert.equal(DEFAULT_ADAPTIVE_POLICY.delegationFileThreshold({
    recentEscalateRate: 0.5,
    recentNoProgressRate: 0,
    avgDelegationMs: 1000,
  }), 12);
  assert.equal(DEFAULT_ADAPTIVE_POLICY.delegationFileThreshold({
    recentEscalateRate: 0,
    recentNoProgressRate: 0,
    avgDelegationMs: 1000,
  }), 8);
});
