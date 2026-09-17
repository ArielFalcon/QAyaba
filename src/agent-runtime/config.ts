import type { AgentMode, AgentProvider, AgentRuntimeConfig, AgentProviderHealth, RoleAssignment } from "./types";

export interface KeyPresence {
  opencode: boolean;
  codex: boolean;
}

export interface AgentConfigValidation {
  ok: boolean;
  errors: string[];
  requiresSingleDowngradeConfirmation?: boolean;
  downgradeProvider?: AgentProvider;
}

export interface PublicAgentConfig {
  mode: AgentMode;
  singleProvider: AgentProvider;
  assignments: AgentRuntimeConfig["assignments"];
  keys: KeyPresence;
  validation: AgentConfigValidation;
  health?: Record<AgentProvider, AgentProviderHealth>;
}

const DEFAULT_MODELS: Record<AgentProvider, Record<keyof AgentRuntimeConfig["assignments"], string>> = {
  opencode: {
    /* Must match agents/opencode.json qa-generator. */
    primary: "opencode-go/glm-5.3-flash",
    /* Must match qa-reviewer and differ from primary — two models guarantee independent judgment. */
    reviewer: "opencode-go/muse-spark-1.3-contributor",
    chat: "opencode-go/glm-5.3-flash",
  },
  codex: {
    primary: "gpt-5.4",
    /* Must differ from primary — two models guarantee independent judgment. */
    reviewer: "gpt-5.5",
    chat: "gpt-5.4-mini",
  },
};

export function defaultAgentRuntimeConfig(env: Record<string, string | undefined> = process.env): AgentRuntimeConfig {
  const singleProvider: AgentProvider = env.OPENCODE_API_KEY ? "opencode" : env.CODEX_API_KEY ? "codex" : "opencode";
  return singleProviderConfig(singleProvider, env);
}

export function singleProviderConfig(provider: AgentProvider, env: Record<string, string | undefined> = process.env): AgentRuntimeConfig {
  return {
    mode: "single",
    singleProvider: provider,
    assignments: {
      primary: assignment(provider, "primary", env),
      reviewer: assignment(provider, "reviewer", env),
      chat: assignment(provider, "chat", env),
    },
  };
}

function complementProvider(p: AgentProvider): AgentProvider {
  return p === "opencode" ? "codex" : "opencode";
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): AgentRuntimeConfig {
  const mode = env.AGENT_RUNTIME_MODE === "dual" ? "dual" : "single";
  const singleProvider = env.AGENT_SINGLE_PROVIDER === "codex" ? "codex" : env.AGENT_SINGLE_PROVIDER === "opencode" ? "opencode" : defaultAgentRuntimeConfig(env).singleProvider;
  if (mode === "single") return singleProviderConfig(singleProvider, env);
  const primaryProvider = providerFromEnv(env.AGENT_PRIMARY_PROVIDER, singleProvider);
  return {
    mode,
    singleProvider,
    assignments: {
      primary: assignment(primaryProvider, "primary", env),
      /* Dual mode exists for independent judgment: reviewer defaults to the other provider. */
      reviewer: assignment(providerFromEnv(env.AGENT_REVIEWER_PROVIDER, complementProvider(primaryProvider)), "reviewer", env),
      chat: assignment(providerFromEnv(env.AGENT_CHAT_PROVIDER, singleProvider), "chat", env),
    },
  };
}

export function keyPresence(env: Record<string, string | undefined> = process.env): KeyPresence {
  return { opencode: Boolean(env.OPENCODE_API_KEY), codex: Boolean(env.CODEX_API_KEY) };
}

/* Boot and live-reconfiguration share this mapping so role→model cannot split. */
export function runtimeRoleModelsFromConfig(config: AgentRuntimeConfig): { primary: string; reviewer: string; chat: string } {
  return {
    primary: config.assignments.primary.model,
    reviewer: config.assignments.reviewer.model,
    chat: config.assignments.chat.model,
  };
}

/* reviewer.model must never equal primary.model — env overrides can still collapse both roles. */
function reviewerPrimaryCollisionErrors(config: AgentRuntimeConfig): string[] {
  const primary = config.assignments.primary;
  const reviewer = config.assignments.reviewer;
  if (reviewer.model === primary.model) {
    return [
      `reviewer (${reviewer.provider}/${reviewer.model}) must run a different model from primary ` +
        `(${primary.provider}/${primary.model}) — identical models defeat independent judgment`,
    ];
  }
  return [];
}

export function validateAgentRuntimeConfig(config: AgentRuntimeConfig, keys: KeyPresence): AgentConfigValidation {
  const errors: string[] = [];
  if (config.mode === "single") {
    if (!keys[config.singleProvider]) errors.push(`${keyName(config.singleProvider)} is required for single/${config.singleProvider}`);
    for (const role of visibleRoles()) {
      const a = config.assignments[role];
      if (a.provider !== config.singleProvider) errors.push(`${role} must use ${config.singleProvider} in single mode`);
      if (!a.model.trim()) errors.push(`${role} model is required`);
    }
    errors.push(...reviewerPrimaryCollisionErrors(config));
    return { ok: errors.length === 0, errors };
  }

  if (!keys.opencode) errors.push("OPENCODE_API_KEY is required for dual mode");
  if (!keys.codex) errors.push("CODEX_API_KEY is required for dual mode");
  for (const role of visibleRoles()) {
    const a = config.assignments[role];
    if (!a.model.trim()) errors.push(`${role} model is required`);
  }
  errors.push(...reviewerPrimaryCollisionErrors(config));
  const providers = new Set(visibleRoles().map((r) => config.assignments[r].provider));
  if (providers.size < 2) {
    const downgradeProvider = [...providers][0] ?? config.singleProvider;
    return {
      ok: false,
      errors,
      requiresSingleDowngradeConfirmation: true,
      downgradeProvider,
    };
  }
  return { ok: errors.length === 0, errors };
}

export function publicAgentConfig(
  config: AgentRuntimeConfig,
  keys: KeyPresence,
  health?: Record<AgentProvider, AgentProviderHealth>,
): PublicAgentConfig {
  return {
    mode: config.mode,
    singleProvider: config.singleProvider,
    assignments: config.assignments,
    keys,
    validation: validateAgentRuntimeConfig(config, keys),
    ...(health ? { health } : {}),
  };
}

function assignment(provider: AgentProvider, role: keyof AgentRuntimeConfig["assignments"], env: Record<string, string | undefined>): RoleAssignment {
  const envKey = `AGENT_${role.toUpperCase()}_MODEL`;
  return { provider, model: env[envKey] || DEFAULT_MODELS[provider][role] };
}

function providerFromEnv(raw: string | undefined, fallback: AgentProvider): AgentProvider {
  return raw === "codex" || raw === "opencode" ? raw : fallback;
}

function keyName(provider: AgentProvider): string {
  return provider === "opencode" ? "OPENCODE_API_KEY" : "CODEX_API_KEY";
}

function visibleRoles(): Array<keyof AgentRuntimeConfig["assignments"]> {
  return ["primary", "reviewer", "chat"];
}
