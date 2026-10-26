/* The pre-execution gates as events on the phase they ran in, and the run's verdict unchanged by tracing them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunQaUseCase, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/index";
import { ok } from "@kernel/result";
import { fakeWorkspace } from "../../qa-engine/test/contexts/run-orchestration/application/run-flow/fake-workspace";
import { Sha } from "@kernel/sha";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { scriptedGeneration } from "../../qa-engine/test/support/generation-output";
import { generationOnDisk, runWorkspace } from "../../qa-engine/test/support/run-workspace";
import { traceHarness } from "./trace-harness";
import { confinedSpecFiles } from "../../qa-engine/src/shared-infrastructure/spec-files.adapter";
import { served } from "../../qa-engine/test/support/coordinator-over-author";

const SPEC_SOURCE = "await page.goto('/orders');\nawait page.getByTestId('invented-id').click();\nawait page.getByTestId('real-id').click();\n";

function useCase(telemetry: TelemetryPort | undefined, withGrounding = true, validate: RunQaUseCaseDeps["validation"]["validate"] = async () => ({ ok: true, errors: [] })) {
  const ws = runWorkspace("qa-gates-");
  const deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    ...served(generationOnDisk({ author: async () => scriptedGeneration({ specs: ["a.spec.ts"]}) })),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate },
    execution: { execute: async () => ({ verdict: "pass", cases: [], logs: "" }) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async () => {} },
    setup: { setup: async () => {} },
    ...(withGrounding
      ? {
          preExecGrounding: {
            capture: async () => ({
              specFiles: ["a.spec.ts"],
              specSources: [SPEC_SOURCE],
              routes: [{ route: "/orders", nodes: ["button: Save"], status: "captured" as const, settled: true, testIds: new Map([["real-id", 1]]) }],
            }),
          },
        }
      : {}),
    config: { needsReview: true },
    ...(telemetry ? { telemetry } : {}),
  };
  return new RunQaUseCase(deps);
}

const input = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, mode: "diff" as const, target: "e2e" as const, runId: "gates" };

test("a spec that uses a test id the captured page lacks is an event on the phase it was found in, with the counts of the gate", async () => {
  const h = traceHarness();
  await useCase(h.telemetry).run(input);
  const withEvent = h.spans().filter((s) => s.events.some((e) => e.name === "catalog_gate"));
  assert.equal(withEvent.length, 1);
  assert.match(withEvent[0]!.name, /^qayaba\.phase\./);
  const event = withEvent[0]!.events.find((e) => e.name === "catalog_gate")!;
  assert.equal(event.attributes?.["qayaba.catalog_gate.fabricated"], 1);
  assert.equal(event.attributes?.["qayaba.catalog_gate.in_window"], 1);
  assert.equal(event.attributes?.["qayaba.catalog_gate.advisory"], 1);
});

test("a gate that found nothing says nothing", async () => {
  const h = traceHarness();
  await useCase(h.telemetry, false).run(input);
  assert.equal(h.spans().some((s) => s.events.some((e) => e.name === "catalog_gate" || e.name === "ambiguity_advisory")), false);
});

test("every validation is told which specs the run has delivered, as its generator reported them", async () => {
  const told: unknown[] = [];
  await useCase(undefined, false, async (_dir, _files, run) => {
    told.push(run);
    return { ok: true, errors: [] };
  }).run(input);
  assert.ok(told.length >= 1);
  assert.deepEqual(told[0], { deliveredSpecs: ["a.spec.ts"] });
});

test("the run ends the same whether the gates are traced, not traced, or traced by a port that throws", async () => {
  const plain = await useCase(undefined).run(input);
  const traced = await useCase(traceHarness().telemetry).run(input);
  const broken = await useCase(new ThrowingTelemetry()).run(input);
  for (const out of [traced, broken]) {
    assert.equal(out.outcome?.verdict, plain.outcome?.verdict);
    assert.equal(out.decision.sideEffect, plain.decision.sideEffect);
    assert.equal(out.gateSignals.catalogGateFailClosed, plain.gateSignals.catalogGateFailClosed);
    assert.equal(out.gateSignals.furthestPhase, plain.gateSignals.furthestPhase);
  }
});
