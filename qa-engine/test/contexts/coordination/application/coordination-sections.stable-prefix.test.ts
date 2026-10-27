/* The coordination prompts open with their stable prefix (the sections whose bytes do not vary per run) and close with the instruction that ends the turn. Two runs with different facts share a brief's stable prefix byte for byte. */
import { test } from "node:test";
import assert from "node:assert/strict";
type Prefixed = { text: string; stablePrefixBytes: number };
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { createDelegationBrief, type DelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { renderSidekickBrief } from "@contexts/coordination/application/sidekick-prompt.ts";
import { renderExploreBrief } from "@contexts/coordination/application/explore-kind.ts";
import { assembleExploreOutcome } from "@contexts/coordination/application/explore-round.ts";
import { assembleReplanRequest } from "@contexts/coordination/application/plan-coverage.ts";
import { pageCandidate } from "../../../support/use-case-candidate.ts";

const redaction = new PatternRedactionAdapter();

const prefixOf = (prompt: Prefixed): string => Buffer.from(prompt.text, "utf8").subarray(0, prompt.stablePrefixBytes).toString("utf8");

function assertSharedPrefix(a: Prefixed, b: Prefixed): void {
  assert.ok(a.stablePrefixBytes > 0, "the prompt opens with a stable prefix");
  assert.equal(prefixOf(a), prefixOf(b), "the stable prefix is byte-identical across runs");
  assert.notEqual(a.text, b.text, "the two runs differ in their facts");
}

const authorBrief = (n: number): DelegationBrief =>
  createDelegationBrief({
    redaction,
    delegationId: `run-${n}-flow-${n}`,
    runId: `run-${n}`,
    objective: `cover checkout ${n}`,
    task: `write the spec ${n}`,
    scope: { readablePaths: ["."], writablePaths: [`e2e/flows/checkout-${n}.spec.ts`], allowedCommands: [] },
    acceptanceCriteria: [`checkout ${n} completes`],
    knownFacts: [{ id: `fact-${n}`, kind: "grounding", summary: `the cart holds ${n} items`, source: "context-pack", confidence: "observed" }],
    tools: ["read", "write", "run_spec"],
  });

const exploreBrief = (n: number): DelegationBrief =>
  createDelegationBrief({
    redaction,
    delegationId: `run-${n}-explore-q${n}`,
    runId: `run-${n}`,
    objective: `does the cart list ${n} items?`,
    task: "Answer ONE question for the lead, read-only.",
    scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] },
    tools: ["read", "codegraph"],
  });

test("the flow author's brief opens with a stable prefix that two runs share byte for byte, and its run ids are outside it", () => {
  const one = renderSidekickBrief(redaction, authorBrief(1));
  assertSharedPrefix(one, renderSidekickBrief(redaction, authorBrief(2)));
  assert.ok(!prefixOf(one).includes("run-1"));
});

test("the explore brief opens with a stable prefix that two runs share byte for byte", () => {
  assertSharedPrefix(renderExploreBrief(redaction, exploreBrief(1)), renderExploreBrief(redaction, exploreBrief(2)));
});

test("a lead turn's closing instruction stays last, after the run's facts it answers", () => {
  const outcome = assembleExploreOutcome(redaction, { ran: true, questions: [{ id: "q1", question: "?", status: "answered", findings: [] }] });
  assert.deepEqual(Object.keys(outcome.sectionSizes), ["exploration", "answer"]);
  const replan = assembleReplanRequest(redaction, [pageCandidate("/cart")], [], { capacity: 1, notAdmitted: [{ id: "f2", objective: "o", candidates: [] }] });
  assert.deepEqual(Object.keys(replan.sectionSizes), ["unresolved", "not-admitted", "answer"]);
});
