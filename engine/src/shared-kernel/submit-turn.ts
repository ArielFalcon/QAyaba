import { isAgentTimeoutError } from "./domain-error.ts";
import type { AgentPromptOpts, AgentSession } from "./ports/agent-runtime.port.ts";
import { submissionContinuationPrompt, type SubmissionContract, type SubmissionReport, type SubmittedTurn } from "./submission.ts";

const NOT_SUBMITTED = { accepted: false, calls: 0, errors: [], end: "stopped" } as const satisfies SubmissionReport;

/**
 * One turn that must end with an accepted submission. A turn that does not deliver one gets exactly one continuation in the same
 * session, restricted to the submit tool and told the last rejection's errors; the session's runtime holds it to the time its
 * purpose is allotted. A missing submission is a result, never a throw. A caller that knows the session cannot act on a
 * continuation (its steps are spent) says so with `canContinue`, and the turn then ends as it stands.
 */
export async function submitTurn<T>(session: Pick<AgentSession, "prompt">, text: string, opts: AgentPromptOpts, contract: SubmissionContract<T>, canContinue: () => boolean = () => true): Promise<SubmittedTurn<T>> {
  const first = await session.prompt(text, { ...opts, submit: contract });
  const firstReport = first.submission ?? NOT_SUBMITTED;
  if (firstReport.accepted) return { submitted: true, value: firstReport.value as T, output: first.output, calls: firstReport.calls, continued: false };
  if (!canContinue()) return { submitted: false, output: first.output, end: firstReport.end, errors: firstReport.errors, calls: firstReport.calls, continued: false, continuationTimedOut: false };

  let second: Awaited<ReturnType<AgentSession["prompt"]>>;
  try {
    second = await session.prompt(submissionContinuationPrompt(contract.tool, firstReport), {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.timeLimit !== undefined ? { timeLimit: opts.timeLimit } : {}),
      ...(opts.stepLimit !== undefined ? { stepLimit: opts.stepLimit } : {}),
      isRepair: true,
      submit: contract,
      submitOnly: true,
    });
  } catch (err) {
    if (!isAgentTimeoutError(err)) throw err;
    return { submitted: false, output: first.output, end: firstReport.end, errors: firstReport.errors, calls: firstReport.calls, continued: true, continuationTimedOut: true };
  }
  const secondReport = second.submission ?? NOT_SUBMITTED;
  const calls = firstReport.calls + secondReport.calls;
  if (secondReport.accepted) return { submitted: true, value: secondReport.value as T, output: second.output, calls, continued: true };
  return {
    submitted: false,
    output: second.output.trim() !== "" ? second.output : first.output,
    end: secondReport.end,
    errors: secondReport.errors.length > 0 ? secondReport.errors : firstReport.errors,
    calls,
    continued: true,
    continuationTimedOut: false,
  };
}
