/*
 * What a failure does to a run. Every error a step lets escape, and every fault a step carries past, is told apart by
 * `classifyFailure` (the only reader of the error predicates) into a closed `FailureKind`; the kind and the class of the step that
 * failed pick one action from POLICY: end the run for a reason, rethrow the error, or carry on (said aloud, never silent). A step
 * no longer remembers which errors it must not swallow: it is wrapped in `guarded`, and a catch that carries on asks `carryOn`.
 * A fault that reaches a step of class `proven` after a suite ran green on its final bytes may also degrade: the run goes on to the
 * final guard with what it proved and the fault named on the outcome, unless the run requires a review verdict it does not have.
 * This file is pure: it runs no step and builds no end; the caller that knows the run builds the end a reason calls for.
 */

import { isInfraError, isUntrustedGitTreeError } from "../../../../shared-kernel/domain-error.ts";
import { isRunDeadlineError } from "../../../../shared-kernel/run-deadline.ts";
import { RunAbortedError } from "./abort.ts";
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

export const FAILURE_KINDS = ["aborted", "run-deadline", "no-author", "sandbox-unavailable", "probe-sweep", "untrusted-tree", "publication", "integration", "unknown"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/*
 * What a step is to the run. `required`: the run cannot continue without its result and nothing is proven yet. `proven`: it runs
 * after a suite has run green on its final bytes (coverage regeneration, review, stale re-measure, final-proof guard). `off-path`:
 * a side effect the verdict does not depend on (context-map capture, the suite store, code-graph indexing, mirror prune, learning).
 * `publish`: the publication effect.
 */
export const STEP_CLASSES = ["required", "proven", "off-path", "publish"] as const;
export type StepClass = (typeof STEP_CLASSES)[number];

/** What a run keeps going with after a fault it cannot recover from, said on the outcome. */
export type DegradeReason = "publication-failed" | "deadline-after-proof";

export type FailureAction = { do: "rethrow" } | { do: "fail-open" } | { do: "end"; reason: EndReason } | { do: "degrade"; reason: DegradeReason };

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
  /* Nothing was authored and nothing is proven: the run ends with the reason, whatever the step. */
  "no-author": endFor("no-author"),
  "sandbox-unavailable": endFor("sandbox-unavailable"),
  "probe-sweep": endFor("probe-sweep-failed"),
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
  /* By name: the launcher lives outside the application layer. A refusal to open the run's scope is the caller's own business, not a step's. */
  if (err instanceof Error && err.name === "SandboxUnavailableError" && (err as { reason?: unknown }).reason !== "scope") return "sandbox-unavailable";
  if (err instanceof NoAuthorError) return "no-author";
  if (err instanceof ProbeSweepError) return "probe-sweep";
  if (isUntrustedGitTreeError(err)) return "untrusted-tree";
  if (err instanceof PublicationFailedError) return "publication";
  if (isInfraError(err)) return "integration";
  return "unknown";
}

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
        console.error(`[qa] ${site.id}: ${classifyFailure(err)} fault carried on (${site.class} step): ${messageOf(err)}`);
        return undefined;
      case "end":
        return { end: endOf(action.reason, err) };
      case "degrade":
        /* Only a caller that knows where the run goes on from a degraded step says so; an effect that degrades asks the policy itself. */
        if (!degradeOf) throw err;
        console.error(`[qa] ${site.id}: ${classifyFailure(err)} fault degraded the run (${action.reason}): ${messageOf(err)}`);
        return await degradeOf(action.reason, err);
    }
  }
}

/**
 * For a catch inside a step that carries on past a fault of something off the verdict's path: call it first in the block. It
 * returns when the policy lets that kind of fault be carried past, and rethrows the error otherwise (the deadline, a cancelled
 * run, an untrusted git tree, a sandbox that cannot be trusted), which the wrapping `guarded` then turns into the run's end.
 */
export function carryOn(err: unknown): void {
  if (POLICY[classifyFailure(err)]["off-path"].do !== "fail-open") throw err;
}
