/* Coordination contracts: pushback, router and telemetry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPushback,
  buildProgressSnapshot,
  createDelegationBrief,
  evidenceFromValidation,
  CoordinationTelemetryRecorder,
  routeOrchestration,
  sameProgress,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

const scope = {
  readablePaths: ["e2e/"],
  writablePaths: ["e2e/specs/"],
  allowedCommands: [],
};

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
    acceptance: [],
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
