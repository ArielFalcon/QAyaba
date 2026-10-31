/* What a run's trace says about how it ended, beyond the verdict: the decision, how generation ended, every limit that fired and every degradation the run went on past. It rides on the outcome object the engine returns without being a field of it: the outcome's shape is the persisted one (pinned by the seam-parity contract), and these facts are for the shell that opens the run's root span and writes the run's record. */

import { isBindingLimit } from "@kernel/turn-limit.ts";

/* What the run decided to do with its result: open a pull request, open an Issue, quarantine a flaky suite, hold a green suite the change-coverage gate blocked (nothing is opened in the app's repository), or nothing. Whether shadow replaced the decision is the separate `shadowed` fact, never a value of this one. */
export const RUN_DECISIONS = ["pr", "issue", "quarantine", "held", "none"] as const;
export type RunDecisionOutcome = (typeof RUN_DECISIONS)[number];

/* A limit that fired in the run. `scope` says who saw it: the engine at run level (the deadline that ended or degraded the run, the budget that ended generation) or the agent turns (a limit a turn ended on and the run went on past); `turns` counts them for the second. */
export interface RunLimitFact {
  /* A value of the limit vocabulary: a turn limit ("flow-budget", "run-deadline", "repair-cap", "stall", "step-cap", ...). */
  fired: string;
  role: string;
  scope: "run" | "turn";
  turns?: number;
  /* The purpose the run's deadline cut (a value of `DEADLINE_PURPOSES`), on a `run-deadline` limit that cut one; absent otherwise. */
  purpose?: string;
}

/* What a run kept going with after a fault it could not recover from, as a closed set. */
export const RUN_DEGRADATIONS = ["publication-failed", "deadline-after-proof"] as const;
export type RunDegradationReason = (typeof RUN_DEGRADATIONS)[number];

export interface RunDegradationFact {
  reason: RunDegradationReason;
  /* The sentence the run's note carries for it; the note is derived from these, never the other way. */
  note: string;
}

export interface RunTraceFacts {
  /* What the run decided; absent when the run ended before it had a decision (an unhandled error). */
  decision?: RunDecisionOutcome;
  /* Whether shadow replaced that decision (nothing was opened). Absent with `decision`. */
  shadowed?: boolean;
  generationEnd?: string;
  /* Why the run ended (a value of the engine's closed set of end reasons); absent when it ended on an error nothing handled. */
  endReason?: string;
  /* Every limit that fired, in the order the engine met them; `limitFired`/`limitRole` are the first the engine met at run level, the one the run's record and views lead with (none when only turns met a limit). */
  limits?: RunLimitFact[];
  limitFired?: string;
  limitRole?: string;
  /* Every fault the run went on past. */
  degradations?: RunDegradationFact[];
  /* Whether the engine ran a reviewer for this run (the same rule the generation applies), decided at run time. */
  reviewRequired?: boolean;
  /* The kind of run the deadline bounded it as (a row of the run time budget table); absent when the run ended before its deadline was armed. */
  timeBudget?: string;
  /* The engine's change-coverage decision, absent when the run never measured, and the policy in force. Grading reads these and never the app's current configuration. */
  coverage?: { status?: "pass" | "fail" | "unknown"; mode: string; minRatio?: number };
}

/* The limit the record and the views lead with: the first the engine met at run level. A limit only agent turns met is listed with the others and leads nothing: a run that went on past a turn's cap is not one a budget ended. */
export function primaryLimit(limits: readonly RunLimitFact[]): RunLimitFact | undefined {
  return limits.find((limit) => limit.scope === "run");
}

/* The run's limits with the ones its turns ended on added (a cancel, a fault or no limit is none): a limit the engine already recorded at run level is the turn it stopped, seen from above, and is not counted twice. */
export function mergeTurnLimits(limits: readonly RunLimitFact[], turnLimits: ReadonlyArray<{ fired: string; role: string; turns: number }>): RunLimitFact[] {
  const merged = [...limits];
  for (const turn of turnLimits) {
    if (!isBindingLimit(turn.fired)) continue;
    if (limits.some((limit) => limit.scope === "run" && limit.fired === turn.fired)) continue;
    merged.push({ fired: turn.fired, role: turn.role, scope: "turn", turns: turn.turns });
  }
  return merged;
}

const factsOfOutcome = new WeakMap<object, RunTraceFacts>();

/* Remembers the facts for `outcome` and returns it. */
export function attachTraceFacts<T extends object>(outcome: T, facts: RunTraceFacts): T {
  factsOfOutcome.set(outcome, facts);
  return outcome;
}

export function traceFactsOf(outcome: object): RunTraceFacts | undefined {
  return factsOfOutcome.get(outcome);
}
