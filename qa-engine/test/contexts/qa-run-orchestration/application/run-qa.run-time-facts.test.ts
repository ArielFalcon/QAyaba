import { test } from "node:test";
import assert from "node:assert/strict";
import { RunQaUseCase, type RunQaUseCaseDeps, type RunQaConfig } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import { ok } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";
import { traceFactsOf } from "@kernel/run-trace-facts.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";

function build(config: Partial<RunQaConfig>, measure: RunQaUseCaseDeps["objectiveSignal"]["measure"], verdict: "pass" | "fail" = "pass") {
  const ws = runWorkspace("qa-facts-");
  const deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    generation: generationOnDisk({ generate: async () => scriptedGeneration({ specs: ["a.spec.ts"], approved: true }) }),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => ({ verdict, cases: [], logs: "" }) },
    objectiveSignal: { measure, blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: { prepare: async () => ({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }) },
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async () => {} },
    setup: { setup: async () => {} },
    config: { needsReview: true, ...config },
  };
  return new RunQaUseCase(deps);
}

const input = (mode: "diff" | "context") => ({ app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, mode, target: "e2e" as const, runId: "facts" });

test("a run that measured coverage reports the engine's decision with the policy in force, and that a reviewer was due", async () => {
  const useCase = build({ coveragePolicyMode: "enforce", coverageMinRatio: 0.8 }, async () => ({ status: "fail", ratio: 0.5 }));
  const facts = traceFactsOf(await useCase.run(input("diff")));
  assert.equal(facts?.reviewRequired, true);
  assert.deepEqual(facts?.coverage, { status: "fail", mode: "enforce", minRatio: 0.8 });
});

test("a run that never measured coverage reports the policy but no decision", async () => {
  const useCase = build({ coveragePolicyMode: "signal" }, async () => ({ status: "pass", ratio: 1 }), "fail");
  const facts = traceFactsOf(await useCase.run(input("diff")));
  assert.equal(facts?.coverage?.status, undefined);
  assert.equal(facts?.coverage?.mode, "signal");
});

test("a run with review turned off, or a context run, reports that no reviewer was due", async () => {
  const off = build({ needsReview: false }, async () => ({ status: "unknown", ratio: null }));
  assert.equal(traceFactsOf(await off.run(input("diff")))?.reviewRequired, false);
  const context = build({ needsReview: true }, async () => ({ status: "unknown", ratio: null }));
  assert.equal(traceFactsOf(await context.run(input("context")))?.reviewRequired, false);
});
