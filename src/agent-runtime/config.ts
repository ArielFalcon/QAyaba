import { AGENT_NAME_FOR_ROLE, AGENT_PROVIDERS, assignmentForRole, modelForRole } from "./types";
import type { AgentProvider, AgentRole, AgentRuntimeConfig, AgentProviderHealth, AssignmentTier, DeclaredModels, RoleAssignment } from "./types";
import { declaredAgentModel } from "./declared-model";
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

/* The role whose agent in agents/opencode.json supplies a tier's model when no operator chose one. */
const TIER_ROLE: Record<AssignmentTier, AgentRole> = { primary: "author", reviewer: "reviewer", chat: "chat" };

const KEY_NAME: Record<AgentProvider, string> = { opencode: "OPENCODE_API_KEY" };

const TIERS: readonly AssignmentTier[] = ["primary", "reviewer", "chat"];

/* Every role runs on `provider`; each tier's model comes from AGENT_<TIER>_MODEL or the model its agent declares in agents/opencode.json, and a tier on the declared model is recorded as defaulted. */
export function providerConfig(
  provider: AgentProvider,
  env: Record<string, string | undefined> = activeEnvironment(),
  declared: DeclaredModels = declaredAgentModel,
): AgentRuntimeConfig {
  return {
    assignments: {
      primary: assignment(provider, "primary", env, declared),
      reviewer: assignment(provider, "reviewer", env, declared),
      chat: assignment(provider, "chat", env, declared),
    },
    defaulted: TIERS.filter((tier) => !env[modelEnvKey(tier)]),
  };
}

export function configFromEnv(env: Record<string, string | undefined> = activeEnvironment()): AgentRuntimeConfig {
  return providerConfig("opencode", env);
}

export function keyPresence(env: Record<string, string | undefined> = activeEnvironment()): KeyPresence {
  return { opencode: Boolean(env.OPENCODE_API_KEY) };
}

export type ReviewerIndependence = "shared-model" | "distinct-model";

/* The single derivation of whether the reviewer judges with the generator's own model: the models the author and the reviewer run on, not the tiers' defaults. */
export function reviewerIndependence(config: AgentRuntimeConfig, declared: DeclaredModels = declaredAgentModel): ReviewerIndependence {
  const sameProvider = assignmentForRole(config, "reviewer").provider === assignmentForRole(config, "author").provider;
  return sameProvider && modelForRole(config, "reviewer", declared) === modelForRole(config, "author", declared) ? "shared-model" : "distinct-model";
}

function reviewerSharesModelWarnings(config: AgentRuntimeConfig): string[] {
  if (reviewerIndependence(config) === "distinct-model") return [];
  const generator = assignmentForRole(config, "author");
  const reviewer = assignmentForRole(config, "reviewer");
  return [
    `reviewer (${reviewer.provider}/${modelForRole(config, "reviewer", declaredAgentModel)}) runs the same model as primary ` +
      `(${generator.provider}/${modelForRole(config, "author", declaredAgentModel)}): the review is not an independent judgment`,
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

function modelEnvKey(tier: AssignmentTier): string {
  return `AGENT_${tier.toUpperCase()}_MODEL`;
}

function assignment(provider: AgentProvider, tier: AssignmentTier, env: Record<string, string | undefined>, declared: DeclaredModels): RoleAssignment {
  return { provider, model: env[modelEnvKey(tier)] || declared(AGENT_NAME_FOR_ROLE[TIER_ROLE[tier]]) || "" };
}

function visibleRoles(): Array<keyof AgentRuntimeConfig["assignments"]> {
  return ["primary", "reviewer", "chat"];
}
