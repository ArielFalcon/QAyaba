/*
 * What a stretch of the run's time is spent on, in the order the run spends it. The run deadline allots time by purpose: a purpose
 * may spend what is left less what the purposes after it need, so a phase can never spend the time a later phase is owed. The
 * purposes are the run's own phases (kernel `RUN_PHASES`) grouped by what they share; a phase that is no purpose of its own
 * (the gate, the workspace, classification) belongs to the first one.
 */
import { RUN_PHASES, type RunPhase } from "./run-step.ts";

export const DEADLINE_PURPOSES = ["ground", "generate", "validate", "execute", "fix", "coverage", "review", "decide"] as const;
export type DeadlinePurpose = (typeof DEADLINE_PURPOSES)[number];

/* The run phases whose measured durations make up each purpose. A purpose's phases are contiguous in the run's order. */
export const PHASES_OF_PURPOSE: Readonly<Record<DeadlinePurpose, readonly RunPhase[]>> = {
  ground: ["setup", "ground"],
  generate: ["generate"],
  validate: ["validate", "health"],
  execute: ["execute"],
  fix: ["fix_loop"],
  coverage: ["coverage"],
  review: ["review"],
  decide: ["decide", "publish"],
};

/* The purpose a run in `phase` is spending its time on; the phases before the first purpose belong to it, and the learning that follows publication to the last. */
export function purposeOfPhase(phase: RunPhase): DeadlinePurpose {
  for (const purpose of DEADLINE_PURPOSES) if (PHASES_OF_PURPOSE[purpose].includes(phase)) return purpose;
  return RUN_PHASES.indexOf(phase) < RUN_PHASES.indexOf("setup") ? "ground" : "decide";
}

/* The purposes that come after `purpose`, in run order. */
export function purposesAfter(purpose: DeadlinePurpose): readonly DeadlinePurpose[] {
  return DEADLINE_PURPOSES.slice(DEADLINE_PURPOSES.indexOf(purpose) + 1);
}
