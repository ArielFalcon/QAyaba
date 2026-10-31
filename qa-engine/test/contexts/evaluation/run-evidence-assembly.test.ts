import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRunEvidence, type EvidenceSources } from "@contexts/evaluation/application/index.ts";

const sources = (over: Partial<EvidenceSources> = {}): EvidenceSources => ({
  runId: "run-1",
  record: { app: "demo", sha: "abcdef1", mode: "diff", status: "done", verdict: "pass", cases: [], at: "2026-10-31T00:00:00.000Z" },
  phases: { furthestPhase: "execute" },
  facts: undefined,
  outcome: undefined,
  spans: [],
  turns: [],
  snapshots: [],
  plan: undefined,
  ...over,
});

const context = { references: [], reviewerAgent: "qa-reviewer" };

test("a run that recorded no outcome, facts or turns leaves each of them unsaid", () => {
  const evidence = assembleRunEvidence(sources(), context);
  assert.equal(evidence.finished, true);
  assert.equal(evidence.signals, undefined);
  assert.equal(evidence.decision, null);
  assert.equal(evidence.reviewerTurns, undefined);
  assert.equal(evidence.reviewRequired, undefined);
  assert.equal(evidence.limit, undefined);
  assert.equal(evidence.finishedAt, "2026-10-31T00:00:00.000Z");
});

test("the reviewer's turns are those of the agent the roster names", () => {
  const turns = [{ role: "qa-reviewer" }, { role: "qa-author" }, { role: "qa-reviewer" }];
  assert.equal(assembleRunEvidence(sources({ turns }), context).reviewerTurns, 2);
  assert.equal(assembleRunEvidence(sources({ turns }), { ...context, reviewerAgent: "reviewer-2" }).reviewerTurns, 0);
});

test("the limit the run records leads, with the intent of its role's last step read from the ledger", () => {
  const facts = { cancelled: null, decision: "none", reviewRequired: null, coverageStatus: "pass", coverageMode: "signal", limitFired: "step-cap", limitRole: "qa-author", limits: [{ fired: "step-cap", role: "qa-author", scope: "turn" as const }] };
  const spans = [
    { name: "invoke_agent qa-author", spanId: "t1", parentSpanId: null, attrs: JSON.stringify({ "gen_ai.agent.name": "qa-author", "qayaba.limit.fired": "step-cap" }) },
    { name: "chat model", spanId: "c1", parentSpanId: "t1", attrs: JSON.stringify({ "qayaba.step.intent": "read" }) },
  ];
  const evidence = assembleRunEvidence(sources({ facts, spans }), context);
  assert.deepEqual(evidence.limit, { fired: "step-cap", role: "qa-author", intent: "read" });
  assert.deepEqual(evidence.stepIntents, { read: 1 });
  assert.equal(evidence.decision, "none");
});

test("a reference use case is named when a candidate's page names one of its routes", () => {
  const plan = JSON.stringify({ kind: "fanout", changeRoutes: [], candidates: [{ id: "c1", state: "planned", pages: ["/shops/:id"] }], flows: [] });
  const references = [{ app: "demo", changes: [{ sha: "abcdef1", summary: "s", useCases: [{ id: "u1", description: "d", reachability: "dev" as const, routes: ["/shops/:shop"] }] }] }];
  const evidence = assembleRunEvidence(sources({ plan }), { ...context, references });
  assert.deepEqual(evidence.reference, { useCases: [{ id: "u1", named: true }], unlabelledCandidates: 0 });
});
