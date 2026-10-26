import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evidenceFromBudget,
  evidenceFromChangeAnalysis,
  evidenceFromCoverage,
  evidenceFromExecution,
  evidenceFromFailureClass,
  evidenceFromFixLoop,
  evidenceFromGeneration,
  evidenceFromReview,
  evidenceFromSelectors,
  evidenceFromValidation,
} from "@contexts/coordination/application/evidence-from.ts";
import {
  agentClaimInvalidatedBy,
  confidenceRank,
  preferredEvidence,
} from "@contexts/coordination/application/evidence-precedence.ts";
import type { EvidenceRef } from "@contexts/coordination/application/evidence-ref.ts";
import { PatternRedactionAdapter } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

test("evidence adapters produce refs with stable kinds and no OpencodeRunInput fields", () => {
  const refs = [
    evidenceFromChangeAnalysis(redaction, { action: "generate", reason: "feat", fileCount: 3 }),
    evidenceFromGeneration(redaction, { specs: 2, approved: true, parsed: true }),
    evidenceFromValidation(redaction, { ok: false, errors: 2 }),
    evidenceFromExecution(redaction, { verdict: "fail", failing: 1 }),
    evidenceFromFixLoop(redaction, { retries: 1, adjudicator: "flaky" }),
    evidenceFromCoverage(redaction, { status: "fail", ratio: 0.4 }),
    evidenceFromReview(redaction, { approved: false, blocking: 1 }),
    evidenceFromSelectors(redaction, { contradictions: 2 }),
    evidenceFromBudget(redaction, { cycleCeiling: 4, wallClockMs: 60_000 }),
    evidenceFromFailureClass(redaction, "selector"),
  ];
  for (const ref of refs) {
    assert.ok(ref.id);
    assert.ok(ref.kind);
    assert.ok(ref.source);
    assert.ok(ref.summary);
    assert.ok(ref.confidence);
    assert.equal(Object.hasOwn(ref, "diff"), false);
    assert.equal(Object.hasOwn(ref, "existingSpecs"), false);
    assert.equal(Object.hasOwn(ref, "learnedRules"), false);
  }
  assert.equal(evidenceFromChangeAnalysis(redaction, { action: "skip", reason: "docs", fileCount: 0 }).confidence, "deterministic");
  assert.equal(evidenceFromGeneration(redaction, { specs: 0, approved: true }).confidence, "observed");
  assert.equal(evidenceFromReview(redaction, { approved: true, blocking: 0 }).confidence, "reviewed");
});

test("confidence order is deterministic > reviewed > observed > inferred", () => {
  assert.ok(confidenceRank("deterministic") > confidenceRank("reviewed"));
  assert.ok(confidenceRank("reviewed") > confidenceRank("observed"));
  assert.ok(confidenceRank("observed") > confidenceRank("inferred"));
});

test("preferredEvidence keeps the higher-confidence claim", () => {
  const det: EvidenceRef = {
    id: "v",
    kind: "validation",
    source: "ValidationPort",
    summary: "fail; errors=1",
    confidence: "deterministic",
  };
  const agent: EvidenceRef = {
    id: "a",
    kind: "agent-observation",
    source: "sidekick",
    summary: "completed",
    confidence: "inferred",
  };
  assert.equal(preferredEvidence(det, agent), det);
  assert.equal(preferredEvidence(agent, det), det);
});

test("agentClaimInvalidatedBy returns deterministic failure when it contradicts agent success", () => {
  const evidence: EvidenceRef[] = [
    {
      id: "a",
      kind: "agent-observation",
      source: "sidekick",
      summary: "completed successfully",
      confidence: "inferred",
    },
    evidenceFromValidation(redaction, { ok: false, errors: 2 }),
  ];
  const invalidator = agentClaimInvalidatedBy(evidence);
  assert.ok(invalidator);
  assert.equal(invalidator.kind, "validation");
  assert.equal(invalidator.confidence, "deterministic");
});

test("agentClaimInvalidatedBy is undefined when deterministic evidence agrees or is absent", () => {
  assert.equal(
    agentClaimInvalidatedBy([
      {
        id: "a",
        kind: "agent-observation",
        source: "sidekick",
        summary: "completed",
        confidence: "inferred",
      },
      evidenceFromValidation(redaction, { ok: true, errors: 0 }),
    ]),
    undefined,
  );
  assert.equal(agentClaimInvalidatedBy([evidenceFromExecution(redaction, { verdict: "fail", failing: 1 })]), undefined);
});

test("budget evidence reports both the cycle ceiling and the wall-clock budget", () => {
  const ref = evidenceFromBudget(redaction, { cycleCeiling: 7, wallClockMs: 45_000 });

  assert.match(ref.summary, /\b7\b/);
  assert.match(ref.summary, /\b45000\b/);
});
