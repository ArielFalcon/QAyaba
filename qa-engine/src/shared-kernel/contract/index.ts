/* Frozen external wire surface. events.ts and commands.ts in this directory are canonical; src/contract/* re-exports from here. Selective re-export: AgentRole/AgentProvider/RoleAssignment stay kernel-owned in agent-role.ts. Analytics view DTOs belong to the analytics surface, not this barrel. */

export * from "./events";

export { AgentProviderSchema } from "./commands";
