/*
 * The run, read top to bottom: every step in the order it runs, the phase it opens and when it is skipped. The steps before the
 * working copy is prepared see only the run's context; the rest also see its workspace and live services.
 */

import type { RunQaResult } from "../run-qa.use-case.ts";
import type { FlowStep } from "./run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "./run-context.ts";
import type { RunState } from "./run-state.ts";
import { armRunDeadline, classifyChange, indexMirror, stopIfAbortedBeforeGate, waitForDeploy } from "./phases/opening.steps.ts";

export const BEFORE_WORKSPACE: ReadonlyArray<FlowStep<RunState, RunContext, RunQaResult>> = [
  { name: "stop a run aborted before it started", run: stopIfAbortedBeforeGate },
  { name: "wait until DEV serves the commit", phase: "gate", run: waitForDeploy },
];

export const IN_WORKSPACE: ReadonlyArray<FlowStep<RunState, WorkspaceRunContext, RunQaResult>> = [
  { name: "classify the change", phase: "classify", runs: (_state, ctx) => ctx.input.mode === "diff", run: classifyChange },
  { name: "arm the run deadline", run: armRunDeadline },
  { name: "bring the code index up to the commit", run: indexMirror },
];
