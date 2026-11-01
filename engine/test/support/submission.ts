/*
 * What a fake agent session answers a prompt that carries a submit contract: the report the orchestrator's submission registry
 * would give if the agent called the submit tool with `answer`, judged by the contract the prompt carries. `didNotSubmit` is a turn
 * that ended with words and no call.
 */
import type { AgentPromptOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { SubmissionReport } from "@kernel/submission.ts";

export interface FakeReply {
  output: string;
  submission?: SubmissionReport;
}

export function submittedBy(answer: unknown, opts?: AgentPromptOpts): FakeReply {
  const contract = opts?.submit;
  if (!contract) return { output: "" };
  const checked = contract.check(answer);
  return checked.ok
    ? { output: "", submission: { accepted: true, value: checked.value, calls: 1 } }
    : { output: "", submission: { accepted: false, calls: 1, errors: checked.errors, end: "stopped" } };
}

export const didNotSubmit = (output = "I wrote the spec and ran it; it passes. No tool call from me."): FakeReply => ({ output, submission: { accepted: false, calls: 0, errors: [], end: "stopped" } });
