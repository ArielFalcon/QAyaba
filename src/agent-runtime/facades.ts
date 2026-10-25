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
  ModelWindows,
  StepLimits,
  assignmentForRole,
  roleForAgentName,
} from "./types";

/*
 * The one facade over the agent runtimes: every role is opened on the strategy its assignment names. The host runs
 * one runtime today; a second one is added by a member of AgentProvider and a strategy for it.
 */
export class AgentRuntimeFacade implements AgentFacade {
  constructor(
    private readonly strategies: Record<AgentProvider, AgentRuntimeStrategy>,
    readonly config: AgentRuntimeConfig,
  ) {}

  /* The runtimes this facade was given a strategy for. */
  private providers(): AgentProvider[] {
    return Object.keys(this.strategies) as AgentProvider[];
  }

  deps(): AgentDeps {
    return {
      open: async (agent, cwd, opts) => {
        const role = roleForAgentName(agent);
        const assignment = assignmentForRole(this.config, role);
        /* The assignment picks the provider; a model the caller asked for wins over the assignment's default. */
        const session: AgentSession = await this.strategies[assignment.provider].openSession(role, cwd, { ...opts, model: opts?.model ?? assignment.model });
        return session;
      },
      cleanupOrphans: async (maxAgeMs) => {
        const counts = await Promise.all(
          this.providers().map((provider) => this.strategies[provider].cleanupOrphans?.(maxAgeMs) ?? Promise.resolve(0)),
        );
        return counts.reduce((sum, count) => sum + count, 0);
      },
    };
  }

  async getStatus(): Promise<{ providers: AgentProviderHealth[] }> {
    return { providers: await Promise.all(this.providers().map((provider) => this.strategies[provider].health())) };
  }

  async listModels(provider?: AgentProvider): Promise<AgentModelInfo[]> {
    const providers = provider ? [provider] : this.providers();
    const lists = await Promise.all(providers.map(async (p) => (await this.strategies[p].listModels()).map((m) => ({ ...m, provider: p }))));
    return lists.flat();
  }

  /* mutation-scope:begin facade-step-limits */
  /*
   * A role takes its limit from the provider it is assigned to, never from another provider that also reports
   * one for it. Each provider that runs a role is read once, however many roles it runs; one that runs none is
   * not read; one that reports no limit leaves its roles absent.
   */
  async stepLimits(directory: string): Promise<StepLimits> {
    const limits: StepLimits = {};
    await Promise.all(
      this.providers().map(async (provider) => {
        const runs = new Set<string>(AGENT_ROLES.filter((role) => assignmentForRole(this.config, role).provider === provider));
        if (runs.size === 0) return;
        const enforced = (await this.strategies[provider].stepLimits?.(directory)) ?? {};
  /* mutation-scope:end facade-step-limits */
        Object.assign(limits, Object.fromEntries(Object.entries(enforced).filter(([role]) => runs.has(role))));
      }),
    );
    return limits;
  }

  /* Each provider that runs a role reports the windows of the models it serves; one that runs none is not read. */
  async modelWindows(directory: string): Promise<ModelWindows> {
    const providers = this.providers().filter((provider) => AGENT_ROLES.some((role) => assignmentForRole(this.config, role).provider === provider));
    const reported = await Promise.all(providers.map(async (provider) => (await this.strategies[provider].modelWindows?.(directory)) ?? {}));
    return Object.assign({}, ...reported);
  }

  async startEventStream(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    await Promise.all(this.providers().map((provider) => this.strategies[provider].startEventStream?.(onActivity, signal, onRunEvent) ?? Promise.resolve()));
  }
}
