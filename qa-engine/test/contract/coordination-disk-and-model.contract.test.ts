import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDelegationFailure } from "@contexts/coordination/application/delegation-failure-class.ts";
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

test("pushback rejects a path escape out of the writable path", () => {
  const brief = createDelegationBrief({ redaction,
    delegationId: "d1",
    runId: "r1",
    objective: "x",
    task: "x",
    scope: { readablePaths: ["."], writablePaths: ["e2e/flows/a.spec.ts"], allowedCommands: [] },
  });
  const blocked = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "hack",
    filesChanged: [{ path: "../secret" }],
    evidence: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    acceptance: [],
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.concerns.some((c) => c.includes("path-outside-scope")));
});

test("pushback allows the file of the writable path", () => {
  const brief = createDelegationBrief({ redaction,
    delegationId: "d1",
    runId: "r1",
    objective: "x",
    task: "x",
    scope: { readablePaths: ["."], writablePaths: ["e2e/flows/a.spec.ts"], allowedCommands: [] },
  });
  const ok = applyPushback(brief, {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "ok",
    filesChanged: [{ path: "e2e/flows/a.spec.ts" }],
    evidence: [],
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
