/* What the adjudicator claims about a failing test: a high-confidence app defect only from a fact the run observed, never from the shape of an assertion message. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADJ_ACTION, ADJ_CLASS, ADJ_CONFIDENCE, adjudicate, type AdjudicatorEvidence } from "@contexts/run-orchestration/domain/adjudicate.service.ts";
import { classifyFailure } from "@kernel/failure-detail-class.ts";

const VALUE_MISMATCH = "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'";

function evidence(overrides: Partial<AdjudicatorEvidence> = {}): AdjudicatorEvidence {
  const failureDetails = overrides.failureDetails ?? [VALUE_MISMATCH];
  return {
    allUnique: true,
    failureDetails,
    failureClasses: failureDetails.map((detail) => classifyFailure(detail)),
    absentKeysCount: 0,
    gateSpend: true,
    gateReason: "progress",
    devHealthy: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    failingFiles: ["checkout.spec.ts"],
    httpStatuses: [undefined],
    runtimeErrorsByCase: [[]],
    ...overrides,
  };
}

test("a failure whose only evidence is unique selectors and a value mismatch is a hint for a human: low confidence, the loop stops, nothing is regenerated into green", () => {
  const verdict = adjudicate(evidence());
  assert.equal(verdict.class, ADJ_CLASS.APP_DEFECT);
  assert.equal(verdict.confidence, ADJ_CONFIDENCE.LOW);
  assert.equal(verdict.action, ADJ_ACTION.BREAK_NEEDS_HUMAN);
});

test("an attributed 5xx or a captured runtime error is still a high-confidence app defect that files an Issue", () => {
  const fiveXx = adjudicate(evidence({ httpStatuses: [503] }));
  assert.deepEqual([fiveXx.class, fiveXx.confidence, fiveXx.action], [ADJ_CLASS.APP_DEFECT, ADJ_CONFIDENCE.HIGH, ADJ_ACTION.BREAK_ISSUE]);
  const runtime = adjudicate(evidence({ runtimeErrorsByCase: [[{ type: "pageerror", text: "TypeError: Cannot read properties of undefined (reading 'map')" }]] }));
  assert.deepEqual([runtime.class, runtime.confidence, runtime.action], [ADJ_CLASS.APP_DEFECT, ADJ_CONFIDENCE.HIGH, ADJ_ACTION.BREAK_ISSUE]);
});
