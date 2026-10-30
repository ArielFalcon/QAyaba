/* The re-measure before decide on the bytes an accepted regeneration wrote: what the final whole-suite execution may change of the run's verdict. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { remeasureStaleCoverage } from "@contexts/run-orchestration/application/run-flow/phases/review.steps.ts";
import { initialRunState, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import type { WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { Sha } from "@kernel/sha.ts";

const CASES = [{ name: "a", status: "pass", file: "a.spec.ts" }];

function rig(mode: "signal" | "enforce", finalVerdict: RunVerdict) {
  const measured: unknown[] = [];
  const counted: Record<string, unknown>[] = [];
  const ctx = {
    deps: {
      execution: { execute: async () => ({ verdict: finalVerdict, cases: finalVerdict === "pass" || finalVerdict === "flaky" ? CASES : [{ name: "a", status: "fail", file: "a.spec.ts" }] }) },
      objectiveSignal: {
        measure: async (...args: unknown[]) => (measured.push(args), { status: "fail", ratio: 0.2, measurement: { changedLines: 10, coveredChanged: 2, changedFiles: 1, mappedFiles: 1 } }),
        blocks: (status: string) => status === "fail",
      },
    },
    input: { app: "app", sha: Sha.of("abc1234"), mode: "diff", runId: "run-1" },
    cfg: { coveragePolicyMode: mode },
    telemetry: { counter: (name: string) => (value: number, attrs: Record<string, string>) => void counted.push({ name, value, attrs }) },
    workspace: { specDir: "/e2e" },
    services: { specRoot: { mirrorDir: "/mirror" } },
  } as unknown as WorkspaceRunContext;
  return { ctx, measured, counted };
}

function staleState(verdict: RunVerdict): RunState {
  const state = initialRunState();
  state.execution = { ...state.execution, run: { verdict, cases: [], logs: "first" } } as RunState["execution"];
  state.coverage = { ...state.coverage, coverageMeasured: true, acceptedRegenAfterMeasure: true, coverageRatio: 0.9, coverageStatus: "pass" };
  return state;
}

const update = (out: Awaited<ReturnType<typeof remeasureStaleCoverage>>) => (out as { update: Partial<RunState> }).update;

test("a flaky run whose final measured execution is red stays flaky: the verdict is the run's own, quarantine stays", async () => {
  const { ctx, measured } = rig("enforce", "fail");

  const out = update(await remeasureStaleCoverage(staleState("flaky"), ctx));

  assert.equal(out.execution?.run?.verdict ?? "flaky", "flaky");
  assert.deepEqual(measured, [], "a red execution measures nothing");
  assert.equal(out.coverage?.coverageStale, true, "the measurement the run keeps predates its final bytes and says so");
});

test("a flaky run whose final execution ran green is measured and stays flaky", async () => {
  const { ctx, measured } = rig("enforce", "pass");

  const out = update(await remeasureStaleCoverage(staleState("flaky"), ctx));

  assert.equal(out.execution?.run?.verdict, "flaky");
  assert.equal(measured.length, 1);
  assert.equal(out.coverage?.coverageStatus, "fail");
  assert.equal(out.coverage?.blocksPublish, true);
});

test("a passing run whose final measured execution is red takes that verdict, and nothing is measured", async () => {
  const { ctx, measured } = rig("enforce", "fail");

  const out = update(await remeasureStaleCoverage(staleState("pass"), ctx));

  assert.equal(out.execution?.run?.verdict, "fail");
  assert.deepEqual(measured, []);
});

test("under signal the prior measurement is kept and marked stale, whatever the verdict", async () => {
  for (const verdict of ["pass", "flaky"] as const) {
    const { ctx, measured, counted } = rig("signal", "fail");

    const out = update(await remeasureStaleCoverage(staleState(verdict), ctx));

    assert.equal(out.coverage?.coverageStale, true);
    assert.equal(out.execution, undefined);
    assert.deepEqual(measured, []);
    assert.equal(counted.length, 1);
  }
});
