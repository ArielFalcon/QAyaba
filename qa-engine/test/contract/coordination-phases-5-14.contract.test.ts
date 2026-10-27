/* Coordination contracts: pushback and telemetry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPushback,
  createDelegationBrief,
  evidenceFromValidation,
  CoordinationTelemetryRecorder,
} from "@contexts/coordination/application/index.ts";
import { PatternRedactionAdapter } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const scope = {
  readablePaths: ["e2e/"],
  writablePaths: ["e2e/specs/"],
  allowedCommands: [],
};

test("pushback blocks writes outside scope and foreign briefs", () => {
  const brief = createDelegationBrief({ redaction,
    delegationId: "d1",
    runId: "r1",
    objective: "o",
    task: "t",
    scope,
    acceptanceCriteria: ["ok"],
  });
  const blocked = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "x",
    filesChanged: [{ path: "src/hack.ts" }],
    evidence: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    acceptance: [],
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.recommendation, "escalate");
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
