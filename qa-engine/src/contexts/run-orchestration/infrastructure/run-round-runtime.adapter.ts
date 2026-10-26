/*
 * Numbers each role's generated turns across the sessions a run opens, so turn telemetry can tell a
 * regeneration's turn from the first pass: the transport's own round is session-local, and every
 * regeneration opens a new session, so it would always report 0. This decorator holds one counter per
 * runtime role and hands `promptOpts.round` on every non-repair turn (first pass 0, first
 * regeneration 1, …); a repair turn is left alone, so its session-local round stands exactly as it
 * was. Composed once per run, over the same runtime the deadline wrapper is.
 */
import type { AgentPromptOpts, AgentRuntimePort, AgentSession, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

export class RunRoundRuntime implements AgentRuntimePort {
  private readonly rounds = new Map<AgentRole, number>();

  constructor(private readonly inner: AgentRuntimePort) {}

  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    const session = await this.inner.openSession(role, cwd, opts);
    return {
      prompt: (text, promptOpts) => this.prompt(role, session, text, promptOpts),
      dispose: () => session.dispose(),
    };
  }

  private async prompt(role: AgentRole, session: AgentSession, text: string, promptOpts?: AgentPromptOpts): Promise<{ output: string }> {
    if (promptOpts?.isRepair) return session.prompt(text, promptOpts);
    const round = this.rounds.get(role) ?? 0;
    this.rounds.set(role, round + 1);
    return session.prompt(text, { ...promptOpts, round });
  }
}
