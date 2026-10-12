/* The run-level wall-clock deadline as the layers around it see it: a read-only view of what is left, and the one error that says the run's time is spent. */
import { InfraError } from "./domain-error.ts";

/** What a run's deadline lets an agent turn know: the time left and what the deadline is. Read-only; the run arms the deadline elsewhere. */
export interface RunDeadlineView {
  /** Milliseconds left; undefined while no deadline is armed (nothing bounds the run yet). Zero or less: spent. */
  remainingMs(): number | undefined;
  /** What was armed: the named budget the run was held to and its length. Undefined while nothing is armed. */
  describe(): { label: string; budgetMs: number } | undefined;
}

/** Whether the turn the deadline stopped had already begun. */
export type RunDeadlineStop = "before-turn" | "mid-turn";

/**
 * The run's wall-clock deadline is spent: an agent turn was refused because no time was left, or was
 * stopped at the deadline. An infrastructure fault by nature (how long a turn takes says nothing about
 * the code under test), but a different one from a single turn's own timeout: it ends the whole run.
 */
export class RunDeadlineExceededError extends InfraError {
  constructor(
    readonly budgetMs: number,
    readonly label: string,
    readonly role: string,
    readonly stop: RunDeadlineStop,
    options?: { cause?: unknown },
  ) {
    super(`run deadline of ${budgetMs}ms (${label}) exhausted: the ${role} turn was ${stop === "mid-turn" ? "stopped at the deadline" : "not started, no time was left"}`, options);
    this.name = "RunDeadlineExceededError";
  }
}

/** By type or by name, since `instanceof` fails across a realm boundary. */
export function isRunDeadlineError(err: unknown): err is RunDeadlineExceededError {
  return err instanceof RunDeadlineExceededError || (err instanceof Error && err.name === "RunDeadlineExceededError");
}

/** For every fail-open catch around an agent turn: the run's deadline is never a soft failure, so it is thrown on. Call it first in the catch block. */
export function rethrowIfRunDeadline(err: unknown): void {
  if (isRunDeadlineError(err)) throw err;
}
