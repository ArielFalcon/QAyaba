/*
 * What a fake agent session answers a prompt that carries a submit contract: the report the orchestrator's submission registry
 * would give if the agent called the submit tool with `answer`, judged by the contract the prompt carries. `didNotSubmit` is a turn
 * that ended with words and no call.
 */
import type { AgentPromptOpts, AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
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

/** The object a fake agent's text carries: the first `{` from which the rest of the text reads as one JSON value. */
export function objectIn(text: string): Record<string, unknown> | undefined {
  for (let at = text.indexOf("{"); at !== -1; at = text.indexOf("{", at + 1)) {
    try {
      const value: unknown = JSON.parse(text.slice(at));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      /* not JSON from here */
    }
  }
  return undefined;
}

/**
 * A fake runtime read as an agent that delivers by submit tool: a prompt that carries a contract is answered as if the agent called
 * the tool with the JSON object its text holds, and as a turn that made no call when the text holds none.
 */
export function submittingRuntime<R extends Pick<AgentRuntimePort, "openSession">>(runtime: R): R {
  return {
    ...runtime,
    openSession: async (...args: Parameters<AgentRuntimePort["openSession"]>) => {
      const session: AgentSession = await runtime.openSession(...args);
      return {
        ...session,
        prompt: async (text: string, opts?: AgentPromptOpts) => {
          const reply = await session.prompt(text, opts);
          if (!opts?.submit) return reply;
          const answer = objectIn(reply.output);
          return { ...reply, submission: (answer ? submittedBy(answer, opts) : didNotSubmit(reply.output)).submission };
        },
      };
    },
  };
}
