/*
 * The end a failure's policy calls for, built once the run is known: the facts a reason carries come from the error and the trail,
 * and what the run says aloud about it is said here. `guarded` (steps and effects) and the use case's entry for errors outside any
 * step both ask this, so a failure ends the run the same way wherever it was thrown.
 */

import { GENERATION_END } from "@kernel/generation-end.ts";
import { ERROR_CLASS } from "../../domain/helpers/error-class.ts";
import { renderRunDeadlineNote } from "../../domain/run-time-budget.ts";
import { isRunDeadlineError } from "../../../../shared-kernel/run-deadline.ts";
import type { EndReason } from "./end-reason.ts";
import { runEnd, type RunEnd } from "./run-end.ts";
import type { RunQaUseCaseDeps, RunTrail } from "./run-types.ts";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function failureEnd(reason: EndReason, err: unknown, run: { deps: RunQaUseCaseDeps; trail: RunTrail }): RunEnd {
  const { deps, trail } = run;
  const rules = trail.rulesRetrieved ? { rulesRetrieved: trail.rulesRetrieved } : {};
  switch (reason) {
    case "aborted":
      return runEnd("aborted");
    case "run-deadline": {
      /*
       * The run's time ran out: an agent turn was refused or stopped by the run-level deadline. The run ends as a persisted
       * infra-error under E-TIME-BUDGET with a note that says so, never as an empty result and never as an uncaught integration
       * error. Nothing is published and nothing is learned (how long the agents took says nothing about the app or the tests).
       */
      if (!isRunDeadlineError(err)) throw err;
      trail.limit = { fired: "run-deadline", role: err.role };
      trail.generationEnd ??= GENERATION_END.TIME_BUDGET;
      const note = renderRunDeadlineNote({ budgetMs: err.budgetMs, label: err.label, role: err.role, stop: err.stop });
      console.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      deps.observer?.onEvent({
        type: "log.line",
        level: "error",
        text: `[qa] the run ended on its time budget (${ERROR_CLASS.TIME_BUDGET}): an engine-side limit on how long the agents may take, not a fault of the app under test`,
      });
      return runEnd("run-deadline", { note, generationEnd: GENERATION_END.TIME_BUDGET, ...rules });
    }
    case "sandbox-unavailable": {
      /*
       * The run could not execute agent-influenced code safely (no sandbox uid under QA_EXEC_SANDBOX=required, or the egress filter
       * is down under QA_EGRESS_MODE=enforce). It ends as a persisted infra-error of its own class, E-SANDBOX: nothing is learned
       * from it and no Issue is opened, since it says nothing about the app or the tests, and the operator sees why on the record.
       */
      const note = `The run could not execute the tests safely and ended without running them (${ERROR_CLASS.SANDBOX}): ${messageOf(err)}`;
      console.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      return runEnd("sandbox-unavailable", { note, ...rules });
    }
    case "probe-sweep-failed": {
      /* The throwaway specs of the closed loop could not be swept: nothing in the working copy can be trusted to be a deliverable, so the run ends as a persisted infra-error before it validates, executes or publishes anything. */
      const note = messageOf(err);
      console.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      return runEnd("probe-sweep-failed", { note, ...rules });
    }
    case "publication-failed":
      return runEnd("publication-failed", { note: messageOf(err) });
    default:
      throw new Error(`no end is built for a failure that ends the run as "${reason}"`);
  }
}
