import { test } from "node:test";
import assert from "node:assert/strict";
import { RunQaUseCase, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { RUN_PHASES, phaseSnapshotOf } from "@contexts/run-orchestration/domain/run-phase-cursor.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { ok } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";

/* A clock that only moves when a port "takes time", so phase durations are exact. */
function steppedClock() {
  let t = 10_000;
  return { now: () => t, spend: (ms: number) => { t += ms; } };
}

type Overrides = Partial<{
  classify: RunQaUseCaseDeps["changeAnalysis"]["classify"];
  generate: RunQaUseCaseDeps["generation"]["generate"];
  validate: RunQaUseCaseDeps["validation"]["validate"];
  setup: () => Promise<void>;
  ground: NonNullable<RunQaUseCaseDeps["preGenerationGrounding"]>["ground"];
}>;

function harness(overrides: Overrides = {}) {
  const ws = runWorkspace("qa-phase-");
  const clock = steppedClock();
  const saved: RunOutcome[] = [];
  const deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: overrides.classify ?? (async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" })) },
    generation: generationOnDisk({ generate: overrides.generate ?? (async () => scriptedGeneration({ specs: ["a.spec.ts"], approved: true })) }),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: overrides.validate ?? (async () => ({ ok: true, errors: [] })) },
    execution: { execute: async () => ({ verdict: "pass", cases: [], logs: "" }) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    /* What the store keeps is the bytes at save time: a later change to the object must not reach it. */
    runHistory: { save: async (outcome) => { saved.push(structuredClone(outcome)); } },
    setup: { setup: overrides.setup ?? (async () => {}) },
    ...(overrides.ground ? { preGenerationGrounding: { ground: overrides.ground } } : {}),
    config: { needsReview: true },
    phaseClock: clock,
  };
  return { useCase: new RunQaUseCase(deps), clock, saved };
}

const input = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, mode: "diff" as const, target: "e2e" as const, runId: "phase-cursor" };

test("a run that passes through every stage reports learn as its furthest phase and the time of each stage it entered", async () => {
  const { useCase, clock } = harness({
    generate: async () => { clock.spend(40); return scriptedGeneration({ specs: ["a.spec.ts"], approved: true }); },
  });

  const out = await useCase.run(input);

  assert.equal(out.gateSignals.furthestPhase, "learn");
  const entered = Object.keys(out.gateSignals.phaseTimings ?? {});
  assert.deepEqual(entered, RUN_PHASES.filter((p) => p !== "fix_loop"));
  assert.equal(out.gateSignals.phaseTimings?.generate, 40);
  assert.equal(out.gateSignals.phaseTimings?.gate, 0);
});

test("the phase record is on the returned outcome only: what was persisted carries none, and the returned outcome is a new object", async () => {
  const { useCase, saved } = harness();

  const out = await useCase.run(input);

  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.gateSignals.furthestPhase, undefined);
  assert.equal(saved[0]!.gateSignals.phaseTimings, undefined);
  assert.equal(out.outcome?.gateSignals.furthestPhase, "learn");
  assert.deepEqual(out.outcome?.gateSignals.phaseTimings, out.gateSignals.phaseTimings);
  assert.equal(out.outcome?.verdict, saved[0]!.verdict);
});

test("a commit the classifier skips ends with classify as its furthest phase", async () => {
  const { useCase } = harness({ classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }) });

  const out = await useCase.run(input);

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(out.gateSignals.furthestPhase, "classify");
  assert.deepEqual(Object.keys(out.gateSignals.phaseTimings ?? {}), ["gate", "workspace", "classify"]);
});

test("a setup failure ends as an infra-error whose furthest phase is setup", async () => {
  const { useCase } = harness({ setup: async () => { throw new Error("npm ci failed"); } });

  const out = await useCase.run(input);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.gateSignals.furthestPhase, "setup");
});

test("a static gate failure is persisted with validate as its furthest phase", async () => {
  const { useCase, saved } = harness({ validate: async () => ({ ok: false, errors: ["TS2304"] }) });

  const out = await useCase.run(input);

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.gateSignals.furthestPhase, "validate");
  assert.equal(out.outcome?.gateSignals.furthestPhase, "validate");
  assert.equal(saved[0]!.gateSignals.furthestPhase, undefined);
});

test("the run deadline stopping the generator ends the run with generate as its furthest phase", async () => {
  const { useCase, saved } = harness({
    generate: async () => { throw new RunDeadlineExceededError(600_000, "diff-tiny", "primary", "mid-turn"); },
  });

  const out = await useCase.run(input);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.gateSignals.furthestPhase, "generate");
  assert.equal(out.outcome?.gateSignals.furthestPhase, "generate");
  assert.equal(saved[0]!.gateSignals.furthestPhase, undefined);
});

test("an operator abort during grounding ends the run with ground as its furthest phase", async () => {
  const controller = new AbortController();
  const { useCase } = harness({ ground: async () => { controller.abort(); return {}; } });

  const out = await useCase.run(input, controller.signal);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.gateSignals.furthestPhase, "ground");
});

test("an already-aborted run has entered no phase", async () => {
  const controller = new AbortController();
  controller.abort();
  const { useCase } = harness();

  const out = await useCase.run(input, controller.signal);

  assert.equal(out.gateSignals.furthestPhase, undefined);
  assert.equal(out.gateSignals.phaseTimings, undefined);
});

test("an error the run does not handle still tells the caller how far the run got", async () => {
  const failure = new Error("agent runtime failed mid-turn");
  const { useCase } = harness({ generate: async () => { throw failure; } });

  await assert.rejects(() => useCase.run(input), (err) => err === failure);

  assert.equal(phaseSnapshotOf(failure)?.furthestPhase, "generate");
  assert.ok(phaseSnapshotOf(failure)?.phaseTimings.generate !== undefined);
});
