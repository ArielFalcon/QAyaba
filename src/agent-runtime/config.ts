import type { AgentMode, AgentProvider, AgentRuntimeConfig, AgentProviderHealth, RoleAssignment } from "./types";

export interface KeyPresence {
  opencode: boolean;
  codex: boolean;
}

export interface AgentConfigValidation {
  ok: boolean;
  errors: string[];
  /* Findings that leave the config usable: surfaced to operators, never a reason to refuse it. */
  warnings: string[];
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
    primary: "deepseek-api/deepseek-v4.1-flash",
    /* Must match qa-reviewer. It may equal primary: whether the review is an independent judgment is
       recorded on every run (reviewerIndependence) and warned about at boot, not enforced. */
    reviewer: "deepseek-api/deepseek-v4.1-flash",
    chat: "deepseek-api/deepseek-v4.1-flash",
  },
  codex: {
    primary: "gpt-5.4",
    /* A model distinct from primary keeps the review an independent judgment. */
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

export type ReviewerIndependence = "shared-model" | "distinct-model";

/* The single derivation of whether the reviewer judges with the generator's own model. */
export function reviewerIndependence(config: AgentRuntimeConfig): ReviewerIndependence {
  const { primary, reviewer } = config.assignments;
  return reviewer.provider === primary.provider && reviewer.model === primary.model ? "shared-model" : "distinct-model";
}

function reviewerSharesModelWarnings(config: AgentRuntimeConfig): string[] {
  if (reviewerIndependence(config) === "distinct-model") return [];
  const { primary, reviewer } = config.assignments;
  return [
    `reviewer (${reviewer.provider}/${reviewer.model}) runs the same model as primary ` +
      `(${primary.provider}/${primary.model}): the review is not an independent judgment`,
  ];
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
    return { ok: errors.length === 0, errors, warnings: reviewerSharesModelWarnings(config) };
  }

  if (!keys.opencode) errors.push("OPENCODE_API_KEY is required for dual mode");
  if (!keys.codex) errors.push("CODEX_API_KEY is required for dual mode");
  for (const role of visibleRoles()) {
    const a = config.assignments[role];
    if (!a.model.trim()) errors.push(`${role} model is required`);
  }
  const warnings = reviewerSharesModelWarnings(config);
  const providers = new Set(visibleRoles().map((r) => config.assignments[r].provider));
  if (providers.size < 2) {
    const downgradeProvider = [...providers][0] ?? config.singleProvider;
    return {
      ok: false,
      errors,
      warnings,
      requiresSingleDowngradeConfirmation: true,
      downgradeProvider,
    };
  }
  return { ok: errors.length === 0, errors, warnings };
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
