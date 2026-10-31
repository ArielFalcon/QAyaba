/*
 * Holds every agent turn of a run to the time its purpose is allotted. A decorator over the agent runtime, so no
 * caller (generation, review, a sidekick) can spend time the run no longer has or time a later phase is owed: a turn is
 * refused when none is allotted, and otherwise runs under the smaller of its own limit and its allotment. The two ends are typed
 * apart: a turn the run's own deadline ended is `RunDeadlineExceededError` (the run ends), a turn that reached the end of its
 * purpose's share while the run still has time is `AllotmentSpentError` (a timeout of that turn alone, which its owner follows its
 * own path for), and a turn that hit a limit of its own keeps the error its caller already knows how to read.
 */
import type { AgentPromptOpts, AgentRuntimePort, AgentSession, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { isAgentTimeoutError } from "@kernel/domain-error.ts";
import type { DeadlinePurpose } from "@kernel/deadline-purpose.ts";
import { AllotmentSpentError, RunDeadlineExceededError, type RunDeadlineStop, type RunDeadlineView } from "@kernel/run-deadline.ts";

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

  /* The run's own time is spent. */
  private runSpent(role: AgentRole, stop: RunDeadlineStop, purpose: DeadlinePurpose, cause?: unknown): RunDeadlineExceededError {
    const armed = this.deadline.describe();
    return new RunDeadlineExceededError(armed?.budgetMs ?? 0, armed?.label ?? "unarmed", role, stop, { ...(cause !== undefined ? { cause } : {}), purpose });
  }

  /* What a turn that finds no time may do: the run is spent (it ends), or only the purpose's share is (that turn ends as a timeout). */
  private refuse(role: AgentRole, purpose: DeadlinePurpose): Error {
    const left = this.deadline.remainingMs();
    return left !== undefined && left <= 0 ? this.runSpent(role, "before-turn", purpose) : new AllotmentSpentError(role, purpose, "before-turn");
  }

  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    const purpose = this.deadline.currentPurpose();
    const left = this.deadline.allowance(purpose);
    if (left !== null && left <= 0) throw this.refuse(role, purpose);
    const session = await this.inner.openSession(role, cwd, opts);
    return {
      prompt: (text, promptOpts) => this.prompt(role, session, opts?.timeoutMs, text, promptOpts),
      dispose: () => session.dispose(),
    };
  }

  private async prompt(role: AgentRole, session: AgentSession, sessionTimeoutMs: number | undefined, text: string, promptOpts?: AgentPromptOpts): Promise<{ output: string }> {
    /* What the run's current purpose may still spend: the time left less what the phases after it are owed. */
    const purpose = this.deadline.currentPurpose();
    const left = this.deadline.allowance(purpose);
    if (left === null) return session.prompt(text, promptOpts);
    if (left <= 0) throw this.refuse(role, purpose);
    const own = promptOpts?.timeoutMs ?? sessionTimeoutMs ?? this.options.hostPromptCapMs;
    /* The allotment is what ends the turn only when it comes no later than the turn's own limit. */
    const allotmentBinds = own === undefined || left <= own;
    /* It is the run's deadline when nothing is held back for later (the allotment is all that is left of the run), else the purpose's share. */
    const remaining = this.deadline.remainingMs();
    const limit = remaining !== undefined && left >= remaining ? ("run-deadline" as const) : ("allotment" as const);
    try {
      return await session.prompt(text, { ...promptOpts, timeoutMs: allotmentBinds ? left : own, ...(allotmentBinds ? { timeLimit: limit } : {}) });
    } catch (err) {
      if (allotmentBinds && isAgentTimeoutError(err)) {
        /* Typed by what is left now: the run's time is spent, or only the purpose's share is. A turn that hit its own limit is neither and passes through. */
        const spent = this.deadline.remainingMs();
        if (spent !== undefined && spent <= 0) throw this.runSpent(role, "mid-turn", purpose, err);
        throw new AllotmentSpentError(role, purpose, "mid-turn", { cause: err });
      }
      throw err;
    }
  }
}
