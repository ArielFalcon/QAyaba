/* Who the agent is (role) and which provider+model serves it. Kernel-resident so AgentRuntimePort does not forward-depend on the agent-runtime context. The contract AgentRoleSchema is a narrower wire subset, not this runtime union. */

export type AgentRole =
  | "primary" | "reviewer" | "chat" | "worker"
  | "workerCode" | "sidekick" | "maintainer" | "reflector" | "explorer" | "proposer";

export type AgentProvider = "opencode" | "codex";

export interface RoleAssignment {
  provider: AgentProvider;
  model: string;
}

/* Reviewer, chat, reflector, explorer, and proposer never mutate the workspace. */
export interface RoleCapabilities {
  canWrite: boolean;
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["reviewer", "chat", "reflector", "explorer", "proposer"]);

export function capabilitiesForRole(role: AgentRole): RoleCapabilities {
  return { canWrite: !READ_ONLY_ROLES.has(role) };
}
