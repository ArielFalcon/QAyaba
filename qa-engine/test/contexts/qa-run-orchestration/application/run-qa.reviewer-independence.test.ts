/* Whether the reviewer judged with the generator's own model is a fact of the run, recorded on its persisted gate signals. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase, type RunQaConfig, type RunQaUseCaseDeps } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";

async function persistedOutcome(config: Partial<RunQaConfig>): Promise<RunOutcome> {
  const ws = runWorkspace("qa-reviewer-independence-");
  const saved: RunOutcome[] = [];
  const deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    generation: generationOnDisk({ generate: async () => scriptedGeneration({ specs: ["a.spec.ts"], approved: true }) }),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => ({ verdict: "pass", cases: [], logs: "" }) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: { prepare: async () => ({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }) },
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async (outcome: RunOutcome) => { saved.push(outcome); } },
    setup: { setup: async () => {} },
    config: { needsReview: true, ...config },
  };
  await new RunQaUseCase(deps).run({ app: "demo", sha: Sha.of("abc1234"), source: "manual", target: "e2e", mode: "diff", runId: "independence" });
  assert.equal(saved.length, 1);
  return saved[0]!;
}

test("a run records shared-model in its persisted gate signals when the config says so", async () => {
  const outcome = await persistedOutcome({ reviewerIndependence: "shared-model" });
  assert.equal(outcome.gateSignals.reviewerIndependence, "shared-model");
});

test("a run records distinct-model when the config says so", async () => {
  const outcome = await persistedOutcome({ reviewerIndependence: "distinct-model" });
  assert.equal(outcome.gateSignals.reviewerIndependence, "distinct-model");
});

test("a run records nothing when the config is silent", async () => {
  const outcome = await persistedOutcome({});
  assert.equal("reviewerIndependence" in outcome.gateSignals, false);
});
