/* How a sidekick's closing answer is read: the last DelegationResult of its output, and an answer that holds none told apart from one that reported failure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { readDelegationResult } from "@contexts/coordination/application/delegation-reading.ts";
import { classifyDelegationFailure } from "@contexts/coordination/application/delegation-failure-class.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const brief = createDelegationBrief({ redaction, delegationId: "run-1-flow-cart", runId: "run-1", objective: "o", task: "t", scope: { readablePaths: [], writablePaths: ["e2e/flows/cart.spec.ts"], allowedCommands: [] } });

const closing = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ delegationId: brief.delegationId, runId: brief.runId, status: "completed", summary: "done", filesChanged: [{ path: "e2e/flows/cart.spec.ts" }], evidence: [], acceptance: [], concerns: [], unresolvedQuestions: [], ...over });

test("narration holding brace-bearing code before the closing block does not turn a completed result into a failure", () => {
  const output = ["The capture gives `{name, value, url}` and my helper is `async ({ page }) => {`.", "The last run_spec passed.", "```json", closing(), "```"].join("\n");
  const result = readDelegationResult(output, brief, redaction);
  assert.equal(result.status, "completed");
  assert.equal(result.readMiss, undefined);
});

test("an earlier unrelated object does not stand in for the closing DelegationResult", () => {
  const output = `{"specs":["flows/cart.spec.ts"],"note":""}\nmore work\n${closing({ summary: "the closing block" })}`;
  const result = readDelegationResult(output, brief, redaction);
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "the closing block");
});

test("an answer holding no DelegationResult is a failed result marked unreadable, and one that reported failure is not", () => {
  const unreadable = readDelegationResult('I wrote `{name, value}` and ran out of time {"specs":[]}', brief, redaction);
  assert.equal(unreadable.status, "failed");
  assert.equal(unreadable.readMiss, "unreadable");
  const reported = readDelegationResult(closing({ status: "failed", summary: "no selector found" }), brief, redaction);
  assert.equal(reported.status, "failed");
  assert.equal(reported.readMiss, undefined);
  assert.equal(classifyDelegationFailure(unreadable.status, 0, 0, unreadable.readMiss), "unreadable");
  assert.equal(classifyDelegationFailure(reported.status, 0, 0, reported.readMiss), "failed");
});

test("an unreadable closing result is the answer: it is marked unreadable, never replaced by an earlier result of the same answer", () => {
  const output = ["I will report like this when done:", closing({ summary: "DRAFT: all criteria met" }), "the spec still fails on the total row", closing({ status: "done", summary: "FINAL: the total row still fails" })].join("\n");
  const result = readDelegationResult(output, brief, redaction);
  assert.equal(result.status, "failed");
  assert.equal(result.readMiss, "unreadable");
  assert.notEqual(result.summary, "DRAFT: all criteria met");
});

test("an object after the closing result that is no result does not hide it", () => {
  const result = readDelegationResult(`${closing({ summary: "the closing block" })}\n{"note":"a quoted payload"}`, brief, redaction);
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "the closing block");
});

test("a result for another brief and a write outside writablePaths keep failing as before", () => {
  assert.equal(readDelegationResult(closing({ delegationId: "other" }), brief, redaction).status, "failed");
  const outside = readDelegationResult(closing({ filesChanged: [{ path: "e2e/other.spec.ts" }] }), brief, redaction);
  assert.equal(outside.status, "blocked");
  assert.equal(outside.readMiss, undefined);
});

test("an output with no readable result and a result addressed to another brief are each marked as the orchestrator's statement, a reported failure is not", () => {
  assert.equal(readDelegationResult("no json here", brief, redaction).answerMiss, "unreadable");
  const foreign = readDelegationResult(closing({ delegationId: "run-1-flow-other" }), brief, redaction);
  assert.equal(foreign.status, "failed");
  assert.equal(foreign.answerMiss, "foreign-brief");
  assert.equal(readDelegationResult(closing({ status: "failed", summary: "no selector found" }), brief, redaction).answerMiss, undefined);
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
