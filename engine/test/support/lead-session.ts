/*
 * A lead session double whose turns are scripted as the answers the lead gives, each a JSON object: the turn is judged by the
 * contract it is asked through, as the orchestrator judges a submission, and a turn whose answer the contract refuses (or that gave
 * none) is one that delivered no accepted submission. The submit tool and the continuation are the mechanism's, tested in
 * `submission.test.ts`; this stands in for them where a test is about what the coordinator does with the answer.
 */
import type { LeadSessionHandle, LeadTurnOpts } from "@kernel/plan-output.ts";
import { describeNoSubmission } from "@kernel/submission.ts";

export interface ScriptedAnswer {
  output: string;
  timedOut: boolean;
}

export function submittingFrom(answer: (text: string, opts: LeadTurnOpts) => Promise<ScriptedAnswer>): LeadSessionHandle["askSubmitting"] {
  return async (text, opts, contract) => {
    const given = await answer(text, opts);
    if (given.timedOut) return { timedOut: true };
    const miss = (errors: readonly { path: string; reason: string }[]) => ({ noSubmission: describeNoSubmission({ end: "stopped", errors, calls: 1, continued: true, continuationTimedOut: false }), timedOut: false });
    let parsed: unknown;
    try {
      parsed = JSON.parse(given.output);
    } catch {
      return miss([]);
    }
    const checked = contract.check(parsed);
    return checked.ok ? { value: checked.value, timedOut: false } : miss(checked.errors);
  };
}
