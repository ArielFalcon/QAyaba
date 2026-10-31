/* The verdict comes from an execution that measures nothing (RFC-0015 A′): coverage is taken by one measurement execution of the passing tests, which the mutation pass is judged against, and a measurement the time cannot hold leaves the coverage unknown without touching the verdict. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeMeasurement, measureCoverage, measuresByExecution } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { remeasureStaleCoverage } from "@contexts/run-orchestration/application/run-flow/phases/review.steps.ts";
import { initialRunState, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import type { WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import type { ExecutionOpts } from "@contexts/test-execution/domain/execution.ts";
import { testOfCase } from "@contexts/objective-signal/domain/dump-names.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { Sha } from "@kernel/sha.ts";

const MAP = "flows/map.spec.ts › opens the map";
const LIST = "flows/list.spec.ts › lists the shops";
const BROKEN = "flows/cart.spec.ts › adds to the cart";

const VERDICT_CASES: QaCase[] = [
  { name: MAP, status: "pass", file: "flows/map.spec.ts", durationMs: 4_000 },
  { name: LIST, status: "pass", file: "flows/list.spec.ts", durationMs: 6_000 },
  { name: BROKEN, status: "fail", file: "flows/cart.spec.ts", durationMs: 1_000 },
];

interface Rig {
  ctx: WorkspaceRunContext;
  asked: Array<{ dir: string; opts: ExecutionOpts }>;
  measured: Array<{ baseline: string[] | undefined; opts: Record<string, unknown> }>;
}

function rig(opts: { mode?: "off" | "signal" | "enforce"; allowance?: number | null; measurementCases?: QaCase[]; finalVerdict?: "pass" | "fail" } = {}): Rig {
  const asked: Rig["asked"] = [];
  const measured: Rig["measured"] = [];
  const ctx = {
    deps: {
      execution: {
        execute: async (dir: string, given: ExecutionOpts) => {
          asked.push({ dir, opts: given });
          if (given.purpose === "measurement") return { verdict: "pass", cases: opts.measurementCases ?? VERDICT_CASES.filter((c) => c.status === "pass"), logs: "", observations: [] };
          return { verdict: opts.finalVerdict ?? "pass", cases: opts.finalVerdict === "fail" ? [{ name: MAP, status: "fail", file: "flows/map.spec.ts" }] : VERDICT_CASES.slice(0, 2), logs: "" };
        },
      },
      objectiveSignal: {
        measure: async (_br: unknown, _dir: string, _diff: string, baseline: string[] | undefined, o: Record<string, unknown>) => (measured.push({ baseline, opts: o }), { status: "pass", ratio: 0.9, measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1 } }),
        blocks: (status: string) => opts.mode === "enforce" && status === "fail",
      },
    },
    input: { app: "app", sha: Sha.of("abc1234"), mode: "diff", runId: "run-1" },
    cfg: { coveragePolicyMode: opts.mode ?? "signal" },
    telemetry: { counter: () => () => {} },
    workspace: { specDir: "/e2e" },
    services: { specRoot: { mirrorDir: "/mirror" }, runDeadlinePort: { peekAllowance: () => (opts.allowance === undefined ? null : opts.allowance), fired: () => false, currentPurpose: () => "coverage" } },
    trail: { spans: { event: () => {} } },
  } as unknown as WorkspaceRunContext;
  return { ctx, asked, measured };
}

function greenState(): RunState {
  const state = initialRunState();
  state.execution = { ...state.execution, run: { verdict: "pass", cases: VERDICT_CASES, logs: "" } } as RunState["execution"];
  state.classification = { ...state.classification, diff: "diff --git a/src/a.ts b/src/a.ts\n" } as RunState["classification"];
  return state;
}

const update = (out: unknown): Partial<RunState> => (out as { update: Partial<RunState> }).update;

test("the measurement execution runs only the verdict's passing tests, measured, observed and once", async () => {
  const { ctx, asked } = rig();

  await executeMeasurement(greenState(), ctx);

  assert.equal(asked.length, 1);
  const { opts } = asked[0]!;
  assert.equal(opts.purpose, "measurement");
  assert.equal(opts.coverage, true);
  assert.equal(opts.observe, true);
  assert.equal(opts.retries, 0);
  assert.equal(opts.namespace, "run-1-measure");
  assert.deepEqual([...(opts.specFiles ?? [])].sort(), ["flows/list.spec.ts", "flows/map.spec.ts"]);
  assert.deepEqual([...(opts.tests ?? [])].sort(), [testOfCase(LIST), testOfCase(MAP)].sort());
});

test("a test that passed in the verdict and failed under measurement is listed, credits nothing and is no mutant's baseline", async () => {
  const { ctx, measured } = rig({ measurementCases: [{ name: MAP, status: "pass", file: "flows/map.spec.ts" }, { name: LIST, status: "fail", file: "flows/list.spec.ts" }] });
  const state = greenState();
  Object.assign(state, update(await executeMeasurement(state, ctx)));

  const out = update(await measureCoverage(state, ctx));

  assert.deepEqual(measured[0]?.baseline, [MAP]);
  assert.equal(measured[0]?.opts.namespace, "run-1-measure");
  assert.deepEqual(measured[0]?.opts.exceptTests, [testOfCase(LIST)]);
  assert.deepEqual(out.coverage?.changeCoverage?.measuredBy, { namespace: "run-1-measure", tests: 2, failedOnlyUnderMeasurement: [LIST] });
  assert.equal(out.coverage?.coverageStatus, "pass", "the verdict's coverage is the measurement's");
});

test("a measurement the coverage allowance cannot hold is not run: coverage is unknown and says why, under signal nothing more", async () => {
  const { ctx, asked, measured } = rig({ allowance: 5_000 });
  const state = greenState();
  Object.assign(state, update(await executeMeasurement(state, ctx)));

  const out = update(await measureCoverage(state, ctx));

  assert.deepEqual(asked, []);
  assert.deepEqual(measured, []);
  assert.equal(out.coverage?.coverageStatus, "unknown");
  assert.equal(out.coverage?.changeCoverage?.unmeasured, "measurement-not-run");
  assert.equal(out.coverage?.blocksPublish, false);
  assert.equal(state.execution.run?.verdict, "pass", "the verdict is untouched");
});

test("under enforce a measurement that was not run holds the run", async () => {
  const { ctx } = rig({ mode: "enforce", allowance: 0 });
  const state = greenState();
  Object.assign(state, update(await executeMeasurement(state, ctx)));

  const out = update(await measureCoverage(state, ctx));

  assert.equal(out.coverage?.coverageStatus, "unknown");
  assert.equal(out.coverage?.blocksPublish, true);
});

test("a measurement cut before every test it was given ran is not a measurement", async () => {
  const { ctx, measured } = rig({ measurementCases: [{ name: MAP, status: "pass", file: "flows/map.spec.ts" }] });
  const state = greenState();
  Object.assign(state, update(await executeMeasurement(state, ctx)));

  const out = update(await measureCoverage(state, ctx));

  assert.deepEqual(measured, []);
  assert.equal(out.coverage?.changeCoverage?.unmeasured, "measurement-not-run");
});

test("a run with the coverage policy off runs no measurement execution", () => {
  assert.equal(measuresByExecution(greenState(), rig({ mode: "off" }).ctx), false);
  assert.equal(measuresByExecution(greenState(), rig({ mode: "signal" }).ctx), true);
});

function staleState(): RunState {
  const state = greenState();
  state.coverage = { ...state.coverage, coverageMeasured: true, acceptedRegenAfterMeasure: true, coverageRatio: 0.9, coverageStatus: "pass" };
  return state;
}

test("the enforce re-measure judges the final bytes in an execution that measures nothing, then measures its passing tests", async () => {
  const { ctx, asked, measured } = rig({ mode: "enforce" });

  const out = update(await remeasureStaleCoverage(staleState(), ctx));

  assert.equal(asked.length, 2);
  assert.notEqual(asked[0]!.opts.coverage, true, "the judging execution is not instrumented");
  assert.equal(asked[0]!.opts.purpose, undefined);
  assert.equal(asked[1]!.opts.purpose, "measurement");
  assert.equal(asked[1]!.opts.coverage, true);
  assert.equal(measured[0]?.opts.namespace, asked[1]!.opts.namespace);
  assert.equal(out.coverage?.coverageStatus, "pass");
});

test("a red judging re-execution replaces a passing verdict and nothing is measured", async () => {
  const { ctx, asked, measured } = rig({ mode: "enforce", finalVerdict: "fail" });

  const out = update(await remeasureStaleCoverage(staleState(), ctx));

  assert.equal(asked.length, 1);
  assert.deepEqual(measured, []);
  assert.equal(out.execution?.run?.verdict, "fail");
});
