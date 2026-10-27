/* The phases a run opens, in the order it opens them: the step table is the run's order, and a reordered table changes what a run does without failing any single phase. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../../support/run-workspace.ts";
import { fakeWorkspace } from "./fake-workspace.ts";
import { confinedSpecFiles } from "../../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../../support/change-set.ts";

const PHASE_SPAN_PREFIX = "qayaba.phase.";

/* A step of the run, as the trace reports it: its id, what became of it, and the phase it was reported in. */
interface StepReport {
  id: string;
  outcome: string;
  phase: string;
  reason?: string;
}

/* Each phase the run opens is a span named after it, so the spans are the phases in the order they were entered; the `step` events on them are the run's steps. */
class PhaseRecorder extends NoopTelemetry {
  readonly entered: string[] = [];
  readonly steps: StepReport[] = [];
  override startSpan(name?: string, opts?: StartSpanOptions): SpanHandle {
    if (!name?.startsWith(PHASE_SPAN_PREFIX)) return super.startSpan(name, opts);
    const phase = name.slice(PHASE_SPAN_PREFIX.length);
    this.entered.push(phase);
    const span = super.startSpan(name, opts);
    return {
      ...span,
      addEvent: (event, attrs, time) => {
        if (event === "step") this.steps.push({ id: String(attrs?.["qayaba.run_step.id"]), outcome: String(attrs?.["qayaba.run_step.outcome"]), phase, ...(attrs?.["qayaba.run_step.reason"] ? { reason: String(attrs["qayaba.run_step.reason"]) } : {}) });
        span.addEvent(event, attrs, time);
      },
    };
  }
}

async function runOf(input: RunQaInput, execute?: RunQaUseCaseDeps["execution"]["execute"], expectVerdict = "pass", review?: RunQaUseCaseDeps["review"]["review"]): Promise<PhaseRecorder> {
  const ws = runWorkspace("qa-phase-sequence-");
  const telemetry = new PhaseRecorder();
  const deps: RunQaUseCaseDeps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    ...served(generationOnDisk({ author: async () => scriptedGeneration({ specs: ["a.spec.ts"]}) })),
    review: { review: review ?? (async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true })) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: execute ?? (async () => ({ verdict: "pass", cases: [], logs: "" })) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async () => {} },
    setup: { setup: async () => {} },
    config: { needsReview: true },
    telemetry,
  };
  const out = await new RunQaUseCase(deps).run(input);
  assert.equal(out.decision.verdict, expectVerdict);
  return telemetry;
}

const phasesOf = async (input: RunQaInput): Promise<string[]> => (await runOf(input)).entered;
const idsOf = async (input: RunQaInput, outcome: string): Promise<string[]> => (await runOf(input)).steps.filter((step) => step.outcome === outcome).map((step) => step.id);

const base = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual" as const, target: "e2e" as const };

test("a green diff run opens every phase but the fix loop, in pipeline order", async () => {
  const entered = await phasesOf({ ...base, mode: "diff", runId: "sequence-diff" });
  assert.deepEqual(entered, ["gate", "workspace", "classify", "setup", "ground", "generate", "validate", "health", "execute", "coverage", "review", "decide", "publish", "learn"]);
});

test("a green manual run opens the same phases without classify and coverage, which only a per-commit diff run has", async () => {
  const entered = await phasesOf({ ...base, mode: "manual", guidance: "test the contact form", runId: "sequence-manual" });
  assert.deepEqual(entered, ["gate", "workspace", "setup", "ground", "generate", "validate", "health", "execute", "review", "decide", "publish", "learn"]);
});

test("a green diff run reports the steps it ran, and the ones it passed over, by id and in table order", async () => {
  const input: RunQaInput = { ...base, mode: "diff", runId: "sequence-ids-diff" };
  assert.deepEqual(await idsOf(input, "ran"), [
    "wait-for-deploy", "classify-change", "arm-run-deadline", "index-mirror", "restore-accepted-suite", "set-up-project", "prepare-login", "clean-prior-run",
    "open-authoring-handles", "read-diff-shapes", "retrieve-rules", "select-exemplars", "resolve-blast-radius", "resolve-service-links", "resolve-cross-repo-impact", "compute-change-scope", "ground-repository",
    "assemble-enrichment", "generate-first-pass", "settle-generation-end", "ground-before-execution", "pre-exec-regenerate", "validate-statically", "static-fix-round", "check-health", "prepare-execute-auth", "announce-execution",
    "execute-specs", "fingerprint-green-suite", "announce-coverage", "measure-coverage", "review-tests", "review-round", "review-settle", "release-coordinated-pass", "guard-final-proof",
  ]);
  assert.deepEqual(await idsOf(input, "skipped"), ["run-fix-loop", "fix-triage", "fix-adjudicate", "fix-regenerate", "fix-accept", "fix-reexecute", "settle-fix-loop", "triage-flaky-cases", "regenerate-for-coverage", "regenerate-for-branch-cases", "remeasure-stale-coverage"]);
  assert.deepEqual((await runOf(input)).steps.filter((step) => step.outcome === "ended"), [{ id: "decide-run", outcome: "ended", phase: "decide", reason: "decided" }]);
});

test("a green manual run reports the same steps except the ones only a per-commit diff run has", async () => {
  const input: RunQaInput = { ...base, mode: "manual", guidance: "test the contact form", runId: "sequence-ids-manual" };
  const ran = await idsOf(input, "ran");
  assert.equal(ran.includes("classify-change"), false);
  assert.equal(ran.includes("announce-coverage"), false);
  assert.deepEqual(await idsOf(input, "skipped"), ["classify-change", "run-fix-loop", "fix-triage", "fix-adjudicate", "fix-regenerate", "fix-accept", "fix-reexecute", "settle-fix-loop", "triage-flaky-cases", "announce-coverage", "regenerate-for-coverage", "regenerate-for-branch-cases", "remeasure-stale-coverage"]);
});

test("the first step of a run is reported in the phase it opens", async () => {
  const recorder = await runOf({ ...base, mode: "diff", runId: "sequence-first-phase" });
  assert.deepEqual(recorder.steps[0], { id: "wait-for-deploy", outcome: "ran", phase: "gate" });
});

test("a failing execution repairs through the fix loop steps, one stage per step, and settles", async () => {
  let executions = 0;
  const recorder = await runOf(
    { ...base, mode: "diff", runId: "sequence-fix-loop" },
    async () => (++executions === 1 ? { verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const, file: "a.spec.ts", detail: "expect(received).toBe(expected)" }], logs: "" } : { verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const, file: "a.spec.ts" }], logs: "" }),
    "pass",
  );
  const ran = recorder.steps.filter((step) => step.outcome === "ran" && step.phase === "fix_loop").map((step) => step.id);
  assert.deepEqual(ran.slice(0, 4), ["run-fix-loop", "fix-triage", "fix-adjudicate", "fix-regenerate"]);
  assert.ok(ran.includes("settle-fix-loop"));
});

test("a rejected review corrects through its own steps, then judges the corrected specs again", async () => {
  let reviews = 0;
  const recorder = await runOf(
    { ...base, mode: "diff", runId: "sequence-review-rounds" },
    undefined,
    "pass",
    async () => (++reviews === 1 ? { approved: false, corrections: ["assert the confirmation text"], blockingCount: 1, parsed: true } : { approved: true, corrections: [], blockingCount: 0, parsed: true }),
  );
  const ran = recorder.steps.filter((step) => step.outcome === "ran" && step.id.startsWith("review-")).map((step) => step.id);
  assert.deepEqual(ran, ["review-tests", "review-round", "review-correct", "review-resolve", "review-round", "review-settle"]);
});
