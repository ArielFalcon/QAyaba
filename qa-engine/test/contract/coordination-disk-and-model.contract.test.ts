import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDelegationFailure } from "@contexts/coordination/application/delegation-failure-class.ts";
import { resolveSidekickModel } from "@contexts/coordination/application/resolve-sidekick-model.ts";
import {
  applyPushback,
  createDelegationBrief,
} from "@contexts/coordination/application/index.ts";
import { PatternRedactionAdapter } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

test("classifyDelegationFailure: failed and blocked statuses are always a contract failure", () => {
  assert.equal(classifyDelegationFailure("failed", 0, 0), "failed");
  assert.equal(classifyDelegationFailure("blocked", 3, 3), "blocked");
});

test("classifyDelegationFailure: completed with claimed files that never verified on disk is a contract failure", () => {
  assert.equal(classifyDelegationFailure("completed", 2, 0), "claimed-files-missing");
  assert.equal(classifyDelegationFailure("completed-with-concerns", 1, 0), "claimed-files-missing");
});

test("classifyDelegationFailure: completed with verified files, or needs-lead, is NOT a contract failure", () => {
  assert.equal(classifyDelegationFailure("completed", 2, 2), undefined);
  assert.equal(classifyDelegationFailure("completed-with-concerns", 0, 0), undefined, "zero claimed files is not itself a failure");
  assert.equal(classifyDelegationFailure("needs-lead", 0, 0), undefined, "an intentional handoff is not a broken contract");
});

test("classifyDelegationFailure: a needs-lead handoff is not a contract failure even with claimed files that never verified", () => {
  assert.equal(classifyDelegationFailure("needs-lead", 2, 0), undefined);
});

test("resolveSidekickModel only returns a model for the escalated tier", () => {
  assert.equal(resolveSidekickModel("standard", "opencode-go/big"), undefined);
  assert.equal(resolveSidekickModel("escalated", "opencode-go/big"), "opencode-go/big");
  assert.equal(resolveSidekickModel("escalated", "  "), undefined);
  assert.equal(resolveSidekickModel("escalated", undefined), undefined);
});

test("pushback rejects path escape even with code-mode root '.'", () => {
  const brief = createDelegationBrief({ redaction,
    delegationId: "d1",
    runId: "r1",
    objective: "x",
    task: "x",
    scope: { readablePaths: ["."], writablePaths: ["."], allowedCommands: [] },
  });
  const blocked = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "hack",
    filesChanged: [{ path: "../secret" }],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    acceptance: [],
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.concerns.some((c) => c.includes("path-outside-scope")));
});

test("pushback allows relative project path under code-mode root '.'", () => {
  const brief = createDelegationBrief({ redaction,
    delegationId: "d1",
    runId: "r1",
    objective: "x",
    task: "x",
    scope: { readablePaths: ["."], writablePaths: ["."], allowedCommands: [] },
    validationPlan: [{ id: "v1", description: "ok" }],
  });
  const ok = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "ok",
    filesChanged: [{ path: "src/foo.test.ts" }],
    evidence: [],
    validation: [{ id: "v1", ok: true }],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    acceptance: [],
  });
  assert.equal(ok.status, "completed");
});

test("classifyDelegationFailure: an answer that could not be read is its own class, apart from a reported failure", () => {
  assert.equal(classifyDelegationFailure("failed", 0, 0, "unreadable"), "unreadable");
  assert.equal(classifyDelegationFailure("failed", 0, 0), "failed");
});
