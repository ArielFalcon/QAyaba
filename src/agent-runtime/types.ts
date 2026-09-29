import { EXPLORER_AGENT_NAME } from "@contexts/generation/domain/explorer-agent";
import type { AgentDeps, AgentSession, AgentOpenDescriptor, AgentTurnEvent } from "../integrations/opencode-client";
import type { LiveActivity } from "../integrations/opencode-client";
import type { UsageSnapshot } from "../qa/usage";
import type { RunEventBody } from "../contract/events";

export type AgentProvider = "opencode" | "codex";
export type AgentMode = "single" | "dual";
export type AgentRole = "primary" | "reviewer" | "chat" | "worker" | "workerCode" | "sidekick" | "maintainer" | "reflector" | "explorer" | "proposer";

/*
 * What a role is allowed to do, independent of provider. Trust capability, not prompt behavior.
 * Reviewer, chat, reflector, explorer, and proposer never mutate the workspace.
 */
export interface RoleCapabilities {
  canWrite: boolean;
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["reviewer", "chat", "reflector", "explorer", "proposer"]);

export function capabilitiesForRole(role: AgentRole): RoleCapabilities {
  return { canWrite: !READ_ONLY_ROLES.has(role) };
}

export interface RoleAssignment {
  provider: AgentProvider;
  model: string;
}

export interface AgentRuntimeConfig {
  mode: AgentMode;
  singleProvider: AgentProvider;
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

export interface AgentRuntimeStrategy {
  provider: AgentProvider;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
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
  getStatus(): Promise<{ mode: AgentMode; providers: AgentProviderHealth[] }>;
  listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
  startEventStream?(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void>;
}

/*
 * The one role -> agent-name table. An agent name is the key of `agent` in agents/opencode.json and
 * the stem of agent/roles/<name>.md. Every forward lookup and the reverse lookup read from here, so
 * a role cannot compile without a name and a name always resolves back to its own role.
 */
export const AGENT_NAME_FOR_ROLE: Readonly<Record<AgentRole, string>> = {
  primary: "qa-generator",
  reviewer: "qa-reviewer",
  chat: "qa-assistant",
  worker: "qa-worker",
  workerCode: "qa-worker-code",
  sidekick: "qa-sidekick",
  maintainer: "qa-maintainer",
  reflector: "qa-reflector",
  explorer: EXPLORER_AGENT_NAME,
  proposer: "qa-proposer",
};

const ROLE_FOR_AGENT_NAME: ReadonlyMap<string, AgentRole> = new Map(
  (Object.entries(AGENT_NAME_FOR_ROLE) as Array<[AgentRole, string]>).map(([role, name]) => [name, role]),
);

/* An agent name no role maps to is a wiring error; running it under another role would hand it that role's tools and prompt. */
export function roleForLegacyAgent(agent: string): AgentRole {
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
