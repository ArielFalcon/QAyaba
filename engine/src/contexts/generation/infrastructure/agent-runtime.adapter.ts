import type { AgentRuntimePort, AgentSession, OpenSessionOpts, AgentPromptOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { AssertNever, ForwardsAll, MissingForwards } from "@kernel/forwarding.ts";

interface AgentSessionDeps {
  open(agent: string, cwd: string, opts?: OpenSessionOpts): Promise<{
      id: string; prompt(text: string, o?: AgentPromptOpts): Promise<string>; dispose(): Promise<void>;
    }>;
}

export class AgentRuntimeAdapter implements AgentRuntimePort {
  constructor(private readonly deps: AgentSessionDeps, private readonly roleToAgentName: (r: AgentRole) => string) {}
  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    /* The options go through whole, so one the port gains reaches the transport without this class naming it. */
    const s = await this.deps.open(this.roleToAgentName(role), cwd, opts);
    return {
      prompt: async (text, o) => ({ output: await s.prompt(text, o) }),
      dispose: () => s.dispose(),
    } satisfies ForwardsAll<AgentSession>;
  }
}

/* A method AgentRuntimePort gains is a compile error here until AgentRuntimeAdapter forwards it. */
type _AgentRuntimeAdapterForwards = AssertNever<MissingForwards<AgentRuntimePort, AgentRuntimeAdapter>>;
