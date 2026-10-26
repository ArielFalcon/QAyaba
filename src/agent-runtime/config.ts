import { AGENT_PROVIDERS } from "./types";
import type { AgentProvider, AgentRuntimeConfig, AgentProviderHealth, RoleAssignment } from "./types";
import { activeEnvironment } from "../settings/active";

export type KeyPresence = Record<AgentProvider, boolean>;

export interface AgentConfigValidation {
  ok: boolean;
  errors: string[];
  /* Findings that leave the config usable: surfaced to operators, never a reason to refuse it. */
  warnings: string[];
}

export interface PublicAgentConfig {
  assignments: AgentRuntimeConfig["assignments"];
  keys: KeyPresence;
  validation: AgentConfigValidation;
  health?: Record<AgentProvider, AgentProviderHealth>;
}

const DEFAULT_MODELS: Record<AgentProvider, Record<keyof AgentRuntimeConfig["assignments"], string>> = {
  opencode: {
    /* Must match agents/opencode.json qa-author. */
    primary: "opencode-go/deepseek-v4.1-flash",
    /* Must match qa-reviewer. It may equal primary: whether the review is an independent judgment is
       recorded on every run (reviewerIndependence) and warned about at boot, not enforced. */
    reviewer: "opencode-go/minimax-m3.1-flash",
    chat: "opencode-go/glm-5.3-flash",
  },
};

const KEY_NAME: Record<AgentProvider, string> = { opencode: "OPENCODE_API_KEY" };

/* Every role runs on `provider`; each model comes from AGENT_<ROLE>_MODEL or the provider's default. */
export function providerConfig(provider: AgentProvider, env: Record<string, string | undefined> = activeEnvironment()): AgentRuntimeConfig {
  return {
    assignments: {
      primary: assignment(provider, "primary", env),
      reviewer: assignment(provider, "reviewer", env),
      chat: assignment(provider, "chat", env),
    },
  };
}

export function configFromEnv(env: Record<string, string | undefined> = activeEnvironment()): AgentRuntimeConfig {
  return providerConfig("opencode", env);
}

/* Variables that selected a runtime mode or a provider per role; one runtime remains, so a set one is
   reported instead of being silently ignored. */
const RETIRED_RUNTIME_SELECTORS = [
  "AGENT_RUNTIME_MODE",
  "AGENT_SINGLE_PROVIDER",
  "AGENT_PRIMARY_PROVIDER",
  "AGENT_REVIEWER_PROVIDER",
  "AGENT_CHAT_PROVIDER",
] as const;

export function retiredSelectorWarnings(env: Record<string, string | undefined> = activeEnvironment()): string[] {
  return RETIRED_RUNTIME_SELECTORS.filter((name) => env[name] !== undefined && env[name] !== "").map(
    (name) => `${name} is set but no longer read: every role runs on the one agent runtime; remove it from the environment`,
  );
}

export function keyPresence(env: Record<string, string | undefined> = activeEnvironment()): KeyPresence {
  return { opencode: Boolean(env.OPENCODE_API_KEY) };
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
  const inUse = AGENT_PROVIDERS.filter((provider) => visibleRoles().some((role) => config.assignments[role].provider === provider));
  for (const provider of inUse) {
    if (!keys[provider]) errors.push(`${KEY_NAME[provider]} is required for ${provider}`);
  }
  for (const role of visibleRoles()) {
    if (!config.assignments[role].model.trim()) errors.push(`${role} model is required`);
  }
  return { ok: errors.length === 0, errors, warnings: reviewerSharesModelWarnings(config) };
}

export function publicAgentConfig(
  config: AgentRuntimeConfig,
  keys: KeyPresence,
  health?: Record<AgentProvider, AgentProviderHealth>,
): PublicAgentConfig {
  return {
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

function visibleRoles(): Array<keyof AgentRuntimeConfig["assignments"]> {
  return ["primary", "reviewer", "chat"];
}
