/* The run flow as a trace: RunQaUseCase with fake ports and a fake clock, over the real telemetry adapter and an in-memory exporter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpanStatusCode } from "@opentelemetry/api";
import { RunQaUseCase, type RunQaUseCaseDeps, type RunQaResult } from "@contexts/run-orchestration/application/index";
import { RUN_PHASES } from "@kernel/run-step";
import { RunDeadlineExceededError } from "@kernel/run-deadline";
import { ok } from "@kernel/result";
import { fakeWorkspace } from "../../qa-engine/test/contexts/run-orchestration/application/run-flow/fake-workspace";
import { traceFactsOf } from "@kernel/run-trace-facts";
import { Sha } from "@kernel/sha";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { INSTRUMENTS, checkInstrumentTable } from "./instrument-table";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { activeRunSecretScope } from "../../qa-engine/src/shared-infrastructure/redaction/run-secret-redaction";
import { ambientExecScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/ambient-exec-scope";
import { createExecSandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { openRunWorkDir } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-workdir";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { scriptedGeneration } from "../../qa-engine/test/support/generation-output";
import { generationOnDisk, runWorkspace } from "../../qa-engine/test/support/run-workspace";
import { traceHarness } from "./trace-harness";
import { confinedSpecFiles } from "../../qa-engine/src/shared-infrastructure/spec-files.adapter";

type Overrides = Partial<{
  classify: RunQaUseCaseDeps["changeAnalysis"]["classify"];
  generate: RunQaUseCaseDeps["generation"]["generate"];
  validate: RunQaUseCaseDeps["validation"]["validate"];
  setup: () => Promise<void>;
  runDeadline: RunQaUseCaseDeps["runDeadline"];
}>;

function baseDeps(clock: { now(): number }, overrides: Overrides = {}): RunQaUseCaseDeps {
  const ws = runWorkspace("qa-trace-");
  return {
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
    runHistory: { save: async () => {} },
    setup: { setup: overrides.setup ?? (async () => {}) },
    ...(overrides.runDeadline ? { runDeadline: overrides.runDeadline } : {}),
    config: { needsReview: true },
    phaseClock: clock,
  };
}

function useCaseWith(telemetry: TelemetryPort | undefined, clock: { now(): number }, overrides: Overrides = {}) {
  return new RunQaUseCase({ ...baseDeps(clock, overrides), ...(telemetry ? { telemetry } : {}) });
}

const input = { app: "demo", sha: Sha.of("abc1234"), source: "manual" as const, mode: "diff" as const, target: "e2e" as const, runId: "run-trace-1" };

/* The runner opens the root and runs the engine under it; a test does the same. */
async function runUnderRoot(h: ReturnType<typeof traceHarness>, useCase: RunQaUseCase, signal?: AbortSignal): Promise<{ result?: RunQaResult; threw?: unknown }> {
  const root = h.telemetry.startSpan("qayaba.run", { root: true, attrs: { "qayaba.run.id": input.runId } });
  try {
    return { result: await h.telemetry.withParent(root, () => useCase.run(input, signal)) };
  } catch (threw) {
    return { threw };
  } finally {
    root.end();
  }
}

test("a full run is one trace: a root, and the phases it entered as its children, in order, on the cursor's clock", async () => {
  const h = traceHarness();
  const useCase = useCaseWith(h.telemetry, h.clock, {
    generate: async () => {
      h.clock.advance(40);
      return scriptedGeneration({ specs: ["a.spec.ts"], approved: true });
    },
  });

  const { result } = await runUnderRoot(h, useCase);

  assert.equal(result?.gateSignals.furthestPhase, "learn");
  const root = h.only("qayaba.run");
  const phases = h.spans().filter((s) => s.name.startsWith("qayaba.phase."));
  assert.deepEqual(
    phases.map((s) => s.name.slice("qayaba.phase.".length)),
    RUN_PHASES.filter((p) => p !== "fix_loop"),
  );
  assert.equal(new Set(h.spans().map((s) => s.spanContext().traceId)).size, 1);
  for (const phase of phases) {
    assert.equal(phase.parentSpanContext?.spanId, root.spanContext().spanId, phase.name);
    assert.equal(phase.attributes["qayaba.phase"], phase.name.slice("qayaba.phase.".length));
  }
  const generate = h.only("qayaba.phase.generate");
  const ms = (t: [number, number]): number => t[0] * 1000 + t[1] / 1e6;
  assert.equal(ms(generate.endTime) - ms(generate.startTime), 40);
  assert.deepEqual(h.unended(), []);
  assert.deepEqual(h.orphans(), []);
});

test("the first phase of a run carries the trace-level viewing attributes, since the enqueue span lives in another trace", async () => {
  const h = traceHarness();
  await runUnderRoot(h, useCaseWith(h.telemetry, h.clock));

  const first = h.only("qayaba.phase.gate");
  assert.equal(first.attributes["langfuse.trace.name"], "qayaba.run");
  assert.equal(first.attributes["langfuse.session.id"], "demo");
  assert.deepEqual(first.attributes["langfuse.trace.tags"], ["demo", "diff"]);
  assert.equal(h.only("qayaba.phase.workspace").attributes["langfuse.trace.name"], undefined);
});

test("the local ledger is told to commit on every phase change, so a hung run is visible while it hangs", async () => {
  const h = traceHarness();
  await runUnderRoot(h, useCaseWith(h.telemetry, h.clock));
  assert.ok(h.flushCount() >= RUN_PHASES.length - 1);
});

const EXITS: Array<{ name: string; overrides?: (controller: AbortController) => Overrides; abort?: boolean; threw?: boolean; entersAPhase?: boolean }> = [
  { name: "success" },
  { name: "a classify skip", overrides: () => ({ classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }) }) },
  { name: "a setup infra-error", overrides: () => ({ setup: async () => { throw new Error("npm ci failed"); } }) },
  { name: "the run deadline", overrides: () => ({ generate: async () => { throw new RunDeadlineExceededError(600_000, "diff-tiny", "primary", "mid-turn"); } }) },
  { name: "an operator abort before the first phase", abort: true, entersAPhase: false },
  {
    name: "an operator abort in the middle of generation",
    overrides: (controller) => ({ generate: async () => { controller.abort(); throw new Error("aborted"); } }),
    threw: true,
  },
  { name: "an unhandled engine error", overrides: () => ({ generate: async () => { throw new Error("agent runtime fell over"); } }), threw: true },
];

for (const exit of EXITS) {
  test(`every phase span ends, and none is orphaned, when the run ends on ${exit.name}`, async () => {
    const h = traceHarness();
    const controller = new AbortController();
    if (exit.abort) controller.abort();
    const out = await runUnderRoot(h, useCaseWith(h.telemetry, h.clock, exit.overrides?.(controller)), controller.signal);

    assert.equal(out.threw !== undefined, exit.threw === true);
    assert.deepEqual(h.unended(), []);
    assert.deepEqual(h.orphans(), []);
    if (exit.entersAPhase !== false) assert.ok(h.spans().some((s) => s.name.startsWith("qayaba.phase.")));
  });
}

test("an engine error nothing handles marks the phase it happened in as an error, with the message redacted through the run's own secrets", async () => {
  const h = traceHarness();
  const secret = "hunter2-fake-account-password";
  const useCase = useCaseWith(h.telemetry, h.clock, {
    setup: async () => {
      activeRunSecretScope()?.addAccountSecrets([secret]);
    },
    generate: async () => {
      throw new Error(`provider rejected the login ${secret}`);
    },
  });

  const out = await runUnderRoot(h, useCase);

  assert.ok(out.threw);
  const generate = h.only("qayaba.phase.generate");
  assert.equal(generate.status.code, SpanStatusCode.ERROR);
  assert.ok(!JSON.stringify([generate.status, generate.events, generate.attributes]).includes(secret));
  for (const span of h.spans()) assert.ok(!JSON.stringify([span.name, span.status, span.events, span.attributes]).includes(secret), span.name);
});

test("a run that ends with a returned verdict leaves every phase span without an error status", async () => {
  const h = traceHarness();
  await runUnderRoot(h, useCaseWith(h.telemetry, h.clock, { validate: async () => ({ ok: false, errors: ["TS2304"] }) }));
  for (const span of h.spans().filter((s) => s.name.startsWith("qayaba.phase."))) assert.notEqual(span.status.code, SpanStatusCode.ERROR, span.name);
});

test("the deadline the run armed is on the phase it was armed in, with a deadline_armed event", async () => {
  const h = traceHarness();
  const runDeadline = { arm: () => {}, describe: () => ({ label: "diff-tiny", budgetMs: 1_500_000 }) };
  await runUnderRoot(h, useCaseWith(h.telemetry, h.clock, { runDeadline }));

  const classify = h.only("qayaba.phase.classify");
  assert.equal(classify.attributes["qayaba.deadline.label"], "diff-tiny");
  assert.equal(classify.attributes["qayaba.deadline.budget_ms"], 1_500_000);
  assert.ok(classify.events.some((e) => e.name === "deadline_armed"));
});

test("each phase records its duration in seconds on the phase histogram, with allowed keys only", async () => {
  const h = traceHarness();
  const useCase = useCaseWith(h.telemetry, h.clock, {
    generate: async () => {
      h.clock.advance(2_500);
      return scriptedGeneration({ specs: ["a.spec.ts"], approved: true });
    },
  });
  await runUnderRoot(h, useCase);

  const durations = h.measurements.filter((m) => m.name === "qayaba.phase.duration");
  const generate = durations.find((m) => m.attrs["qayaba.phase"] === "generate");
  assert.equal(generate?.value, 2.5);
  const allowed = new Set<string>(INSTRUMENTS["qayaba.phase.duration"].attrs);
  for (const m of durations) {
    assert.equal(m.attrs["qayaba.app"], "demo");
    for (const key of Object.keys(m.attrs)) assert.ok(allowed.has(key), key);
  }
  assert.deepEqual(checkInstrumentTable(INSTRUMENTS), []);
});

test("a telemetry port that throws on every method changes neither the verdict, the phase record nor the saved outcome of the run", async () => {
  const savedWith = async (telemetry: TelemetryPort | undefined) => {
    const h = traceHarness();
    const saved: unknown[] = [];
    const deps = baseDeps(h.clock);
    const useCase = new RunQaUseCase({ ...deps, runHistory: { save: async (o) => { saved.push(structuredClone({ ...o, at: "" })); } }, ...(telemetry ? { telemetry } : {}) });
    const out = await runUnderRoot(h, useCase);
    return { verdict: out.result?.decision.verdict, side: out.result?.decision.sideEffect, furthest: out.result?.gateSignals.furthestPhase, timings: out.result?.gateSignals.phaseTimings, saved };
  };
  assert.deepEqual(await savedWith(new ThrowingTelemetry()), await savedWith(undefined));
});

test("the result carries, for the runner's root span, the publication decision and the generation end it reached", async () => {
  const h = traceHarness();
  const { result } = await runUnderRoot(h, useCaseWith(h.telemetry, h.clock));
  assert.equal(traceFactsOf(result!)?.decision, "pr");
  assert.equal(traceFactsOf(result!)?.generationEnd, "delivered");
  assert.equal(traceFactsOf(result!)?.limitFired, undefined);
});

test("a run ended by its deadline says which limit fired and in which role", async () => {
  const h = traceHarness();
  const useCase = useCaseWith(h.telemetry, h.clock, { generate: async () => { throw new RunDeadlineExceededError(600_000, "diff-tiny", "primary", "mid-turn"); } });
  const { result } = await runUnderRoot(h, useCase);
  assert.equal(traceFactsOf(result!)?.limitFired, "run-deadline");
  assert.equal(traceFactsOf(result!)?.limitRole, "primary");
});

test("a generation cut off by its tier budget reports the tier budget as the limit", async () => {
  const h = traceHarness();
  const useCase = useCaseWith(h.telemetry, h.clock, { generate: async () => scriptedGeneration({ specs: [], approved: true, end: "time-budget" }) });
  const { result } = await runUnderRoot(h, useCase);
  assert.equal(traceFactsOf(result!)?.generationEnd, "time-budget");
  assert.equal(traceFactsOf(result!)?.limitFired, "tier-budget");
});

test("a generation that ran out of steps reports the step cap as the limit", async () => {
  const h = traceHarness();
  const useCase = useCaseWith(h.telemetry, h.clock, { generate: async () => scriptedGeneration({ specs: [], approved: true, end: "exhausted" }) });
  const { result } = await runUnderRoot(h, useCase);
  assert.equal(traceFactsOf(result!)?.limitFired, "step-cap");
});

test("a child started while a phase is open is a child of that phase, in the same trace as the run", async () => {
  const h = traceHarness();
  const root = mkdtempSync(join(tmpdir(), "run-trace-exec-"));
  try {
    const scope: RunScope = { runId: input.runId, workDir: openRunWorkDir(join(root, "exec"), "run-1", null), egress: { dev: [], install: [] }, report: newSandboxReport() };
    const children: Array<ChildProcess & EventEmitter> = [];
    const exec = createExecSandbox({
      sandbox: null,
      mode: "best-effort",
      baseEnv: { PATH: "/usr/bin" },
      warn: () => {},
      telemetry: h.telemetry,
      spawnFn: (() => {
        const child = new EventEmitter() as ChildProcess & EventEmitter;
        children.push(child);
        return child;
      }) as unknown as typeof import("node:child_process").spawn,
    });
    const execScope = { ...ambientExecScope, open: () => ({ run: <T>(fn: () => T): T => withExecScope(scope, fn), close: () => {} }) };
    const useCase = new RunQaUseCase({
      ...baseDeps(h.clock),
      telemetry: h.telemetry,
      execScope,
      validation: {
        validate: async () => {
          exec.spawn("npx", ["tsc"], { cwd: "/m/e2e", profile: "offline", commandClass: "tsc" });
          children[0]!.emit("close", 0, null);
          return { ok: true, errors: [] };
        },
      },
    });

    await runUnderRoot(h, useCase);

    const exec_ = h.only("qayaba.exec");
    assert.equal(exec_.parentSpanContext?.spanId, h.only("qayaba.phase.validate").spanContext().spanId);
    assert.equal(exec_.spanContext().traceId, h.only("qayaba.run").spanContext().traceId);
    assert.deepEqual(h.unended(), []);
    assert.deepEqual(h.orphans(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run deadline that ends a run after generation delivered keeps the generation end and names the deadline as the limit", async () => {
  const h = traceHarness();
  const deps = baseDeps(h.clock);
  const useCase = new RunQaUseCase({
    ...deps,
    telemetry: h.telemetry,
    review: { review: async () => { throw new RunDeadlineExceededError(600_000, "diff-tiny", "reviewer", "before-turn"); } },
  });
  const { result } = await runUnderRoot(h, useCase);
  assert.equal(result?.decision.verdict, "infra-error");
  assert.equal(traceFactsOf(result!)?.generationEnd, "delivered");
  assert.equal(traceFactsOf(result!)?.limitFired, "run-deadline");
  assert.equal(traceFactsOf(result!)?.limitRole, "reviewer");
});

test("an error the engine does not handle carries how the run ended, so the shell's root can state it", async () => {
  const h = traceHarness();
  const useCase = new RunQaUseCase({
    ...baseDeps(h.clock),
    telemetry: h.telemetry,
    review: { review: async () => { throw new Error("reviewer fell over"); } },
  });
  const out = await runUnderRoot(h, useCase);

  assert.ok(out.threw, "the engine error goes on to the caller that records the run");
  const facts = traceFactsOf(out.threw as object);
  assert.equal(facts?.generationEnd, "delivered");
  assert.equal(facts?.decision, undefined, "the run never reached a decision, so none is claimed");
});
