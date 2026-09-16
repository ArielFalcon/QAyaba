// Fase 8 — FixLoop regen capability: sidekick may regenerate via FixLoopGenerationPort;
// FixLoop keeps retries/adjudication. Point is independent of pre-generate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

const MIRROR = "/tmp/qa-fixloop";
const SPEC_DIR = `${MIRROR}/e2e`;

function ensureFixedSpec() {
  mkdirSync(SPEC_DIR, { recursive: true });
  writeFileSync(`${MIRROR}/e2e/fixed.spec.ts`, "// fixed");
}

function basePorts(opts: {
  generate: GenerationPort["generate"];
  execute: ExecutionPort["execute"];
  wallClockBudgetMs?: number;
}) {
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
  const generation: GenerationPort = { generate: opts.generate };
  const review: ReviewPort = {
    review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }),
  };
  const validation: ValidationPort = { validate: async () => ({ ok: true, errors: [] }) };
  const execution: ExecutionPort = { execute: opts.execute };
  const objectiveSignal: ObjectiveSignalPort = {
    measure: async () => ({ status: "unknown", ratio: null }),
    blocks: () => false,
  };
  const publication: PublicationPort = { publish: async () => ({ outcome: "pr" }) };
  const learning: LearningPort = { fold: async () => {}, retrieve: async () => [] };
  const workspace: WorkspacePort = {
    prepare: async () => ({ specDir: SPEC_DIR, mirrorDir: MIRROR }),
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
      ...(opts.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: opts.wallClockBudgetMs } : {}),
    },
  };
}

const input = {
  app: "demo",
  sha: Sha.of("abc1234"),
  source: "manual" as const,
  mode: "diff" as const,
  target: "e2e" as const,
  runId: "coord-fixloop-1",
};

function sessionReturning(result: DelegationResult): AgentSession {
  return {
    async prompt() {
      return { output: JSON.stringify(result) };
    },
    async dispose() {},
  };
}

test("active fix-loop-regen uses sidekick for FixLoop regen and skips GenerationPort on that round", async () => {
  ensureFixedSpec();
  let generateCalls = 0;
  let executeCalls = 0;
  let sidekickCalls = 0;
  const ports = basePorts({
    generate: async () => {
      generateCalls++;
      return { specs: ["lead.spec.ts"], approved: true };
    },
    execute: async () => {
      executeCalls++;
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "login", status: "fail", detail: "boom" }], logs: "" };
      }
      return { verdict: "pass", cases: [{ name: "login", status: "pass" }], logs: "" };
    },
  });
  const tel = new InMemoryCoordinationTelemetry();
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () => {
        sidekickCalls++;
        return sessionReturning({
          delegationId: "coord-fixloop-1-fix-loop-regen",
          runId: "coord-fixloop-1",
          status: "completed",
          summary: "fixed selector",
          filesChanged: [{ path: "e2e/fixed.spec.ts" }],
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
    coordination: createCoordinationPort(),
    // Only FixLoop point — pre-generate stays off so initial gen is still GenerationPort.
    coordinationEnabledPoints: ["fix-loop-regen"],
    coordinationTelemetry: tel,
    sidekick,
  });
  const out = await useCase.run(input);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(generateCalls, 1, "initial generate uses lead; FixLoop regen must not call GenerationPort");
  assert.equal(sidekickCalls, 1, "exactly one FixLoop sidekick regen");
  assert.ok(executeCalls >= 2, "FixLoop must re-execute after regen");
  assert.ok(tel.events.some((e) => e.kind === "delegation" && e.reason?.includes("fix-loop")));
});

test("active with only pre-generate enabled keeps FixLoop on GenerationPort", async () => {
  let generateCalls = 0;
  let executeCalls = 0;
  let sidekickCalls = 0;
  const ports = basePorts({
    generate: async () => {
      generateCalls++;
      return { specs: ["lead.spec.ts"], approved: true };
    },
    execute: async () => {
      executeCalls++;
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "login", status: "fail", detail: "boom" }], logs: "" };
      }
      return { verdict: "pass", cases: [{ name: "login", status: "pass" }], logs: "" };
    },
  });
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () => {
        sidekickCalls++;
        // needs-lead so pre-generate fails open to GenerationPort; FixLoop must not call sidekick.
        return sessionReturning({
          delegationId: "coord-fixloop-2-pre-generate",
          runId: "coord-fixloop-2",
          status: "needs-lead",
          summary: "pre-generate only",
          filesChanged: [],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: ["layout?"],
          recommendation: "escalate",
        });
      },
    },
  });
  const useCase = new RunQaUseCase({
    ...ports,
    coordination: createCoordinationPort(),
    coordinationEnabledPoints: ["pre-generate"],
    sidekick,
  });
  const out = await useCase.run({ ...input, runId: "coord-fixloop-2" });
  assert.equal(out.decision.verdict, "pass");
  assert.ok(generateCalls >= 2, "FixLoop regen must use GenerationPort when fix-loop-regen is disabled");
  assert.equal(sidekickCalls, 1, "pre-generate may call sidekick once; FixLoop must not");
});

test("FixLoop needs-lead advances escalation ladder and fails open to GenerationPort", async () => {
  let generateCalls = 0;
  let executeCalls = 0;
  const capabilities: string[] = [];
  const ports = basePorts({
    generate: async () => {
      generateCalls++;
      return { specs: ["lead.spec.ts"], approved: true };
    },
    execute: async () => {
      executeCalls++;
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "login", status: "fail", detail: "boom" }], logs: "" };
      }
      return { verdict: "pass", cases: [{ name: "login", status: "pass" }], logs: "" };
    },
  });
  const tel = new InMemoryCoordinationTelemetry();
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () =>
        sessionReturning({
          delegationId: "coord-fixloop-needs-fix-loop-regen",
          runId: "coord-fixloop-needs",
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
  const originalExecute = sidekick.execute.bind(sidekick);
  sidekick.execute = async (brief, opts) => {
    capabilities.push(opts.capability);
    return originalExecute(brief, opts);
  };
  const useCase = new RunQaUseCase({
    ...ports,
    coordination: createCoordinationPort(),
    coordinationEnabledPoints: ["fix-loop-regen"],
    coordinationTelemetry: tel,
    sidekick,
  });
  const out = await useCase.run({ ...input, runId: "coord-fixloop-needs" });
  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(capabilities, ["sidekick-standard"]);
  assert.equal(generateCalls, 2, "initial generate + FixLoop fail-open GenerationPort");
  assert.ok(
    tel.events.some(
      (e) => e.kind === "escalation" && e.capability === "sidekick-escalated" && e.reason.includes("needs-lead"),
    ),
  );
});

test("FixLoop honors abort-human when wall-clock budget is exhausted", async () => {
  let generateCalls = 0;
  let executeCalls = 0;
  let sidekickCalls = 0;
  const ports = basePorts({
    // 0 ms ceiling: any positive elapsed trips exhausted() → router abort-human.
    wallClockBudgetMs: 0,
    generate: async () => {
      generateCalls++;
      return { specs: ["lead.spec.ts"], approved: true };
    },
    execute: async () => {
      executeCalls++;
      return { verdict: "fail", cases: [{ name: "login", status: "fail", detail: "boom" }], logs: "" };
    },
  });
  const tel = new InMemoryCoordinationTelemetry();
  const sidekick = new SidekickExecutor({
    runtime: {
      openSession: async () => {
        sidekickCalls++;
        return sessionReturning({
          delegationId: "coord-fixloop-abort-fix-loop-regen",
          runId: "coord-fixloop-abort",
          status: "completed",
          summary: "should not matter",
          filesChanged: [{ path: "e2e/fixed.spec.ts" }],
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
    coordination: createCoordinationPort(),
    coordinationEnabledPoints: ["fix-loop-regen"],
    coordinationTelemetry: tel,
    sidekick,
  });
  const out = await useCase.run({ ...input, runId: "coord-fixloop-abort" });
  assert.equal(out.decision.verdict, "fail");
  assert.equal(generateCalls, 1, "abort-human must not call GenerationPort for FixLoop regen");
  assert.equal(sidekickCalls, 0, "abort-human must not call sidekick");
  assert.ok(tel.events.some((e) => e.kind === "escalation" && e.action === "abort-human"));
});
