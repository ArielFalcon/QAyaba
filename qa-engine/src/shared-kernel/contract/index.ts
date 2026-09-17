/* Frozen external wire surface. events.ts and commands.ts in this directory are canonical; src/contract/* re-exports from here. Selective re-export: AgentRole/AgentProvider/RoleAssignment stay kernel-owned in agent-role.ts — re-exporting the 6-member wire AgentRole from commands.ts would silently shadow the runtime union. Analytics view DTOs belong to the analytics surface, not this barrel. */

export * from "./events";

export {
  AgentRoleSchema as ContractAgentRoleSchema,
  AgentProviderSchema,
} from "./commands";
