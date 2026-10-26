/*
 * Holds every agent turn of a run to the run's deadline. A decorator over the agent runtime, so no
 * caller (generation, review, a sidekick) can spend time the run no longer has: a turn is
 * refused when none is left, and otherwise runs under the smaller of its own limit and what is left.
 * Only the turn the deadline itself ended is reported as the run's deadline; a turn that hit a limit of
 * its own keeps the error its caller already knows how to read.
 */
import type { AgentPromptOpts, AgentRuntimePort, AgentSession, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { isAgentTimeoutError } from "@kernel/domain-error.ts";
import { RunDeadlineExceededError, type RunDeadlineStop, type RunDeadlineView } from "@kernel/run-deadline.ts";

export interface RunDeadlineRuntimeOptions {
  /** The longest the host lets a prompt with no limit of its own run: when that is shorter than the time left, the host's deadline is what ends such a turn, not the run's. Absent: the host states none. */
  hostPromptCapMs?: number;
}

export class RunDeadlineRuntime implements AgentRuntimePort {
  constructor(
    private readonly inner: AgentRuntimePort,
    private readonly deadline: RunDeadlineView,
    private readonly options: RunDeadlineRuntimeOptions = {},
  ) {}

  private spent(role: AgentRole, stop: RunDeadlineStop, cause?: unknown): RunDeadlineExceededError {
    const armed = this.deadline.describe();
    return new RunDeadlineExceededError(armed?.budgetMs ?? 0, armed?.label ?? "unarmed", role, stop, cause !== undefined ? { cause } : undefined);
  }

  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    const left = this.deadline.remainingMs();
    if (left !== undefined && left <= 0) throw this.spent(role, "before-turn");
    const session = await this.inner.openSession(role, cwd, opts);
    return {
      prompt: (text, promptOpts) => this.prompt(role, session, opts?.timeoutMs, text, promptOpts),
      dispose: () => session.dispose(),
    };
  }

  private async prompt(role: AgentRole, session: AgentSession, sessionTimeoutMs: number | undefined, text: string, promptOpts?: AgentPromptOpts): Promise<{ output: string }> {
    const left = this.deadline.remainingMs();
    if (left === undefined) return session.prompt(text, promptOpts);
    if (left <= 0) throw this.spent(role, "before-turn");
    const own = promptOpts?.timeoutMs ?? sessionTimeoutMs ?? this.options.hostPromptCapMs;
    /* The deadline is what ends the turn only when it comes no later than the turn's own limit. */
    const deadlineBinds = own === undefined || left <= own;
    try {
      return await session.prompt(text, { ...promptOpts, timeoutMs: deadlineBinds ? left : own, ...(deadlineBinds ? { timeLimit: "run-deadline" as const } : {}) });
    } catch (err) {
      if (deadlineBinds && isAgentTimeoutError(err)) throw this.spent(role, "mid-turn", err);
      throw err;
    }
  }
}
