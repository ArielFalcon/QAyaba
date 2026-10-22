/* What kind of failure a flow's run_spec call met, read from the facts the orchestrator kept of it, never from the sidekick's
   account. Pure and deterministic: the same rules as the fix loop's adjudicator (an attributed 5xx or a framework/uncaught
   runtime error is the app's; the failure detail's class otherwise), with the page's settle state, which tells a page still
   loading from one that settled without the element. First match wins. */
import { classifyFailure } from "../../domain/helpers/progress-gate.ts";
import { classifyRuntimeErrors } from "../../domain/adjudicate.service.ts";
import type { FlowFailureFact } from "../ports/index.ts";

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

/* What the next attempt is told about the failure, by its kind. An app defect is never one: the flow ends on it. */
export function authoringFailureFeedback(failure: AuthoringFailure | undefined): string {
  switch (failure?.kind) {
    case AUTHORING_FAILURE.PAGE_NOT_SETTLED:
      return "At its failure point the page was still loading (data requests in flight, or its tree still changing): wait for the page's data before looking for the element, and keep the assertion as strong as it was.";
    case AUTHORING_FAILURE.NOT_FOUND:
      return "At its failure point the element your locator names was not in the page's tree, which your run_spec report shows: build the locator from that tree, or reach the page the way a user does when that tree is not the page you meant.";
    case AUTHORING_FAILURE.VALUE_MISMATCH:
      return "An assertion read another value than it expected. The expected value comes from the change and its contract, never from what the page shows: when the page is wrong, keep the assertion and report it in concerns.";
    default:
      return "";
  }
}
