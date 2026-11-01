import type { AgentRuntimePort, AgentSession, OpenSessionOpts, AgentPromptOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { AssertNever, ForwardsAll, MissingForwards } from "@kernel/forwarding.ts";
import { isAgentOutputLengthError } from "@kernel/domain-error.ts";
import type { SubmissionEnd, SubmissionPort } from "@kernel/submission.ts";

interface AgentSessionDeps {
  open(agent: string, cwd: string, opts?: OpenSessionOpts): Promise<{
      id: string; prompt(text: string, o?: AgentPromptOpts): Promise<string>; dispose(): Promise<void>;
    }>;
}

export class AgentRuntimeAdapter implements AgentRuntimePort {
  constructor(
    private readonly deps: AgentSessionDeps,
    private readonly roleToAgentName: (r: AgentRole) => string,
    private readonly submissions?: SubmissionPort,
  ) {}
  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    /* The options go through whole, so one the port gains reaches the transport without this class naming it. */
    const agent = this.roleToAgentName(role);
    const s = await this.deps.open(agent, cwd, opts);
    return {
      prompt: async (text, o) => {
        const contract = o?.submit;
        if (contract === undefined) return { output: await s.prompt(text, o) };
        if (!this.submissions) throw new Error("a prompt asked for a submission, which the orchestrator's tools endpoint serves, and this process offers none (is QA_TOOLS_TOKEN set, and the same, on the orchestrator and agents services?)");
        const slot = this.submissions.arm(s.id, agent, contract);
        try {
          let output = "";
          let end: SubmissionEnd = "stopped";
          try {
            output = await s.prompt(text, o);
          } catch (err) {
            if (!isAgentOutputLengthError(err)) throw err;
            end = "output-length";
          }
          return { output, submission: slot.report(end) };
        } finally {
          slot.close();
        }
      },
      dispose: () => s.dispose(),
    } satisfies ForwardsAll<AgentSession>;
  }
}

/* A method AgentRuntimePort gains is a compile error here until AgentRuntimeAdapter forwards it. */
type _AgentRuntimeAdapterForwards = AssertNever<MissingForwards<AgentRuntimePort, AgentRuntimeAdapter>>;
