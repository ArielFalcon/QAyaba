// Fases 5–14 coordination contracts: proposal, pushback, router, escalation, lead context,
// FixLoop capability selection, telemetry, adaptive policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";
import { WallClockBudget } from "@contexts/qa-run-orchestration/domain/wall-clock-budget.ts";
import {
  applyPushback,
  buildProgressSnapshot,
  capabilityForFixLoopRound,
  createDelegationBrief,
  createLeadContext,
  appendLeadDecision,
  createCoordinationPort,
  DEFAULT_ADAPTIVE_POLICY,
  evidenceFromChangeAnalysis,
  evidenceFromValidation,
  InMemoryCoordinationTelemetry,
  nextEscalation,
  canRetrySameCapability,
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

test("shadow proposal is advisoryOnly; active is not", () => {
  const decision = {
    action: "delegate" as const,
    reason: "hard",
    evidence: [],
    nextCapability: "sidekick-standard" as const,
  };
  assert.equal(proposeFromDecision("shadow", decision).advisoryOnly, true);
  assert.equal(proposeFromDecision("off", decision).advisoryOnly, true);
  assert.equal(proposeFromDecision("active", decision).advisoryOnly, false);
});

test("shadow proposer delegates large/contradictory changes and keeps simple ones direct", async () => {
  const port = createCoordinationPort("shadow");
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
  const tel = new InMemoryCoordinationTelemetry();
  tel.record({
    runId: "r1",
    mode: "shadow",
    kind: "proposal",
    action: "delegate",
    reason: "large change",
    at: 1,
  });
  assert.equal(tel.events.length, 1);
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
