/*
 * What a failure does to a run. Every error a step lets escape, and every fault a step carries past, is told apart by
 * `classifyFailure` (the only reader of the error predicates) into a closed `FailureKind`; the kind and the class of the step that
 * failed pick one action from POLICY: end the run for a reason, rethrow the error, or carry on (said aloud, never silent). A step
 * no longer remembers which errors it must not swallow: it is wrapped in `guarded`, and a catch that carries on asks `carryOn`.
 * A fault that reaches a step of class `proven` after a suite ran green on its final bytes may also degrade: the run goes on to the
 * final guard with what it proved and the fault named on the outcome, unless the run requires a review verdict it does not have.
 * This file is pure: it runs no step and builds no end; the caller that knows the run builds the end a reason calls for.
 */

import { LOG_EFFECT, levelOfEffect, type LevelOfEffect, type LogEffect } from "@kernel/ports/logger.port.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import { isInfraError, isUntrustedGitTreeError } from "../../../../shared-kernel/domain-error.ts";
import { isAllotmentSpentError, isRunDeadlineError } from "../../../../shared-kernel/run-deadline.ts";
import { RunAbortedError } from "./abort.ts";
import type { RunDegradationReason } from "@kernel/run-trace-facts.ts";
import type { EndReason } from "./end-reason.ts";

/** The throwaway specs of the closed loop could not be removed from the working copy. */
export class ProbeSweepError extends Error {
  constructor(reason: string) {
    super(`the run_spec probes could not be removed from the working copy (${reason})`);
    this.name = "ProbeSweepError";
  }
}

/** The publication port failed after the verdict was decided; the publish effect wraps what the port threw. */
export class PublicationFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PublicationFailedError";
  }
}

/** No author sidekick could run: the coordinator refused the run or failed; `refusal` is the code the run records. */
export class NoAuthorError extends Error {
  constructor(readonly refusal: string, reason: string, options?: { cause?: unknown }) {
    super(`no author sidekick could run (${refusal}): ${reason}`, options);
    this.name = "NoAuthorError";
  }
}

/** The reason a run whose session the app ended records on its E-PRECONDITION: recorded, never learned from, no Issue. */
export const SESSION_LOST = "session-lost";

/** The app ended the session of a judging execution, and again the one the run had just signed in for its re-run: the check showed it gone both times, so neither execution judged the specs. */
export class SessionLostError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionLostError";
  }
}

/** The run's login, asked to renew a session the check showed lost, could not sign in: the end the login before execute has (`preconditionFailed` when it failed on a positive piece of evidence). */
export class LoginRenewalError extends Error {
  constructor(reason: string, readonly preconditionFailed: boolean) {
    super(reason);
    this.name = "LoginRenewalError";
  }
}

export const FAILURE_KINDS = ["aborted", "run-deadline", "allotment", "no-author", "sandbox-unavailable", "probe-sweep", "session-lost", "login-renewal", "untrusted-tree", "publication", "integration", "unknown"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/*
 * What a step is to the run. `required`: the run cannot continue without its result and nothing is proven yet. `proven`: it runs
 * after a suite has run green on its final bytes (coverage regeneration, review, stale re-measure, final-proof guard). `off-path`:
 * a side effect the verdict does not depend on (context-map capture, the suite store, code-graph indexing, mirror prune, learning).
 * `publish`: the publication effect.
 */
export const STEP_CLASSES = ["required", "proven", "off-path", "publish"] as const;
export type StepClass = (typeof STEP_CLASSES)[number];

/** What a run keeps going with after a fault it cannot recover from, said on the outcome: the reasons the policy can name, of the closed set the run's trace records. */
export type DegradeReason = Extract<RunDegradationReason, "publication-failed" | "deadline-after-proof">;

export type FailureAction = { do: "rethrow" } | { do: "fail-open" } | { do: "end"; reason: EndReason } | { do: "degrade"; reason: DegradeReason };

/* What each action does to the run, for the line that says it; null: no line is written (the error goes on to its owner). */
export const FAILURE_ACTION_EFFECT = {
  rethrow: null,
  "fail-open": LOG_EFFECT.CARRIED_ON,
  end: LOG_EFFECT.ENDED,
  degrade: LOG_EFFECT.CARRIED_ON,
} as const satisfies Record<FailureAction["do"], LogEffect | null>;

const RETHROW: FailureAction = { do: "rethrow" };
const FAIL_OPEN: FailureAction = { do: "fail-open" };
const endFor = (reason: EndReason): Record<StepClass, FailureAction> => {
  const action: FailureAction = { do: "end", reason };
  return { required: action, proven: action, "off-path": action, publish: action };
};
const always = (action: FailureAction): Record<StepClass, FailureAction> => ({ required: action, proven: action, "off-path": action, publish: action });

export const POLICY: Readonly<Record<FailureKind, Readonly<Record<StepClass, FailureAction>>>> = {
  aborted: endFor("aborted"),
  /* A spent deadline after a suite ran green on its final bytes keeps what is proven (the run goes on to the final proof guard and the decision); anywhere else nothing is proven and the run ends. */
  "run-deadline": { ...endFor("run-deadline"), proven: { do: "degrade", reason: "deadline-after-proof" } },
  /*
   * A purpose's share of the run's time is spent while the run still has time. It is that turn's timeout, not the run's: a step that
   * follows its own path for a turn that ran out of time (a regeneration is skipped, a flow is unanswered, the reviewer is unavailable)
   * never lets it escape. One that does has no path of its own: before a suite is proven the run cannot go on and ends on its time
   * budget; after, it keeps what is proven (the same degrade as the deadline's, which fails closed on a review it requires); a side
   * effect off the verdict's path is carried past; the publication has no share of its own to spend.
   */
  allotment: { required: { do: "end", reason: "run-deadline" }, proven: { do: "degrade", reason: "deadline-after-proof" }, "off-path": FAIL_OPEN, publish: RETHROW },
  /* Nothing was authored and nothing is proven: the run ends with the reason, whatever the step. */
  "no-author": endFor("no-author"),
  "sandbox-unavailable": endFor("sandbox-unavailable"),
  "probe-sweep": endFor("probe-sweep-failed"),
  /* The app ended the session the executions ran with: what they said is no judgment of the specs, so nothing they gave is kept. */
  "session-lost": endFor("login-precondition"),
  /* The login that renews a lost session failed: the run ends as its login before execute would have. */
  "login-renewal": endFor("pre-execute-infra"),
  "untrusted-tree": always(RETHROW),
  /* The verdict was decided before the port failed: the run keeps it, says the publication failed, and records the run. */
  publication: { required: RETHROW, proven: RETHROW, "off-path": RETHROW, publish: { do: "degrade", reason: "publication-failed" } },
  /* A fault of a collaborator that is off the verdict's path never changes the verdict; it is said, and the run goes on. */
  integration: { required: RETHROW, proven: RETHROW, "off-path": FAIL_OPEN, publish: RETHROW },
  unknown: { required: RETHROW, proven: RETHROW, "off-path": FAIL_OPEN, publish: RETHROW },
};

/** Tells an error apart by what it means for the run; the only place that reads the error predicates. */
export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof RunAbortedError) return "aborted";
  if (isRunDeadlineError(err)) return "run-deadline";
  if (isAllotmentSpentError(err)) return "allotment";
  /* By name: the launcher lives outside the application layer. A refusal to open the run's scope is the caller's own business, not a step's. */
  if (err instanceof Error && err.name === "SandboxUnavailableError" && (err as { reason?: unknown }).reason !== "scope") return "sandbox-unavailable";
  if (err instanceof NoAuthorError) return "no-author";
  if (err instanceof ProbeSweepError) return "probe-sweep";
  if (err instanceof SessionLostError) return "session-lost";
  if (err instanceof LoginRenewalError) return "login-renewal";
  if (isUntrustedGitTreeError(err)) return "untrusted-tree";
  if (err instanceof PublicationFailedError) return "publication";
  if (isInfraError(err)) return "integration";
  return "unknown";
}

/** The error a step cut by the run's deadline ends with: the deadline's own error when the step already threw it (it knows the turn it stopped), else the one `cut` builds with the step's fault as its cause. */
export const cutByDeadline = (cause: unknown, cut: () => Error): Error => (isRunDeadlineError(cause) ? cause : cut());

export const actionFor = (err: unknown, stepClass: StepClass): FailureAction => POLICY[classifyFailure(err)][stepClass];

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Wraps a step: what it throws is classified, and the policy for the step's class either ends the run (the end the caller builds
 * for that reason), carries on (said aloud) or rethrows the identical error, unwrapped.
 */
export async function guarded<O, E>(
  site: { id: string; class: StepClass },
  run: () => Promise<O>,
  endOf: (reason: EndReason, err: unknown) => E,
  degradeOf?: (reason: DegradeReason, err: unknown) => O | { end: E } | Promise<O | { end: E }>,
): Promise<O | { end: E } | undefined> {
  try {
    return await run();
  } catch (err) {
    const action = actionFor(err, site.class);
    switch (action.do) {
      case "rethrow":
        throw err;
      case "fail-open":
        engineLog[levelOfEffect(FAILURE_ACTION_EFFECT["fail-open"])](`[qa] ${site.id}: ${classifyFailure(err)} fault carried on (${site.class} step): ${messageOf(err)}`);
        return undefined;
      case "end":
        return { end: endOf(action.reason, err) };
      case "degrade":
        /* Only a caller that knows where the run goes on from a degraded step says so; an effect that degrades asks the policy itself. */
        if (!degradeOf) throw err;
        engineLog[levelOfEffect(FAILURE_ACTION_EFFECT.degrade)](`[qa] ${site.id}: ${classifyFailure(err)} fault degraded the run (${action.reason}): ${messageOf(err)}`);
        return await degradeOf(action.reason, err);
    }
  }
}

/**
 * For a catch inside a step that carries on past a fault of something off the verdict's path: call it first in the block. It
 * returns the level of the line that says the fault when the policy lets that kind of fault be carried past, and rethrows the
 * error otherwise (the deadline, a cancelled run, an untrusted git tree, a sandbox that cannot be trusted), which the wrapping
 * `guarded` then turns into the run's end.
 */
export function carryOn(err: unknown): LevelOfEffect<typeof FAILURE_ACTION_EFFECT["fail-open"]> {
  if (POLICY[classifyFailure(err)]["off-path"].do !== "fail-open") throw err;
  return levelOfEffect(FAILURE_ACTION_EFFECT["fail-open"]);
}
