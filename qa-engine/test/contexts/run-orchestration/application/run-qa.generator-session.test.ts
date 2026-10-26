/* The generator session the run keeps for its regenerations is released when the run ends, however it ends, and a release that fails never changes the result. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";

const INPUT: RunQaInput = { app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "session-run" };
const PASS: QaCase[] = [{ name: "a", status: "pass", file: "flows/a.spec.ts" }];

function rig(opts: { executeThrows?: boolean; releaseThrows?: boolean } = {}): { events: string[]; deps: RunQaUseCaseDeps } {
  const ws = runWorkspace("qa-gen-session-");
  const events: string[] = [];
  const deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    generation: generationOnDisk({
      generate: async () => {
        events.push("generate");
        return scriptedGeneration({ specs: ["flows/a.spec.ts"], approved: true });
      },
      release: async () => {
        events.push("release");
        if (opts.releaseThrows) throw new Error("session already gone");
      },
    }),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => { if (opts.executeThrows) throw new Error("runner exploded"); return { verdict: "pass", cases: PASS, logs: "" }; } },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async () => {} },
    confinement: { enforce: async () => ({ strays: 0, dangerous: 0, reverted: [] }) },
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false },
  };
  return { events, deps };
}

test("the generator session is released once, after the last generation, when the run ends with a result", async () => {
  const r = rig();
  const out = await new RunQaUseCase(r.deps).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(r.events.filter((e) => e === "release"), ["release"]);
  assert.equal(r.events.at(-1), "release");
});

test("the generator session is released when the run throws", async () => {
  const r = rig({ executeThrows: true });
  await assert.rejects(new RunQaUseCase(r.deps).run(INPUT));
  assert.deepEqual(r.events.filter((e) => e === "release"), ["release"]);
});

test("a release that throws does not change the run's result", async () => {
  const r = rig({ releaseThrows: true });
  const out = await new RunQaUseCase(r.deps).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
});
