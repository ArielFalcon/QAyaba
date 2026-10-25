import { defaultEnvStoreFs, applyEnvVars, type EnvStoreFs } from "./env-store";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import {
  configFromEnv,
  keyPresence,
  publicAgentConfig,
  runtimeRoleModelsFromConfig,
  validateAgentRuntimeConfig,
  type PublicAgentConfig,
} from "../agent-runtime/config";
import { setRuntimeRoleModels } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { AgentRuntimeFacade } from "../agent-runtime/facades";
import { AGENT_PROVIDERS } from "../agent-runtime/types";
import type {
  AgentFacade,
  AgentProvider,
  AgentProviderHealth,
  AgentRuntimeConfig,
  AgentRuntimeStrategy,
  RoleAssignment,
} from "../agent-runtime/types";
import type { AgentConfigUpdate, AgentModelInfo } from "../contract/commands";

export interface AgentRuntimeManager {
  getConfig(): Promise<PublicAgentConfig>;
  applyConfig(input: AgentConfigUpdate): Promise<{ config: PublicAgentConfig; restarted: AgentProvider[] }>;
  listModels(provider: AgentProvider): Promise<AgentModelInfo[]>;
  restart(provider: AgentProvider): Promise<AgentProviderHealth>;
  facade(): AgentFacade;
  hasOpenSessions(): boolean;
  /* The live role assignments, read now. */
  current(): AgentRuntimeConfig;
}

export interface CreateAgentRuntimeManagerOptions {
  env?: Record<string, string | undefined>;
  fs?: EnvStoreFs;
  strategies: Record<AgentProvider, AgentRuntimeStrategy>;
  hasOpenSessions?: () => boolean;
}

const PROVIDERS = AGENT_PROVIDERS;
const ROLES: Array<keyof AgentRuntimeConfig["assignments"]> = ["primary", "reviewer", "chat"];


const redactionPort = new RedactionPortAdapter();

export function createAgentRuntimeManager(opts: CreateAgentRuntimeManagerOptions): AgentRuntimeManager {
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? defaultEnvStoreFs();
  let config = configFromEnv(env);

  async function health(): Promise<Record<AgentProvider, AgentProviderHealth>> {
    const keys = keyPresence(env);
    const entries = await Promise.all(PROVIDERS.map(async (provider) => {
      if (!keys[provider]) {
        return [provider, { provider, status: "needs_config", configured: false }] as const;
      }
      try {
        const h = await opts.strategies[provider].health();
        return [provider, { ...h, provider, configured: true }] as const;
      } catch (err) {
        return [provider, { provider, status: "failed", configured: true, error: redactionPort.redactError(err) }] as const;
      }
    }));
    return Object.fromEntries(entries) as Record<AgentProvider, AgentProviderHealth>;
  }

  async function currentPublicConfig(): Promise<PublicAgentConfig> {
    return publicAgentConfig(config, keyPresence(env), await health());
  }

  async function restartProvider(
    provider: AgentProvider,
    apiKey?: string,
    runtimeEnv = configEnvVars(config),
  ): Promise<AgentProviderHealth> {
    if (!keyPresence(env)[provider]) return { provider, status: "needs_config", configured: false };
    if (opts.strategies[provider].restart) {
      return opts.strategies[provider].restart({ apiKey, reason: "runtime config changed", env: runtimeEnv });
    }
    return opts.strategies[provider].health();
  }

  return {
    getConfig: currentPublicConfig,

    async applyConfig(input) {
      const previous = config;
      const nextEnv = { ...env };
      const apiKeyVars = apiKeyEnvVars(input);
      for (const [key, value] of Object.entries(apiKeyVars)) nextEnv[key] = value;

      const next = mergeConfig(previous, input);
      const validation = validateAgentRuntimeConfig(next, keyPresence(nextEnv));
      if (!validation.ok) throw new Error(validation.errors.join("; "));
      logAgentConfigWarnings(validation.warnings);
      await validateAssignedModels(next, opts.strategies);

      const runtimeVars = configEnvVars(next);
      applyEnvVars({ ...apiKeyVars, ...runtimeVars }, { fs, env });
      config = next;

      /*
       * Live reconfiguration must not split-brain: re-derive the runtime role→model map
       * from the NEW live config and re-inject it into the qa-engine catalog seam — the SAME
       * derivation the boot path (`opencode-client.ts`'s module load, via `configFromEnv()`) uses,
       * via the shared `runtimeRoleModelsFromConfig` helper. Without this, `roleWindowBytes` keeps
       * budgeting against the STALE snapshot injected at boot even after a live role→model
       * reassignment through this guarded operator path (PUT /api/agent-config).
       */
      setRuntimeRoleModels(runtimeRoleModelsFromConfig(config));


      const restarted = changedProviders(previous, next, apiKeyVars);
      await Promise.all(restarted.map((provider) => restartProvider(provider, apiKeyForProvider(input, provider), runtimeVars)));

      /*
       * Release a provider that is no longer used by any role: the supervisor stops its
       * process, but the orchestrator-side strategy still caches a live client until we
       * dispose it.
       */
      await Promise.all(
        PROVIDERS
          .filter((provider) => usedProvider(previous, provider) && !usedProvider(next, provider))
          .map((provider) => opts.strategies[provider].dispose?.()),
      );
      return { config: await currentPublicConfig(), restarted };
    },

    async listModels(provider) {
      return (await opts.strategies[provider].listModels()).map((m) => ({ ...m, provider }));
    },

    restart: restartProvider,

    facade() {
      return new AgentRuntimeFacade(opts.strategies, config);
    },

    current() {
      return config;
    },

    hasOpenSessions() {
      return opts.hasOpenSessions?.() ?? false;
    },
  };
}

/* Warnings leave the config usable: operators see them in the log and in the public config's validation. */
export function logAgentConfigWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) console.warn(`[qa] agent runtime: ${warning}`);
}

async function validateAssignedModels(
  config: AgentRuntimeConfig,
  strategies: Record<AgentProvider, AgentRuntimeStrategy>,
): Promise<void> {
  const catalogs = new Map<AgentProvider, Set<string>>();
  const errors: string[] = [];
  for (const role of ROLES) {
    const assignment = config.assignments[role];
    let models = catalogs.get(assignment.provider);
    if (!models) {
      models = new Set((await strategies[assignment.provider].listModels()).map((m) => m.id));
      catalogs.set(assignment.provider, models);
    }
    if (!models.has(assignment.model)) {
      errors.push(`${role} model '${assignment.model}' is not available for ${assignment.provider}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function mergeConfig(current: AgentRuntimeConfig, input: AgentConfigUpdate): AgentRuntimeConfig {
  return { assignments: overlayAssignments(current.assignments, input.assignments) };
}

function overlayAssignments(
  current: AgentRuntimeConfig["assignments"],
  patch?: Partial<Record<keyof AgentRuntimeConfig["assignments"], RoleAssignment>>,
): AgentRuntimeConfig["assignments"] {
  return {
    primary: patch?.primary ?? current.primary,
    reviewer: patch?.reviewer ?? current.reviewer,
    chat: patch?.chat ?? current.chat,
  };
}

function apiKeyEnvVars(input: AgentConfigUpdate): Record<string, string> {
  const vars: Record<string, string> = {};
  const open = input.apiKeys?.opencode?.trim();
  if (open) vars.OPENCODE_API_KEY = open;
  return vars;
}

function configEnvVars(config: AgentRuntimeConfig): Record<string, string> {
  return {
    AGENT_PRIMARY_MODEL: config.assignments.primary.model,
    AGENT_REVIEWER_MODEL: config.assignments.reviewer.model,
    AGENT_CHAT_MODEL: config.assignments.chat.model,
  };
}

function changedProviders(
  previous: AgentRuntimeConfig,
  next: AgentRuntimeConfig,
  apiKeyVars: Record<string, string>,
): AgentProvider[] {
  const changed = new Set<AgentProvider>();
  if (apiKeyVars.OPENCODE_API_KEY) changed.add("opencode");
  for (const provider of PROVIDERS) {
    if (usedProvider(next, provider) && JSON.stringify(assignmentsForProvider(previous, provider)) !== JSON.stringify(assignmentsForProvider(next, provider))) {
      changed.add(provider);
    }
  }
  return PROVIDERS.filter((p) => changed.has(p));
}

function assignmentsForProvider(config: AgentRuntimeConfig, provider: AgentProvider): Array<[string, RoleAssignment]> {
  return ROLES
    .filter((role) => config.assignments[role].provider === provider)
    .map((role) => [role, config.assignments[role]]);
}

function usedProvider(config: AgentRuntimeConfig, provider: AgentProvider): boolean {
  return ROLES.some((role) => config.assignments[role].provider === provider);
}

function apiKeyForProvider(input: AgentConfigUpdate, provider: AgentProvider): string | undefined {
  return input.apiKeys?.[provider];
}
