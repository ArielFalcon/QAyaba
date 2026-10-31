/*
 * How a run ends when the engine returns and when it throws: the facts its record and root span state, and the class and note of a
 * crash. One class names a crash on the run's record, its outcome, its trace root and the metric.
 */
import { isInfraError, isUntrustedGitTreeError } from "@kernel/domain-error.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { mergeTurnLimits, primaryLimit, traceFactsOf } from "@kernel/run-trace-facts.ts";
import type { PhaseSnapshot } from "./run-phase-cursor.ts";
import type { RunFacts } from "./run-trace.ts";

/* The facts a run states of how it ended when the engine answered. */
export function runFactsOfOutcome(outcome: RunOutcome): RunFacts {
  const traceFacts = traceFactsOf(outcome);
  return {
    verdict: outcome.verdict,
    errorClass: outcome.errorClass,
    furthestPhase: outcome.gateSignals.furthestPhase,
    decision: traceFacts?.decision,
    shadowed: traceFacts?.shadowed,
    generationEnd: traceFacts?.generationEnd,
    endReason: traceFacts?.endReason,
    limitFired: traceFacts?.limitFired,
    limitRole: traceFacts?.limitRole,
    limits: traceFacts?.limits,
    degradations: traceFacts?.degradations,
    reviewRequired: traceFacts?.reviewRequired,
    timeBudget: traceFacts?.timeBudget,
    coverage: traceFacts?.coverage,
  };
}

/* The facts a crashed run states: where the engine says the run stood and how generation ended, on the error itself; a failure from anywhere else has nothing to add. */
export function runFactsOfCrash(error: unknown, reached: PhaseSnapshot | undefined, specs: RunFacts["specs"]): Omit<RunFacts, "verdict" | "errorClass"> {
  const crashFacts = typeof error === "object" && error !== null ? traceFactsOf(error) : undefined;
  return {
    ...(reached?.furthestPhase ? { furthestPhase: reached.furthestPhase } : {}),
    ...(crashFacts?.decision ? { decision: crashFacts.decision } : {}),
    ...(crashFacts?.shadowed !== undefined ? { shadowed: crashFacts.shadowed } : {}),
    ...(crashFacts?.generationEnd ? { generationEnd: crashFacts.generationEnd } : {}),
    ...(crashFacts?.limits ? { limits: crashFacts.limits } : {}),
    ...(crashFacts?.limitFired ? { limitFired: crashFacts.limitFired } : {}),
    ...(crashFacts?.limitRole ? { limitRole: crashFacts.limitRole } : {}),
    ...(crashFacts?.degradations ? { degradations: crashFacts.degradations } : {}),
    ...(crashFacts?.reviewRequired !== undefined ? { reviewRequired: crashFacts.reviewRequired } : {}),
    ...(crashFacts?.timeBudget ? { timeBudget: crashFacts.timeBudget } : {}),
    ...(crashFacts?.coverage ? { coverage: crashFacts.coverage } : {}),
    ...(specs ? { specs } : {}),
  };
}

/* The run's facts with the limits its agent turns ended on added to the ones the engine met at run level; the record and the root span both take the result, so they list the same limits and lead with the same one (the first the engine met: a limit only turns met leads nothing). */
export function withTurnLimits<F extends Pick<RunFacts, "limits" | "limitFired" | "limitRole">>(facts: F, turnLimits: ReadonlyArray<{ fired: string; role: string; turns: number }>): F {
  /* A port that states only the limit it leads with is read as having met that one. */
  const engineLimits = facts.limits ?? (facts.limitFired ? [{ fired: facts.limitFired, role: facts.limitRole ?? "", scope: "run" as const }] : []);
  const limits = mergeTurnLimits(engineLimits, turnLimits);
  const first = primaryLimit(limits);
  return { ...facts, limits, ...(first ? { limitFired: first.fired, limitRole: first.role } : {}) };
}

export const CRASH_ERROR_CLASS = { SECURITY_REFUSAL: "security-refusal", INFRA: "E-INFRA", INTERNAL: "internal-error" } as const;
export type CrashErrorClass = (typeof CRASH_ERROR_CLASS)[keyof typeof CRASH_ERROR_CLASS];

export interface CrashEnding {
  errorClass: CrashErrorClass;
  /* The note the run's record keeps. */
  note: string;
  /* What the log line says the run came to. */
  label: string;
}

/*
 * Classifies a crash by TYPE, not by substring. Genuine INFRASTRUCTURE (an InfraError or one of its subclasses — deploy-gate
 * timeout, agent unavailable or stalled — or an operator cancel) is a transient, non-code condition. A working copy whose git dir
 * is not the orchestrator's own is a SECURITY REFUSAL: nothing ran, so the verdict is inconclusive, but it is neither a transient
 * infrastructure fault nor a code defect. Anything else thrown out of the engine (a rejected git push, a JSON.parse that threw, an
 * open circuit breaker) is an UNEXPECTED INTERNAL ERROR: still inconclusive, but a defect to surface, not silently laundered into
 * a benign "infrastructure, ignore". `message` is the error's text, already redacted.
 */
export function runCrashEnding(error: unknown, message: string): CrashEnding {
  if (isUntrustedGitTreeError(error)) {
    return {
      errorClass: CRASH_ERROR_CLASS.SECURITY_REFUSAL,
      note: `security refusal — the working copy's git dir is not the orchestrator's own, so no git ran: ${message}`,
      label: "REFUSED (security refusal: untrusted git tree)",
    };
  }
  if (isInfraError(error)) return { errorClass: CRASH_ERROR_CLASS.INFRA, note: message, label: "infra-error" };
  return { errorClass: CRASH_ERROR_CLASS.INTERNAL, note: `unexpected internal error (not infrastructure — investigate): ${message}`, label: "CRASHED (internal error)" };
}
