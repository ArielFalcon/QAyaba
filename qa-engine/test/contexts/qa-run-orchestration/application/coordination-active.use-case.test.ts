// Fase 13 — active pre-generate: sidekick may replace GenerationPort; shadow never does;
 // needs-lead / missing sidekick fail open to the lead GenerationPort.
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
} from "@contexts/qa-run-orchestration/application/ports/index.ts";
import {
  createCoordinationPort,
  InMemoryCoordinationTelemetry,
  SidekickExecutor,
  type DelegationResult,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";
import type { AgentSession } from "@kernel/ports/agent-runtime.port.ts";

function basePorts(generate: GenerationPort["generate"]) {
  const changeAnalysis: ChangeAnalysisPort = {
    classify: async () => ({
      action: "generate",
      reason: "diff touches many files",
      diff: "x",
      intent: { type: "feat", breaking: false, message: "cover checkout", changedFiles: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`) },
      contradiction: true,
    }),
  };
  const generation: GenerationPort = { generate };
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
    prepare: async () => ({ specDir: "/tmp/qa-active/e2e", mirrorDir: "/tmp/qa-active" }),
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

const input = {
  app: "demo",
  sha: Sha.of("abc1234"),
  source: "manual" as const,
  mode: "diff" as const,
  target: "e2e" as const,
  runId: "coord-active-1",
};

function sessionReturning(result: DelegationResult): AgentSession {
  return {
    async prompt() {
      return { output: JSON.stringify(result) };
    },
    async dispose() {},
  };
}

test("shadow mode with delegate proposal still calls GenerationPort (advisory)", async () => {
  let generateCalls = 0;
  const ports = basePorts(async () => {
    generateCalls++;
    return { specs: ["lead.spec.ts"], approved: true };
  });
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () =>
        sessionReturning({
          delegationId: "coord-active-1-pre-generate",
          runId: "coord-active-1",
          status: "completed",
          summary: "should not run",
          filesChanged: [{ path: "e2e/sidekick.spec.ts" }],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
        }),
    },
  });
  const useCase = new RunQaUseCase({
    ...ports,
    coordination: createCoordinationPort("shadow"),
    coordinationEnabledPoints: ["pre-generate"],
    sidekick,
  });
  const out = await useCase.run(input);
  assert.equal(generateCalls, 1);
  assert.equal(out.decision.verdict, "pass");
});

test("active pre-generate uses sidekick specs and skips GenerationPort on success", async () => {
  let generateCalls = 0;
  const ports = basePorts(async () => {
    generateCalls++;
    return { specs: ["lead.spec.ts"], approved: true };
  });
  const tel = new InMemoryCoordinationTelemetry();
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () =>
        sessionReturning({
          delegationId: "coord-active-1-pre-generate",
          runId: "coord-active-1",
          status: "completed",
          summary: "wrote sidekick spec",
          filesChanged: [{ path: "e2e/sidekick.spec.ts" }],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
        }),
    },
  });
  const useCase = new RunQaUseCase({
    ...ports,
    coordination: createCoordinationPort("active"),
    coordinationEnabledPoints: ["pre-generate"],
    coordinationTelemetry: tel,
    sidekick,
  });
  const out = await useCase.run(input);
  assert.equal(generateCalls, 0);
  assert.equal(out.decision.verdict, "pass");
  assert.ok(tel.events.some((e) => e.kind === "delegation"));
});

test("active pre-generate falls back to lead GenerationPort when sidekick needs-lead", async () => {
  let generateCalls = 0;
  const ports = basePorts(async () => {
    generateCalls++;
    return { specs: ["lead.spec.ts"], approved: true };
  });
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () =>
        sessionReturning({
          delegationId: "coord-active-1-pre-generate",
          runId: "coord-active-1",
          status: "needs-lead",
          summary: "architecture unclear",
          filesChanged: [],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: ["which layout?"],
          recommendation: "escalate",
        }),
    },
  });
  const useCase = new RunQaUseCase({
    ...ports,
    coordination: createCoordinationPort("active"),
    coordinationEnabledPoints: ["pre-generate"],
    sidekick,
  });
  const out = await useCase.run(input);
  assert.equal(generateCalls, 1);
  assert.equal(out.decision.verdict, "pass");
});

test("active without enabled points never calls sidekick", async () => {
  let generateCalls = 0;
  let sidekickCalls = 0;
  const ports = basePorts(async () => {
    generateCalls++;
    return { specs: ["lead.spec.ts"], approved: true };
  });
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () => {
        sidekickCalls++;
        return sessionReturning({
          delegationId: "x",
          runId: "coord-active-1",
          status: "completed",
          summary: "nope",
          filesChanged: [{ path: "e2e/x.spec.ts" }],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
        });
      },
    },
  });
  const useCase = new RunQaUseCase({
    ...ports,
    coordination: createCoordinationPort("active"),
    coordinationEnabledPoints: [],
    sidekick,
  });
  await useCase.run(input);
  assert.equal(sidekickCalls, 0);
  assert.equal(generateCalls, 1);
});
