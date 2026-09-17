import type { AgentRuntimePort, AgentSession, OpenSessionOpts,
  UsageSnapshot, AgentTurnEvent, AgentOpenDescriptor } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

interface LegacyAgentDeps {
  open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string;
    onUsage?: (u: UsageSnapshot) => void; onTurn?: (t: AgentTurnEvent) => void; descriptor?: AgentOpenDescriptor }): Promise<{
      id: string; prompt(text: string, o?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null }): Promise<string>; dispose(): Promise<void>;
    }>;
}

export class AgentRuntimeAdapter implements AgentRuntimePort {
  constructor(private readonly deps: LegacyAgentDeps, private readonly roleToAgentName: (r: AgentRole) => string) {}
  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    const s = await this.deps.open(this.roleToAgentName(role), cwd, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      ...(opts?.onTurn ? { onTurn: opts.onTurn } : {}),
      ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
    });
    return {
      prompt: async (text, o) => ({ output: await s.prompt(text, o) }),
      dispose: () => s.dispose(),
    };
  }
}
