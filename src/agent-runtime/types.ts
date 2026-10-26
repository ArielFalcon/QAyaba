import type { AgentDeps, AgentSession, AgentOpenDescriptor, AgentTurnEvent } from "../integrations/opencode-client";
import type { LiveActivity } from "../integrations/opencode-client";
import type { UsageSnapshot } from "../qa/usage";
import type { RunEventBody } from "../contract/events";

import { AGENT_ROLES, capabilitiesForRole, type AgentProvider, type AgentRole, type RoleAssignment, type RoleCapabilities } from "@kernel/agent-role";

export { AGENT_ROLES, capabilitiesForRole };
export type { AgentProvider, AgentRole, RoleAssignment, RoleCapabilities };

/* Every runtime the host knows, in the order its status is reported. */
export const AGENT_PROVIDERS: readonly AgentProvider[] = ["opencode"];
export interface AgentRuntimeConfig {
  assignments: {
    primary: RoleAssignment;
    reviewer: RoleAssignment;
    chat: RoleAssignment;
  };
}

export type AgentRuntimeStatus = "stopped" | "starting" | "healthy" | "degraded" | "failed" | "needs_config";

export interface AgentProviderHealth {
  provider: AgentProvider;
  status: AgentRuntimeStatus;
  configured: boolean;
  error?: string;
}

export interface AgentModelInfo {
  id: string;
  label?: string;
  provider?: AgentProvider;
}

export interface AgentRuntimeSession extends AgentSession {}

/* The step limit each role runs under, in steps per prompt turn. A role the runtime enforces no limit for is absent: nothing is defaulted. */
export type StepLimits = Partial<Record<AgentRole, number>>;

/* The context window, in tokens, of each model a runtime serves, keyed by the provider/model reference a role is assigned. */
export type ModelWindows = Readonly<Record<string, number>>;

export interface AgentRuntimeStrategy {
  provider: AgentProvider;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  /**
   * The step limit the runtime enforces for each role it runs, read live for `directory` (the runtime's own
   * configuration, merged with the directory's). Optional: a runtime that enforces no limit it can report
   * makes no statement, and its roles are absent.
   */
  stepLimits?(directory: string): Promise<StepLimits>;
  /** The context window of every model the runtime serves for `directory`, read live. Optional: a runtime that reports none makes no statement. A read that fails throws. */
  modelWindows?(directory: string): Promise<ModelWindows>;
  /** Usage is observation-only (never a verdict input). Each prompt emits an AgentTurnEvent so agent_turns persist with a real run_id. */
  openSession(
    role: AgentRole,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      onUsage?: (u: UsageSnapshot) => void;
      descriptor?: AgentOpenDescriptor;
      onTurn?: (t: AgentTurnEvent) => void;
    },
  ): Promise<AgentRuntimeSession>;
  startEventStream?(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
  restart?(opts?: { apiKey?: string; reason?: string; env?: Record<string, string> }): Promise<AgentProviderHealth>;
  dispose?(): void | Promise<void>;
}

export interface AgentFacadeDeps extends AgentDeps {}

export interface AgentFacade {
  config: AgentRuntimeConfig;
  deps(): AgentFacadeDeps;
  getStatus(): Promise<{ providers: AgentProviderHealth[] }>;
  listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
  /** The step limit each role runs under, from the provider the role is assigned to; a role whose provider reports none is absent. */
  stepLimits(directory: string): Promise<StepLimits>;
  /** The context window of every model the providers in use report; optional so a host without a live runtime states none. A read that fails throws. */
  modelWindows?(directory: string): Promise<ModelWindows>;
  startEventStream?(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void>;
}

/*
 * The one role -> agent-name table. An agent name is the key of `agent` in agents/opencode.json and
 * the stem of agents/agent/<name>.md. Every forward lookup and the reverse lookup read from here, so
 * a role cannot compile without a name and a name always resolves back to its own role.
 */
export const AGENT_NAME_FOR_ROLE: Readonly<Record<AgentRole, string>> = {
  primary: "qa-generator",
  lead: "qa-lead",
  reviewer: "qa-reviewer",
  chat: "qa-assistant",
  sidekick: "qa-sidekick",
  maintainer: "qa-maintainer",
  reflector: "qa-reflector",
  proposer: "qa-proposer",
};

const ROLE_FOR_AGENT_NAME: ReadonlyMap<string, AgentRole> = new Map(
  (Object.entries(AGENT_NAME_FOR_ROLE) as Array<[AgentRole, string]>).map(([role, name]) => [name, role]),
);

/* An agent name no role maps to is a wiring error; running it under another role would hand it that role's tools and prompt. */
export function roleForAgentName(agent: string): AgentRole {
  const role = ROLE_FOR_AGENT_NAME.get(agent);
  if (role === undefined) {
    throw new Error(`Unknown agent "${agent}": no role maps to it (known agents: ${[...ROLE_FOR_AGENT_NAME.keys()].join(", ")})`);
  }
  return role;
}

export function assignmentForRole(config: AgentRuntimeConfig, role: AgentRole): RoleAssignment {
  if (role === "reviewer") return config.assignments.reviewer;
  if (role === "chat") return config.assignments.chat;
  /* Reflector is a cheap read-only transform: it rides the chat tier, not the primary author. */
  if (role === "reflector") return config.assignments.chat;
  /* Workers and maintainer inherit the primary provider/model. */
  return config.assignments.primary;
}
