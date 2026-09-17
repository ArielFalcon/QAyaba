/* DelegationBrief / DelegationResult contracts and frozen sidekick authority. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDelegationBrief,
  DEFAULT_ESCALATION_POLICY,
} from "@contexts/qa-run-orchestration/application/coordination/delegation-brief.ts";
import {
  belongsToBrief,
  DELEGATION_RECOMMENDATIONS,
  DELEGATION_STATUSES,
  type DelegationResult,
} from "@contexts/qa-run-orchestration/application/coordination/delegation-result.ts";
import { SIDEKICK_AUTHORITY } from "@contexts/qa-run-orchestration/application/coordination/authority.ts";
import {
  PARALLEL_WORKER_MISSING_FOR_SIDEKICK,
  PARALLEL_WORKER_REUSABLE_FIELDS,
} from "@contexts/qa-run-orchestration/application/coordination/parallel-worker-reuse.ts";

const scope = {
  readablePaths: ["e2e/"],
  writablePaths: ["e2e/specs/"],
  allowedCommands: ["npm test"],
};

test("createDelegationBrief freezes SIDEKICK_AUTHORITY and default escalation", () => {
  const brief = createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "cover login",
    task: "write a smoke spec",
    scope,
    acceptanceCriteria: ["login succeeds"],
  });
  assert.deepEqual(brief.authority, SIDEKICK_AUTHORITY);
  assert.equal(brief.authority.canModifyArchitecture, false);
  assert.equal(brief.authority.canChangeAcceptanceCriteria, false);
  assert.equal(brief.authority.canExpandScope, false);
  assert.equal(brief.authority.canChallengeBrief, true);
  assert.deepEqual(brief.escalationPolicy, DEFAULT_ESCALATION_POLICY);
  assert.deepEqual(brief.knownFacts, []);
  assert.deepEqual(brief.artifactRefs, []);
  assert.deepEqual(brief.validationPlan, []);
});

test("createDelegationBrief requires delegationId and runId", () => {
  assert.throws(
    () => createDelegationBrief({ delegationId: "", runId: "r1", objective: "o", task: "t", scope }),
    /delegationId/,
  );
  assert.throws(
    () => createDelegationBrief({ delegationId: "d1", runId: "", objective: "o", task: "t", scope }),
    /runId/,
  );
});

test("DelegationResult cannot belong to another brief", () => {
  const result: DelegationResult = {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "ok",
    filesChanged: [],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
  };
  assert.equal(belongsToBrief(result, "d1", "r1"), true);
  assert.equal(belongsToBrief(result, "d2", "r1"), false);
  assert.equal(belongsToBrief(result, "d1", "r2"), false);
});

test("DelegationResult status and recommendation unions match the architecture contract", () => {
  assert.deepEqual([...DELEGATION_STATUSES], [
    "completed",
    "completed-with-concerns",
    "blocked",
    "needs-lead",
    "failed",
  ]);
  assert.deepEqual([...DELEGATION_RECOMMENDATIONS], ["accept", "review", "retry", "escalate"]);
});

test("ParallelWorkerInput is inspected for reuse and is NOT converted into DelegationBrief", () => {
  assert.ok(PARALLEL_WORKER_REUSABLE_FIELDS.includes("objective"));
  assert.ok(PARALLEL_WORKER_REUSABLE_FIELDS.includes("runId"));
  assert.ok(PARALLEL_WORKER_MISSING_FOR_SIDEKICK.includes("authority"));
  assert.ok(PARALLEL_WORKER_MISSING_FOR_SIDEKICK.includes("acceptanceCriteria"));
  assert.ok(PARALLEL_WORKER_MISSING_FOR_SIDEKICK.includes("escalationPolicy"));
});
