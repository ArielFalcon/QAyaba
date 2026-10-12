/* A run started for a purpose (not to test a change) says so on its persisted record, and the purpose changes nothing else. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RUN_PURPOSE } from "@kernel/run-mode.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";

const INPUT = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, mode: "manual" as const, target: "e2e" as const, runId: "purpose-run" };

function useCase(saved: RunOutcome[], opts: { verdict?: "pass" | "fail"; note?: string } = {}): RunQaUseCase {
  return new RunQaUseCase({
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "x", diff: "" }) },
    generation: { generate: async () => scriptedGeneration({ specs: ["a.spec.ts"], approved: true }) },
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => ({ verdict: opts.verdict ?? "pass", cases: [], logs: "" }) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: { prepare: async () => ({ specDir: "/tmp/qa-purpose/e2e", mirrorDir: "/tmp/qa-purpose" }) },
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async (outcome) => { saved.push(outcome); } },
    setup: { setup: async () => {} },
    config: { needsReview: false },
  });
}

test("a login-bootstrap run is tagged on the persisted note, and its verdict and decision are those of any manual run", async () => {
  const saved: RunOutcome[] = [];
  const out = await useCase(saved).run({ ...INPUT, purpose: RUN_PURPOSE.LOGIN_BOOTSTRAP });
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.note, "[login-bootstrap] pr", "the tag leads the publish outcome the note carries");
});

test("the tag leads whatever diagnostic note the run carries", async () => {
  const saved: RunOutcome[] = [];
  const out = await useCase(saved, { verdict: "fail" }).run({ ...INPUT, runId: "purpose-fail", purpose: RUN_PURPOSE.LOGIN_BOOTSTRAP });
  assert.equal(out.decision.verdict, "fail");
  assert.match(saved[0]?.note ?? "", /^\[login-bootstrap\]/);
});

test("a run with no purpose persists the note exactly as before", async () => {
  const saved: RunOutcome[] = [];
  await useCase(saved).run(INPUT);
  assert.equal(saved[0]?.note, "pr");
});
