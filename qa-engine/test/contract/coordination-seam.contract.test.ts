/* decision without knowing provider or model. Generation / FixLoop / AgentRuntime
   call sites stay equivalent: this file also pins that they do not import the seam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";
import { WallClockBudget } from "@contexts/qa-run-orchestration/domain/wall-clock-budget.ts";
import {
  AGENT_CAPABILITIES,
  COORDINATION_ACTIONS,
  isAgentCapability,
  isCoordinationAction,
  createCoordinationPort,
  type CoordinationContext,
  type CoordinationDecision,
  type EvidenceRef,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const qaEngineRoot = join(here, "..", "..");

function budgets() {
  const cycle = CycleBudget.derive({ maxRetries: 2 });
  const wallClock = WallClockBudget.derive({ cycleBudget: cycle, agentTimeoutMs: 1_000 });
  return { cycle, wallClock };
}

function sampleEvidence(): EvidenceRef {
  return {
    id: "ev-1",
    kind: "change-analysis",
    source: "ChangeAnalysisPort",
    summary: "diff classified generate",
    confidence: "deterministic",
  };
}

function sampleContext(overrides: Partial<CoordinationContext> = {}): CoordinationContext {
  return {
    runId: "run-1",
    objective: "cover the blast radius",
    acceptanceCriteria: ["the changed flow is exercised"],
    evidence: [sampleEvidence()],
    budgets: budgets(),
    ...overrides,
  };
}

test("AgentCapability is lead | sidekick-standard | sidekick-escalated — not reviewer, not lead-takeover", () => {
  assert.deepEqual([...AGENT_CAPABILITIES], ["lead", "sidekick-standard", "sidekick-escalated"]);
  assert.equal(isAgentCapability("lead"), true);
  assert.equal(isAgentCapability("sidekick-standard"), true);
  assert.equal(isAgentCapability("sidekick-escalated"), true);
  assert.equal(isAgentCapability("reviewer"), false);
  assert.equal(isAgentCapability("lead-takeover"), false);
  assert.equal(isAgentCapability("primary"), false);
  assert.equal(isAgentCapability("worker"), false);
});

test("CoordinationDecision.action is the Fase 1 assignment union — not OrchestrationDecision verbs", () => {
  assert.deepEqual(
    [...COORDINATION_ACTIONS],
    ["direct", "delegate", "retry", "escalate", "takeover", "abort"],
  );
  for (const action of COORDINATION_ACTIONS) {
    assert.equal(isCoordinationAction(action), true);
  }
  assert.equal(isCoordinationAction("accept"), false);
  assert.equal(isCoordinationAction("continue-fix-loop"), false);
  assert.equal(isCoordinationAction("retry-sidekick"), false);
  assert.equal(isCoordinationAction("escalate-sidekick"), false);
  assert.equal(isCoordinationAction("lead-takeover"), false);
  assert.equal(isCoordinationAction("abort-human"), false);
});

test("takeover is an action whose nextCapability is lead, not a capability member", () => {
  const decision: CoordinationDecision = {
    action: "takeover",
    reason: "sidekick emitted needs-lead",
    evidence: [sampleEvidence()],
    nextCapability: "lead",
  };
  assert.equal(isCoordinationAction(decision.action), true);
  assert.equal(isAgentCapability(decision.nextCapability ?? ""), true);
  assert.equal(decision.nextCapability, "lead");
  assert.equal(isAgentCapability("lead-takeover"), false);
});

test("CoordinationDecision JSON round-trip keeps action, reason, evidence, optional nextCapability", () => {
  const decision: CoordinationDecision = {
    action: "escalate",
    reason: "same fingerprint after standard sidekick",
    evidence: [sampleEvidence()],
    nextCapability: "sidekick-escalated",
  };
  const parsed = JSON.parse(JSON.stringify(decision)) as CoordinationDecision;
  assert.deepEqual(parsed, decision);
});

test("CoordinationContext is a minimal projection — no OpencodeRunInput fields", () => {
  const ctx = sampleContext();
  assert.deepEqual(Object.keys(ctx).sort(), [
    "acceptanceCriteria",
    "budgets",
    "evidence",
    "objective",
    "runId",
  ]);
  for (const leak of [
    "diff",
    "existingSpecs",
    "learnedRules",
    "domSnapshot",
    "contextPack",
    "staticSignal",
    "archetypes",
    "serviceLinks",
    "contractDrift",
    "model",
    "provider",
  ]) {
    assert.equal(Object.hasOwn(ctx, leak), false, `CoordinationContext must not carry ${leak}`);
  }
});

test("CoordinationBudget holds the run CycleBudget and WallClockBudget intact — no duplicate ceilings", () => {
  const cycle = CycleBudget.derive({ maxRetries: 3, iterationBudget: 9 });
  const wallClock = WallClockBudget.derive({
    cycleBudget: cycle,
    agentTimeoutMs: 500,
    wallClockBudgetMs: 4_000,
  });
  const ctx = sampleContext({ budgets: { cycle, wallClock } });
  assert.equal(ctx.budgets.cycle, cycle);
  assert.equal(ctx.budgets.wallClock, wallClock);
  assert.equal(ctx.budgets.cycle.ceiling, 9);
  assert.equal(ctx.budgets.wallClock.budgetMs, 4_000);
});

test("Fase 5 wires coordination only into RunQaUseCase — generation/FixLoop/AgentRuntime stay free of the seam", () => {
  const forbidden = [
    "src/contexts/generation/application/generate-tests.use-case.ts",
    "src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts",
    "src/shared-kernel/ports/agent-runtime.port.ts",
    "src/shared-kernel/agent-role.ts",
  ];
  for (const rel of forbidden) {
    const src = readFileSync(join(qaEngineRoot, rel), "utf8");
    assert.equal(
      src.includes("application/coordination"),
      false,
      `${rel} must not import the coordination seam`,
    );
    assert.equal(
      src.includes("CoordinationPort"),
      false,
      `${rel} must not name CoordinationPort`,
    );
  }
  const useCase = readFileSync(
    join(qaEngineRoot, "src/contexts/qa-run-orchestration/application/run-qa.use-case.ts"),
    "utf8",
  );
  assert.equal(useCase.includes("CoordinationPort"), true);
  assert.equal(useCase.includes("advisoryOnly"), false, "advisory downgrade was removed with the modes");
  const composition = readFileSync(
    join(qaEngineRoot, "src/contexts/qa-run-orchestration/composition/composition-root.ts"),
    "utf8",
  );
  assert.equal(
    composition.includes("coordinationMode"),
    false,
    "the mode selector is gone — coordination is the single mode",
  );
});
