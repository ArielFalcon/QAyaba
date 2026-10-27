import { AGENT_PROVIDERS, assignmentForRole, modelForRole } from "./types";
import type { AgentProvider, AgentRuntimeConfig, AgentProviderHealth, AssignmentTier, DeclaredModels, RoleAssignment } from "./types";
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

/* The model of a tier no operator chose, for a role whose own agent declares none in agents/opencode.json (a role that declares one runs on it: `modelForRole`). */
const DEFAULT_MODELS: Record<AgentProvider, Record<AssignmentTier, string>> = {
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

const TIERS: readonly AssignmentTier[] = ["primary", "reviewer", "chat"];

/* Every role runs on `provider`; each tier's model comes from AGENT_<TIER>_MODEL or the provider's default, and a tier on its default is recorded as defaulted. */
export function providerConfig(provider: AgentProvider, env: Record<string, string | undefined> = activeEnvironment()): AgentRuntimeConfig {
  return {
    assignments: {
      primary: assignment(provider, "primary", env),
      reviewer: assignment(provider, "reviewer", env),
      chat: assignment(provider, "chat", env),
    },
    defaulted: TIERS.filter((tier) => !env[modelEnvKey(tier)]),
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

function assignment(provider: AgentProvider, tier: AssignmentTier, env: Record<string, string | undefined>): RoleAssignment {
  return { provider, model: env[modelEnvKey(tier)] || DEFAULT_MODELS[provider][tier] };
}

function visibleRoles(): Array<keyof AgentRuntimeConfig["assignments"]> {
  return ["primary", "reviewer", "chat"];
}
