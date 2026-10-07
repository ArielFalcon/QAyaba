import type { AgentDeps, AgentSession } from "../integrations/opencode-client";
import type { LiveActivity } from "../integrations/opencode-client";
import type { RunEventBody } from "../contract/events";
import {
  AGENT_ROLES,
  AgentFacade,
  AgentModelInfo,
  AgentProvider,
  AgentProviderHealth,
  AgentRuntimeConfig,
  AgentRuntimeStrategy,
  StepLimits,
  assignmentForRole,
  roleForLegacyAgent,
} from "./types";

export class SingleAgentFacade implements AgentFacade {
  constructor(
    private readonly strategy: AgentRuntimeStrategy,
    readonly config: AgentRuntimeConfig,
  ) {}

  deps(): AgentDeps {
    const deps: AgentDeps = {
      open: async (agent, cwd, opts) => {
        const role = roleForLegacyAgent(agent);
        /* A model the caller asked for wins; the role's assignment only supplies the default. */
        const model = opts?.model ?? assignmentForRole(this.config, role).model;
        const session: AgentSession = await this.strategy.openSession(role, cwd, { ...opts, model });
        /* Codex is exec-per-prompt (self-timed, no SSE) so the stall watchdog skips it. */
        if (this.strategy.provider === "codex") session.selfTimed = true;
        return session;
      },
    };
    if (this.strategy.cleanupOrphans) deps.cleanupOrphans = (maxAgeMs) => this.strategy.cleanupOrphans!(maxAgeMs);
    return deps;
  }

  async getStatus(): Promise<{ mode: "single"; providers: AgentProviderHealth[] }> {
    return { mode: "single", providers: [await this.strategy.health()] };
  }

  async listModels(provider?: AgentProvider): Promise<AgentModelInfo[]> {
    if (provider && provider !== this.strategy.provider) return [];
    return (await this.strategy.listModels()).map((m) => ({ ...m, provider: this.strategy.provider }));
  }

  /* Every role runs on the one strategy; a strategy that reports no limit makes no statement. */
  async stepLimits(directory: string): Promise<StepLimits> {
    return (await this.strategy.stepLimits?.(directory)) ?? {};
  }

  startEventStream(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    return this.strategy.startEventStream?.(onActivity, signal, onRunEvent) ?? Promise.resolve();
  }
}

export class DualAgentFacade implements AgentFacade {
  constructor(
    private readonly strategies: Record<AgentProvider, AgentRuntimeStrategy>,
    readonly config: AgentRuntimeConfig,
  ) {}

  deps(): AgentDeps {
    return {
      open: async (agent, cwd, opts) => {
        const role = roleForLegacyAgent(agent);
        const assignment = assignmentForRole(this.config, role);
        /* The assignment picks the provider; a model the caller asked for wins over the assignment's default. */
        const session: AgentSession = await this.strategies[assignment.provider].openSession(role, cwd, { ...opts, model: opts?.model ?? assignment.model });
        /* Codex is exec-per-prompt (self-timed, no SSE) so the stall watchdog skips it. */
        if (assignment.provider === "codex") session.selfTimed = true;
        return session;
      },
      cleanupOrphans: async (maxAgeMs) => {
        const counts = await Promise.all(
          Object.values(this.strategies).map((strategy) => strategy.cleanupOrphans?.(maxAgeMs) ?? Promise.resolve(0)),
        );
        return counts.reduce((sum, count) => sum + count, 0);
      },
    };
  }

  async getStatus(): Promise<{ mode: "dual"; providers: AgentProviderHealth[] }> {
    return { mode: "dual", providers: await Promise.all([this.strategies.opencode.health(), this.strategies.codex.health()]) };
  }

  async listModels(provider?: AgentProvider): Promise<AgentModelInfo[]> {
    const providers: AgentProvider[] = provider ? [provider] : ["opencode", "codex"];
    const lists = await Promise.all(providers.map(async (p) => (await this.strategies[p].listModels()).map((m) => ({ ...m, provider: p }))));
    return lists.flat();
  }

  /*
   * A role takes its limit from the provider it is assigned to, never from another provider that also reports
   * one for it. Each provider that runs a role is read once, however many roles it runs; one that runs none is
   * not read; one that reports no limit leaves its roles absent.
   */
  async stepLimits(directory: string): Promise<StepLimits> {
    const providers: AgentProvider[] = ["opencode", "codex"];
    const limits: StepLimits = {};
    await Promise.all(
      providers.map(async (provider) => {
        const runs = new Set<string>(AGENT_ROLES.filter((role) => assignmentForRole(this.config, role).provider === provider));
        if (runs.size === 0) return;
        const enforced = (await this.strategies[provider].stepLimits?.(directory)) ?? {};
        Object.assign(limits, Object.fromEntries(Object.entries(enforced).filter(([role]) => runs.has(role))));
      }),
    );
    return limits;
  }

  async startEventStream(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    await Promise.all([
      this.strategies.opencode.startEventStream?.(onActivity, signal, onRunEvent) ?? Promise.resolve(),
      this.strategies.codex.startEventStream?.(onActivity, signal, onRunEvent) ?? Promise.resolve(),
    ]);
  }
}
