/*
 * A mutant's re-run is a signal, never a judgment of the verdict: when the run's port finds the session it ran with gone (again after a
 * renewal, or one that could not be renewed), that re-run is not judged, counted apart with the reason `session-lost`, and the run goes
 * on. The three ways a run applies mutants (the mutation pass, the enforce re-measure's pass, the survivor closure) all go through the
 * run's execution port and the oracle, so they behave the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSurvivors, measureMutation, type GapRegeneration } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { remeasureStaleCoverage } from "@contexts/run-orchestration/application/run-flow/phases/review.steps.ts";
import { runExecutions } from "@contexts/run-orchestration/application/run-flow/run-executions.ts";
import { initialRunState, type MeasurementOutcome, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import type { WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts";
import type { MutantRun } from "@contexts/objective-signal/domain/coverage-collector.ts";
import type { MutantRerun } from "@contexts/objective-signal/application/index.ts";
import type { ExecutionPort } from "@contexts/test-execution/application/index.ts";
import type { ExecutionOpts } from "@contexts/test-execution/domain/execution.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { Sha } from "@kernel/sha.ts";

const SPEC = "flows/orders.spec.ts";
const TEST = `${SPEC} › lists the orders`;
const PASSING: QaCase[] = [{ name: TEST, status: "pass", file: SPEC, durationMs: 1_000 }];
/* What the mutant's own code does to the app's session: every one of its re-runs ends on the login page. */
const ON_LOGIN: QaCase = { name: TEST, file: SPEC, status: "fail", detail: "locator.click: Timeout 8000ms exceeded", finalUrl: "https://dev.example/login?next=%2Forders", failureDom: 'heading: Sign in\ntextbox: "Password"' };

const MUTANT: MutantRun = {
  site: { file: "src/auth.ts", line: 10, column: 1, operator: "negate condition", script: { url: "https://dev.example/main.js", sha256: "abc" }, edit: { start: 0, end: 1, replacement: "!a" }, original: "a", ranIn: [] },
  specFiles: [SPEC],
};

interface Rig {
  ctx: WorkspaceRunContext;
  renewals: () => number;
}

/* The run's own execution port over a runner whose mutant re-runs end the session, with a check that finds it gone each time. */
function rig(mode: "signal" | "enforce" = "signal"): Rig {
  let renewals = 0;
  const executions = runExecutions();
  executions.signedIn(Date.now());
  const base: ExecutionPort = {
    execute: async (_dir, given) => {
      const o = (given ?? {}) as ExecutionOpts;
      if (o.mutant !== undefined && !o.observe) return { verdict: "fail", cases: [ON_LOGIN], logs: "" };
      return { verdict: "pass", cases: PASSING, logs: "", ...(o.observe ? { observations: [] } : {}) };
    },
  };
  const execution = executions.port(base, {
    check: async () => ({ state: "lost", detail: "the page ended on the login path /login" }),
    renew: async () => (renewals++, { renewed: true }),
  });
  const oracle = new BundleMutationOracleAdapter(undefined, () => 1, "https://dev.example");
  const mutate = async (dir: string, namespace: string, baseline: readonly string[], rerun: MutantRerun | undefined) => oracle.measure([MUTANT], dir, namespace, [...baseline], { ...(rerun ? { rerun } : {}) });
  const signal = { status: "pass", ratio: 0.9, uncovered: [], untakenArms: [], measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1 } };
  const ctx = {
    deps: {
      execution,
      objectiveSignal: {
        measure: async (_br: unknown, dir: string, _diff: string, baseline: string[] | undefined, o: { namespace?: string; rerun?: MutantRerun }) => {
          const bundleMutation = await mutate(dir, o.namespace ?? "run-1", baseline ?? [], o.rerun);
          return { ...signal, ...(bundleMutation ? { bundleMutation } : {}) };
        },
        measureMutation: async (pass: { namespace: string; judgedAgainst: string[] }, dir: string, o: { rerun?: MutantRerun }) => {
          const bundleMutation = await mutate(dir, pass.namespace, pass.judgedAgainst, o.rerun);
          return { ...signal, ...(bundleMutation ? { bundleMutation } : {}) };
        },
        recheckSurvivors: async (_survivors: readonly MutantRun[], dir: string, namespace: string, baseline: readonly string[], o: { rerun?: MutantRerun }) => mutate(dir, namespace, baseline, o.rerun),
        blocks: () => false,
      },
    },
    input: { app: "app", sha: Sha.of("abc1234"), mode: "diff", runId: "run-1" },
    cfg: { coveragePolicyMode: mode },
    telemetry: { counter: () => () => {} },
    workspace: { specDir: "/e2e" },
    services: { specRoot: { mirrorDir: "/mirror" }, runDeadlinePort: { peekAllowance: () => null, fired: () => false, currentPurpose: () => "coverage" } },
    trail: { spans: { event: () => {} } },
  } as unknown as WorkspaceRunContext;
  return { ctx, renewals: () => renewals };
}

function greenState(): RunState {
  const state = initialRunState();
  state.execution = { ...state.execution, run: { verdict: "pass", cases: PASSING, logs: "" } } as RunState["execution"];
  state.classification = { ...state.classification, diff: "diff --git a/src/auth.ts b/src/auth.ts\n" } as RunState["classification"];
  return state;
}

const update = (out: unknown): Partial<RunState> => (out as { update: Partial<RunState> }).update;

test("the mutation pass: a mutant whose re-runs end the session is not judged (session-lost) and the run goes on", async () => {
  const { ctx, renewals } = rig();
  const state = greenState();
  state.coverage = { ...state.coverage, mutationPass: { mutants: [MUTANT], judgedAgainst: [TEST], namespace: "run-1-measure" } as unknown as RunState["coverage"]["mutationPass"] };

  const out = update(await measureMutation(state, ctx));

  assert.equal(renewals(), 1);
  assert.deepEqual(out.coverage?.bundleMutation?.notJudged, { "session-lost": 1 });
  assert.equal(out.coverage?.bundleMutation?.killed, 0, "a lost session is never a kill");
});

test("the enforce re-measure: a mutant of its pass whose re-runs end the session is not judged (session-lost), and the re-measure stands", async () => {
  const { ctx } = rig("enforce");
  const state = greenState();
  state.coverage = { ...state.coverage, coverageMeasured: true, acceptedRegenAfterMeasure: true, coverageRatio: 0.9, coverageStatus: "pass" };

  const out = update(await remeasureStaleCoverage(state, ctx));

  assert.equal(out.execution?.run?.verdict, "pass");
  assert.deepEqual(out.coverage?.bundleMutation?.notJudged, { "session-lost": 1 });
});

test("the survivor closure: a re-applied survivor whose re-runs end the session is not judged (session-lost), counted on the closure", async () => {
  const { ctx } = rig();
  const state = greenState();
  state.coverage = {
    ...state.coverage,
    survivorRuns: [MUTANT],
    bundleMutation: { applied: 1, killed: 0, survived: [{ file: "src/auth.ts", line: 10, operator: "negate condition", specFiles: [SPEC], original: "a", replacement: "!a" }] },
  } as RunState["coverage"];
  const regen: GapRegeneration = { outcome: "accepted", run: { verdict: "pass", cases: PASSING, logs: "" }, acceptanceCalls: 1, leadCorrections: 0, namespace: "run-1-cov", changedSpecFiles: [SPEC] };
  const measured: MeasurementOutcome = { namespace: "run-1-cov-measure", tests: 1, passed: [TEST], baseline: [TEST], failedOnlyUnderMeasurement: [], cases: PASSING, files: [{ file: SPEC, sha: "x" }] };

  const closure = await closeSurvivors(state, ctx, regen, measured);

  assert.equal(closure?.judged, 0);
  assert.equal(closure?.closed, 0);
  assert.deepEqual(closure?.notJudged, { "session-lost": 1 });
});
