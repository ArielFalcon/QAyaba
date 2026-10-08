/*
 * The milestone of a turn that writes tests. A prompt that states the step limit its runtime enforces
 * also names the step by which such a turn should have produced something, so a run that explores for
 * the whole turn is told early. That step is a fraction of the limit, and what meets it depends on the
 * turn: a first pass meets it with its first spec or a reasoned no-op, a regeneration with its first
 * correction or with the reason none applies (unreachable lines, a failure the app causes, a correction
 * that is wrong), so the pacing never pushes a regeneration toward an edit it has no ground for. A
 * regeneration is not offered the first pass's no-op. Which turns write tests is decided here once; the
 * prompt builder only renders the data this module returns.
 */
import type { RunMode } from "@kernel/run-mode.ts";
import { isReGenTurn, type RegenSignals } from "./regen-turn.ts";

/* The id of the section that carries the milestone: the lint counts its directive words, and no other turn has one. */
export const STEP_MILESTONE_SECTION_ID = "step-milestone";

/* How far into its step limit a turn that writes tests is asked to have written something. */
export const STEP_LIMIT_MIDPOINT_FRACTION = 0.5;

/* The step by which the turn is asked for its first output: a whole step from the first, inside the limit. */
export function stepMidpoint(limit: number): number {
  return Math.max(1, Math.floor(limit * STEP_LIMIT_MIDPOINT_FRACTION));
}

/* What decides whether a turn writes tests: its mode, and whether it is a regeneration. */
export interface TurnShape extends RegenSignals {
  mode: RunMode;
}

/* Test-writing turns are the diff and manual first passes and every regeneration; a complete, exhaustive or context first pass analyzes, and a context run never writes tests. */
export function isTestWritingTurn(turn: TurnShape): boolean {
  return turn.mode !== "context" && (isReGenTurn(turn) || turn.mode === "diff" || turn.mode === "manual");
}

/* What meets the milestone: the first spec written, a reasoned decision to write none, the first correction, or the reason no correction applies. */
export type MilestoneOutcome = "first-spec" | "no-op" | "first-correction" | "reason-none-applies";

export interface StepMilestone {
  midpoint: number;
  outcomes: readonly MilestoneOutcome[];
}

/* The milestone of a turn under `limit`, or undefined when the turn writes no tests. */
export function stepMilestone(turn: TurnShape, limit: number): StepMilestone | undefined {
  if (!isTestWritingTurn(turn)) return undefined;
  return { midpoint: stepMidpoint(limit), outcomes: isReGenTurn(turn) ? ["first-correction", "reason-none-applies"] : ["first-spec", "no-op"] };
}
