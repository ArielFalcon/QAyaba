/* What kind of failure a flow's run_spec call met is told by the tool's own domain (agent-tools): the trace of the call and the lead's facts name it the same way. The text the next attempt is told about it, by its kind, is the lead's. */
import { AUTHORING_FAILURE, type AuthoringFailure } from "@contexts/agent-tools/application/index.ts";

export { AUTHORING_FAILURE, classifyAuthoringFailure, type AuthoringFailure, type AuthoringFailureKind } from "@contexts/agent-tools/application/index.ts";

/* What the next attempt is told about the failure, by its kind. An app defect is never one: the flow ends on it. */
export function authoringFailureFeedback(failure: AuthoringFailure | undefined): string {
  switch (failure?.kind) {
    case AUTHORING_FAILURE.PAGE_NOT_SETTLED:
      return "At its failure point the page was still loading (data requests in flight, or its tree still changing): wait for the page's data before looking for the element, and keep the assertion as strong as it was.";
    case AUTHORING_FAILURE.NOT_FOUND:
      return "At its failure point the element your locator names was not in the page's tree, which your run_spec report shows: build the locator from that tree, or reach the page the way a user does when that tree is not the page you meant.";
    case AUTHORING_FAILURE.VALUE_MISMATCH:
      return "An assertion read another value than it expected. Which outcome to expect comes from the change and its contract, never from what the page shows: when the page shows another outcome, keep the assertion and report it in concerns. When it shows the same outcome in another form (a format, a locale, a rounding), take the exact text from the page.";
    default:
      return "";
  }
}
