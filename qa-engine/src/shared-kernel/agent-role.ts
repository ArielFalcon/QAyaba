/* Who the agent is (role) and which provider+model serves it. Kernel-resident so AgentRuntimePort does not forward-depend on the agent-runtime context. */

export const AGENT_ROLES = ["primary", "reviewer", "chat", "sidekick", "maintainer", "reflector", "proposer"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/* The runtimes an agent can run on. Add a member here and a strategy in src/agent-runtime to add a runtime. */
export type AgentProvider = "opencode";

export interface RoleAssignment {
  provider: AgentProvider;
  model: string;
}

/* Reviewer, chat, reflector, and proposer never mutate the workspace. */
export interface RoleCapabilities {
  canWrite: boolean;
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["reviewer", "chat", "reflector", "proposer"]);

export function capabilitiesForRole(role: AgentRole): RoleCapabilities {
  return { canWrite: !READ_ONLY_ROLES.has(role) };
}
