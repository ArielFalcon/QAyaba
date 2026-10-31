/*
 * The end a failure's policy calls for, built once the run is known: the facts a reason carries come from the error and the run's state,
 * and what the run says aloud about it is said here. `guarded` (steps and effects) and the use case's entry for errors outside any
 * step both ask this, so a failure ends the run the same way wherever it was thrown.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { ERROR_CLASS } from "@kernel/error-class.ts";
import { renderAllotmentNote, renderRunDeadlineNote } from "../../domain/run-time-budget.ts";
import type { AllotmentSpentError, RunDeadlineExceededError } from "../../../../shared-kernel/run-deadline.ts";
import { LoginRenewalError, NoAuthorError, SessionLostError, classifyFailure } from "./failure-policy.ts";
import type { EndReason } from "./end-reason.ts";
import { runEnd, type RunEnd } from "./run-end.ts";
import type { RunQaUseCaseDeps } from "./run-types.ts";
import type { RunState } from "./run-state.ts";
import { recordLimit, recordRunFact } from "./reducers.ts";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function failureEnd(reason: EndReason, err: unknown, run: { deps: RunQaUseCaseDeps }, state: Readonly<RunState>): RunEnd {
  const { deps } = run;
  switch (reason) {
    case "aborted":
      return runEnd("aborted");
    case "run-deadline": {
      /*
       * The run's time ran out: an agent turn was refused or stopped by the run-level deadline. The run ends as a persisted
       * infra-error under E-TIME-BUDGET with a note that says so, never as an empty result and never as an uncaught integration
       * error. Nothing is published and nothing is learned (how long the agents took says nothing about the app or the tests).
       */
      const kind = classifyFailure(err);
      if (kind === "allotment") {
        /* A share, not the run: a step with no path of its own for the end of its purpose's time (nothing is proven) ends the run on its time budget, naming the purpose that was cut. */
        const spent = err as AllotmentSpentError;
        recordLimit(state, { fired: "allotment", role: spent.role, purpose: spent.purpose });
        if (state.run.generationEnd === undefined) recordRunFact(state, "generationEnd", GENERATION_END.TIME_BUDGET);
        const note = renderAllotmentNote({ role: spent.role, purpose: spent.purpose, stop: spent.stop, ...(deps.runDeadline?.describe?.() ? { budgetMs: deps.runDeadline.describe()!.budgetMs, label: deps.runDeadline.describe()!.label } : {}) });
        engineLog.error(`[qa] ${note}`);
        deps.observer?.onEvent({ type: "agent.error", detail: note });
        return runEnd("run-deadline", { note, generationEnd: GENERATION_END.TIME_BUDGET });
      }
      if (kind !== "run-deadline") throw err;
      const deadline = err as RunDeadlineExceededError;
      recordLimit(state, { fired: "run-deadline", role: deadline.role, purpose: deadline.purpose });
      if (state.run.generationEnd === undefined) recordRunFact(state, "generationEnd", GENERATION_END.TIME_BUDGET);
      const note = renderRunDeadlineNote({ budgetMs: deadline.budgetMs, label: deadline.label, role: deadline.role, stop: deadline.stop, ...(deadline.purpose ? { purpose: deadline.purpose } : {}) });
      engineLog.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      deps.observer?.onEvent({
        type: "log.line",
        level: "error",
        text: `[qa] the run ended on its time budget (${ERROR_CLASS.TIME_BUDGET}): an engine-side limit on how long the agents may take, not a fault of the app under test`,
      });
      return runEnd("run-deadline", { note, generationEnd: GENERATION_END.TIME_BUDGET });
    }
    case "sandbox-unavailable": {
      /*
       * The run could not execute agent-influenced code safely (no sandbox uid under QA_EXEC_SANDBOX=required, or the egress filter
       * is down under QA_EGRESS_MODE=enforce). It ends as a persisted infra-error of its own class, E-SANDBOX: nothing is learned
       * from it and no Issue is opened, since it says nothing about the app or the tests, and the operator sees why on the record.
       */
      const note = `The run could not execute the tests safely and ended without running them (${ERROR_CLASS.SANDBOX}): ${messageOf(err)}`;
      engineLog.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      return runEnd("sandbox-unavailable", { note });
    }
    case "no-author": {
      /* No author sidekick could run: the run ends as a persisted infra-error of its own class, E-NO-AUTHOR, and the lead authors nothing in its place. */
      if (!(err instanceof NoAuthorError)) throw err;
      const note = `${messageOf(err)}. Nothing was authored; the lead never writes tests in the author's place (${ERROR_CLASS.NO_AUTHOR}).`;
      engineLog.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      deps.observer?.onEvent({ type: "log.line", level: "error", text: `[qa] the run ended with no author sidekick (${ERROR_CLASS.NO_AUTHOR}): an engine-side condition, not a fault of the app under test` });
      recordRunFact(state, "generationEnd", GENERATION_END.NO_AUTHOR);
      return runEnd("no-author", { refusal: err.refusal, note });
    }
    case "probe-sweep-failed": {
      /* The throwaway specs of the closed loop could not be swept: nothing in the working copy can be trusted to be a deliverable, so the run ends as a persisted infra-error before it validates, executes or publishes anything. */
      const note = messageOf(err);
      engineLog.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      return runEnd("probe-sweep-failed", { note });
    }
    case "login-precondition": {
      /* The app ended the run's session under its executions: recorded under E-PRECONDITION with the reason session-lost, never learned from and with no Issue, since it says nothing about the tests. */
      if (!(err instanceof SessionLostError)) throw err;
      const note = `The app ended the run's session (${ERROR_CLASS.PRECONDITION}, session lost): ${messageOf(err)}. The executions it cut judged nothing about the specs, so nothing was published.`;
      engineLog.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      return runEnd("login-precondition", { generating: state.classification.generating, note, sessionLost: true });
    }
    case "pre-execute-infra": {
      /* The run's login, asked to renew a session the check showed lost, could not sign in: the same end as a login before execute that fails, E-PRECONDITION on a positive piece of evidence. */
      if (!(err instanceof LoginRenewalError)) throw err;
      const note = messageOf(err);
      engineLog.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      return runEnd("pre-execute-infra", { generating: state.classification.generating, note, ...(err.preconditionFailed ? { preconditionFailed: true } : {}) });
    }
    default:
      throw new Error(`no end is built for a failure that ends the run as "${reason}"`);
  }
}
