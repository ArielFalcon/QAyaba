/* What every step of a run may use and never returns: the run's input, its dependencies and configuration, the trail its phases leave, and (once the working copy is prepared) the run's live services. Separate from the run's state, which holds only data. */

import type { CycleBudget } from "../../domain/cycle-budget.ts";
import type { WallClockBudget } from "../../domain/wall-clock-budget.ts";
import type { RunQaConfig, RunQaInput, RunQaResult, RunQaUseCaseDeps, RunTrail } from "../run-qa.use-case.ts";
import type { PreparedWorkspace, RunServices } from "./run-services.ts";

/* The use case's own ways to end a run and the trail notes it keeps, bound to the run. */
export interface RunEnds {
  aborted(mirrorDir?: string): Promise<RunQaResult>;
  infraError(note?: string, mirrorDir?: string): Promise<RunQaResult>;
  skipped(): RunQaResult;
  pruneMirror(mirrorDir: string): Promise<void>;
  noteDeadlineArmed(): void;
}

export interface RunContext {
  input: RunQaInput;
  signal: AbortSignal | undefined;
  trail: RunTrail;
  deps: RunQaUseCaseDeps;
  cfg: RunQaConfig;
  startedAt: number;
  cycleBudget: CycleBudget;
  wallClockBudget: WallClockBudget;
  ends: RunEnds;
}

export interface WorkspaceRunContext extends RunContext {
  workspace: PreparedWorkspace;
  services: RunServices;
}
