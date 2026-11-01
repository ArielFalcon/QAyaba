/* How a sidekick's submitted result is read: the object its submit tool delivered, under the brief's own identity, and a turn that delivered none told apart from one that reported failure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { readDelegationResult, submittedResultErrors, unsubmittedResult } from "@contexts/coordination/application/delegation-reading.ts";
import { classifyDelegationFailure } from "@contexts/coordination/application/delegation-failure-class.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const brief = createDelegationBrief({ redaction, delegationId: "run-1-flow-cart", runId: "run-1", objective: "o", task: "t", scope: { readablePaths: [], writablePaths: ["e2e/flows/cart.spec.ts"], allowedCommands: [] } });

const closing = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ status: "completed", summary: "done", filesChanged: [{ path: "e2e/flows/cart.spec.ts" }], acceptance: [], concerns: [], unresolvedQuestions: [], ...over });

test("a turn that delivered no accepted result is a failed result marked unreadable, and one that reported failure is not", () => {
  const unreadable = unsubmittedResult(brief, "it stopped", redaction);
  assert.equal(unreadable.status, "failed");
  assert.equal(unreadable.readMiss, "unreadable");
  assert.equal(unreadable.answerMiss, "unreadable");
  assert.match(unreadable.summary, /it stopped/);
  const reported = readDelegationResult(closing({ status: "failed", summary: "no selector found" }), brief, redaction);
  assert.equal(reported.status, "failed");
  assert.equal(reported.readMiss, undefined);
  assert.equal(reported.answerMiss, undefined);
  assert.equal(classifyDelegationFailure(unreadable.status, 0, 0, unreadable.readMiss), "unreadable");
  assert.equal(classifyDelegationFailure(reported.status, 0, 0, reported.readMiss), "failed");
});

test("the result is the brief's whatever identity the answer names: the orchestrator owns it", () => {
  const result = readDelegationResult(closing({ delegationId: "run-1-flow-other", runId: "run-9" }), brief, redaction);
  assert.equal(result.status, "completed");
  assert.equal(result.delegationId, brief.delegationId);
  assert.equal(result.runId, brief.runId);
});

test("a write outside writablePaths keeps the result blocked", () => {
  const outside = readDelegationResult(closing({ filesChanged: [{ path: "e2e/other.spec.ts" }] }), brief, redaction);
  assert.equal(outside.status, "blocked");
  assert.equal(outside.readMiss, undefined);
});

test("a result that names no recommendation is read: the engine asks for no field nothing reads", () => {
  const result = readDelegationResult(closing(), brief, redaction);
  assert.equal(result.status, "completed");
  assert.equal(result.readMiss, undefined);
  assert.deepEqual(Object.keys(result).filter((key) => key === "recommendation"), [], "the field is gone from the result");
});

test("entries of the result the engine cannot read are recorded with where they sit, not dropped in silence", () => {
  const result = readDelegationResult(closing({ filesChanged: [{ path: "e2e/flows/cart.spec.ts" }, "e2e/flows/other.spec.ts", { file: "x" }], concerns: ["a note", 7], testCorrect: { cause: "weather", reason: "x" } }), brief, redaction);
  assert.deepEqual(result.unreadableEntries?.map((u) => u.where), ["filesChanged[1]", "filesChanged[2]", "concerns[1]", "testCorrect"]);
  assert.deepEqual(result.filesChanged.map((f) => f.path), ["e2e/flows/cart.spec.ts"]);
  assert.deepEqual(result.concerns, ["a note"]);
  assert.equal(result.readMiss, undefined, "a result with entries it could not read is still the sidekick's result");
});

test("a result that reads whole records nothing unreadable", () => {
  assert.equal(readDelegationResult(closing(), brief, redaction).unreadableEntries, undefined);
});

test("the contract of a submitted result names where the answer is not the contract's, and takes one that reads whole", () => {
  assert.deepEqual(submittedResultErrors(closing(), brief, redaction), []);
  assert.deepEqual(submittedResultErrors("done", brief, redaction).map((e) => e.path), ["answer"]);
  const status = submittedResultErrors(closing({ status: "done" }), brief, redaction);
  assert.deepEqual(status.map((e) => e.path), ["status"]);
  assert.match(status[0]!.reason, /completed/);
  const entries = submittedResultErrors(closing({ filesChanged: [{ path: "e2e/flows/cart.spec.ts" }, "x"], concerns: ["a note", 7], testCorrect: { cause: "weather", reason: "x" } }), brief, redaction);
  assert.deepEqual(entries.map((e) => e.path), ["filesChanged[1]", "concerns[1]", "testCorrect"]);
});
