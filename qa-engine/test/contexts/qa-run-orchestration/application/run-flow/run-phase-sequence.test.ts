/* The phases a run opens, in the order it opens them: the step table is the run's order, and a reordered table changes what a run does without failing any single phase. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../../support/run-workspace.ts";

const PHASE_SPAN_PREFIX = "qayaba.phase.";

/* Each phase the run opens is a span named after it, so the spans are the phases in the order they were entered. */
class PhaseRecorder extends NoopTelemetry {
  readonly entered: string[] = [];
  override startSpan(name?: string, opts?: StartSpanOptions): SpanHandle {
    if (name?.startsWith(PHASE_SPAN_PREFIX)) this.entered.push(name.slice(PHASE_SPAN_PREFIX.length));
    return super.startSpan(name, opts);
  }
}

async function phasesOf(input: RunQaInput): Promise<string[]> {
  const ws = runWorkspace("qa-phase-sequence-");
  const telemetry = new PhaseRecorder();
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
    runHistory: { save: async () => {} },
    setup: { setup: async () => {} },
    config: { needsReview: true },
    telemetry,
  };
  const out = await new RunQaUseCase(deps).run(input);
  assert.equal(out.decision.verdict, "pass");
  return telemetry.entered;
}

const base = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, target: "e2e" as const };

test("a green diff run opens every phase but the fix loop, in pipeline order", async () => {
  const entered = await phasesOf({ ...base, mode: "diff", runId: "sequence-diff" });
  assert.deepEqual(entered, ["gate", "workspace", "classify", "setup", "ground", "generate", "validate", "health", "execute", "coverage", "review", "decide", "publish", "learn"]);
});

test("a green manual run opens the same phases without classify and coverage, which only a per-commit diff run has", async () => {
  const entered = await phasesOf({ ...base, mode: "manual", guidance: "test the contact form", runId: "sequence-manual" });
  assert.deepEqual(entered, ["gate", "workspace", "setup", "ground", "generate", "validate", "health", "execute", "review", "decide", "publish", "learn"]);
});
