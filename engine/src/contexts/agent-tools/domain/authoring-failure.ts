/* What kind of failure a flow's run_spec call met, read from the facts the orchestrator kept of it, never from the sidekick's
   account. Pure and deterministic: the same rules as the fix loop's adjudicator (an attributed 5xx or a framework/uncaught
   runtime error is the app's; the failure detail's class otherwise), with the page's settle state, which tells a page still
   loading from one that settled without the element. First match wins. */
import { classifyFailure } from "@kernel/failure-detail-class.ts";
import { classifyRuntimeErrors } from "@kernel/runtime-error-class.ts";
import type { FlowFailureFact } from "./closed-loop.ts";

export const AUTHORING_FAILURE = {
  /* The app is at fault: the spec is right to fail, and is never sent back to be made green. */
  APP_DEFECT: "app-defect",
  /* The element was not there, or not in time, while the page was still loading. */
  PAGE_NOT_SETTLED: "page-not-settled",
  /* The element was not there, or not in time, on a page that had settled or whose settle state was not read. */
  NOT_FOUND: "not-found",
  /* An assertion read another value than it expected. */
  VALUE_MISMATCH: "value-mismatch",
} as const;
export type AuthoringFailureKind = (typeof AUTHORING_FAILURE)[keyof typeof AUTHORING_FAILURE];

export interface AuthoringFailure {
  readonly kind: AuthoringFailureKind;
  readonly reason: string;
}

export function classifyAuthoringFailure(failures: readonly FlowFailureFact[] | undefined): AuthoringFailure | undefined {
  if (!failures?.length) return undefined;
  const fiveXx = failures.find((f) => f.httpStatus !== undefined && f.httpStatus >= 500 && f.httpStatus <= 599);
  if (fiveXx) return { kind: AUTHORING_FAILURE.APP_DEFECT, reason: `the page answered ${fiveXx.httpStatus}${fiveXx.path ? ` on ${fiveXx.path}` : ""}` };
  for (const f of failures) {
    const runtime = classifyRuntimeErrors([...(f.runtimeErrors ?? [])]);
    if (runtime.appDefect) return { kind: AUTHORING_FAILURE.APP_DEFECT, reason: `the page raised ${runtime.reasons[0]}` };
  }
  const classes = failures.map((f) => classifyFailure(f.detail ?? ""));
  const missing = failures.filter((_, i) => classes[i] === "locator" || classes[i] === "timeout");
  if (missing.some((f) => f.unsettled)) return { kind: AUTHORING_FAILURE.PAGE_NOT_SETTLED, reason: "the page was still loading at the failure point" };
  if (missing.length > 0) return { kind: AUTHORING_FAILURE.NOT_FOUND, reason: "the element was not on the page at the failure point" };
  if (classes.includes("value-mismatch")) return { kind: AUTHORING_FAILURE.VALUE_MISMATCH, reason: "an assertion read another value than it expected" };
  return undefined;
}

/* What a failed call tells its author when the failure is the app's: a finding to deliver as it is, not a spec to make green. */
export function appDefectNote(failures: readonly FlowFailureFact[] | undefined): string | undefined {
  const failure = classifyAuthoringFailure(failures);
  if (failure?.kind !== AUTHORING_FAILURE.APP_DEFECT) return undefined;
  return `the app is at fault (${failure.reason}): this failure is a finding, not a defect of the spec; deliver the spec as it is, without weakening an assertion, and say so in concerns`;
}

/* Why a run_spec call that did not pass failed, as the trace of the call names it: the kind of the facts its failing tests left (above), else what the report itself says (a spec that did not load, a saved session that was lost, a spec stopped at its time), else other. */
export const RUN_SPEC_FAILURE_KINDS = [...Object.values(AUTHORING_FAILURE), "load-error", "session-lost", "timed-out", "other"] as const;
export type RunSpecFailureKind = (typeof RUN_SPEC_FAILURE_KINDS)[number];

export function runSpecFailureKind(call: { failures: readonly FlowFailureFact[] | undefined; loadErrors: boolean; sessionLost: boolean; timedOut: boolean }): RunSpecFailureKind {
  const classified = classifyAuthoringFailure(call.failures);
  if (classified) return classified.kind;
  if (call.sessionLost) return "session-lost";
  if (call.loadErrors) return "load-error";
  if (call.timedOut) return "timed-out";
  return "other";
}
