// Fase 12 — shadow divergence is recorded; pipeline still governs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RunQaUseCase } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import type {
  ChangeAnalysisPort,
  GenerationPort,
  ReviewPort,
  ValidationPort,
  ExecutionPort,
  ObjectiveSignalPort,
  PublicationPort,
  LearningPort,
  WorkspacePort,
  DeployGatePort,
  RunHistoryPort,
  SetupPort,
  CleanupPort,
  ObserverPort,
} from "@contexts/qa-run-orchestration/application/ports/index.ts";
import {
  createCoordinationPort,
  InMemoryCoordinationTelemetry,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

function ports() {
  const changeAnalysis: ChangeAnalysisPort = {
    classify: async () => ({
      action: "generate",
      reason: "diff touches many files",
      diff: "x",
      intent: {
        type: "feat",
        breaking: false,
        message: "cover checkout",
        changedFiles: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`),
      },
      contradiction: true,
    }),
  };
  const generation: GenerationPort = {
    generate: async () => ({ specs: ["lead.spec.ts"], approved: true }),
  };
  const review: ReviewPort = {
    review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }),
  };
  const validation: ValidationPort = { validate: async () => ({ ok: true, errors: [] }) };
  const execution: ExecutionPort = {
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
  };
  const objectiveSignal: ObjectiveSignalPort = {
    measure: async () => ({ status: "unknown", ratio: null }),
    blocks: () => false,
  };
  const publication: PublicationPort = { publish: async () => ({ outcome: "pr" }) };
  const learning: LearningPort = { fold: async () => {}, retrieve: async () => [] };
  const workspace: WorkspacePort = {
    prepare: async () => ({ specDir: "/tmp/qa-shadow/e2e", mirrorDir: "/tmp/qa-shadow" }),
  };
  const deployGate: DeployGatePort = { waitUntilServing: async () => ok(true) };
  const runHistory: RunHistoryPort = { save: async () => {} };
  const setup: SetupPort = { setup: async () => {} };
  const cleanup: CleanupPort = { cleanup: async () => {} };
  return {
    changeAnalysis,
    generation,
    review,
    validation,
    execution,
    objectiveSignal,
    publication,
    learning,
    workspace,
    deployGate,
    runHistory,
    setup,
    cleanup,
    config: {
      needsReview: true,
      shadow: false,
      onFailure: "github-issue",
      maxRetries: 2,
      isCode: false,
      coveragePolicyMode: "signal" as const,
    },
  };
}

test("shadow mode records non-comparable divergence for delegate proposals", async () => {
  const tel = new InMemoryCoordinationTelemetry();
  const logs: string[] = [];
  const observer: ObserverPort = {
    onStep() {},
    onEvent(e) {
      if (e.type === "log.line") logs.push(e.text);
    },
  };
  const useCase = new RunQaUseCase({
    ...ports(),
    coordination: createCoordinationPort("shadow"),
    coordinationTelemetry: tel,
    observer,
  });
  const out = await useCase.run({
    app: "demo",
    sha: Sha.of("abc1234"),
    source: "manual",
    mode: "diff",
    target: "e2e",
    runId: "coord-shadow-1",
  });
  assert.equal(out.decision.verdict, "pass");
  assert.ok(tel.events.some((e) => e.kind === "proposal" && e.action === "delegate"));
  assert.ok(
    tel.events.some((e) => e.kind === "router" && e.reason.includes("shadow-divergence=non-comparable")),
  );
  assert.ok(logs.some((t) => t.includes("shadow divergence: non-comparable")));
  const outcome = tel.events.find((e) => e.kind === "outcome");
  assert.ok(outcome);
  assert.equal(outcome!.finalOutcome, "pass");
  assert.equal(outcome!.reviewOutcome, "approved");
});
