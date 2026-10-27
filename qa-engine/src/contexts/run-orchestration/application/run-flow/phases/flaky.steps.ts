/* The flaky triage of a run: a run whose final execution is flaky has bytes that ran green after a retry, so the steps that judge green bytes (coverage, the reviewer) run for it, and each flaky case's first attempt is read once and sent to the flow that owns its spec. The run itself stays flaky and is quarantined. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { CORRECTION_ORIGIN } from "@contexts/coordination/application/index.ts";
import type { StepOutcome } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import { runOf, type RunState } from "../run-state.ts";
import { withRun } from "../reducers.ts";
import { FLAKY_CLASS, triageFlaky } from "../../../domain/flaky-triage.ts";
import { recountAfter, regenerateAtGap } from "./coverage.steps.ts";
import { flakyFindings } from "./generation-services.ts";

type Result = Promise<StepOutcome<RunState>>;

/* What the triage records on the phase it runs in: why the tail ran, and what the first attempts showed. */
const FLAKY_TAIL_REASON = "flaky-green-bytes";

/* A context run executes nothing and a regression run has no new tests to judge: only a generating run has specs to correct. */
export const triagesFlaky = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  runOf(state).verdict === "flaky" && ctx.input.mode !== "context" && state.classification.generating;

function annotate(ctx: WorkspaceRunContext, attrs: Parameters<WorkspaceRunContext["trail"]["spans"]["annotate"]>[0]): void {
  try {
    ctx.trail.spans.annotate(attrs);
  } catch (err) {
    engineLog.error(`[qa] the flaky triage could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/*
 * Reads each flaky case's first attempt and routes it, as a finding naming its spec, to the flow that owns the spec through the lead's
 * pass, as one more correction after the measurement (inside the same correction budget). It runs after the coverage measurement and
 * its regenerations and before the review, so what it changes is counted again like any regeneration (`recountAfter`) and the
 * measurement the reviewer and the record describe is of the bytes under review. What the flows change goes through the acceptance
 * every regeneration goes through: it stands only if it validates and executes green on its own, with no retry. A run with no pass to
 * route through, or with nothing to read, only records what it saw: no cold author is asked.
 */
export async function triageFlakyCases(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const triage = triageFlaky(runOf(state).cases, state.grounding.confirmedDataRoutes);
  const classCount = (flakyClass: string): number => triage.filter((t) => t.class === flakyClass).length;
  const counts = {
    "qayaba.flaky.tail_reason": FLAKY_TAIL_REASON,
    "qayaba.flaky.cases": triage.length,
    "qayaba.flaky.data_instability": classCount(FLAKY_CLASS.DATA_INSTABILITY),
    "qayaba.flaky.timing": classCount(FLAKY_CLASS.TIMING),
  };
  if (triage.length === 0) {
    annotate(ctx, { ...counts, "qayaba.flaky.outcome": "no-flaky-case" });
    return;
  }
  const found = { cases: triage.length, dataInstability: classCount(FLAKY_CLASS.DATA_INSTABILITY), timing: classCount(FLAKY_CLASS.TIMING) };
  if (!ctx.trail.coordinatedPass) {
    annotate(ctx, { ...counts, "qayaba.flaky.outcome": "no-pass" });
    return { update: { coverage: { ...state.coverage, flakyTriage: { ...found, outcome: "no-pass" } } } };
  }
  const regen = await regenerateAtGap(state, ctx, {}, CORRECTION_ORIGIN.FLAKY, flakyFindings(triage));
  annotate(ctx, { ...counts, "qayaba.flaky.outcome": regen.outcome });
  const recounted = await recountAfter(state, ctx, regen);
  return {
    update: {
      execution: withRun(state.execution, regen.run),
      coverage: { ...recounted, flakyTriage: { ...found, outcome: regen.outcome } },
      loops: { ...state.loops, leadCorrections: state.loops.leadCorrections + regen.leadCorrections },
    },
  };
}
