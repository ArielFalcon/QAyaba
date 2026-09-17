/* Provider-agnostic session ports. Kernel AgentRuntimePort is the session seam; this barrel adds provider strategy. StallWatchdogPort is a separate attach/detach lifecycle and must not couple to the circuit-breaker's retry loop. Config shapes are structural — no src/ import. */

export type { UsageSnapshot, AgentTurnEvent, AgentSession, OpenSessionOpts, AgentRuntimePort, AgentOpenDescriptor }
  from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRuntimePort, AgentSession, AgentTurnEvent } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole, RoleAssignment, AgentProvider } from "@kernel/agent-role.ts";

export interface AgentProviderHealth { provider: AgentProvider; status: string; configured: boolean; error?: string; }
export interface AgentModelInfo { id: string; label?: string; provider?: AgentProvider; }

/** One adapter per provider (opencode serve HTTP / codex exec). */
export interface AgentRuntimeStrategy extends AgentRuntimePort {
  provider: AgentProvider;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  restart?(opts?: { apiKey?: string; reason?: string }): Promise<AgentProviderHealth>;
  dispose?(): void | Promise<void>;
}

export interface TransportPort {
  send(payload: unknown): Promise<unknown>;
}
export interface ModelCatalogPort {
  models(provider: AgentProvider): Promise<AgentModelInfo[]>;
}
export interface TurnTelemetrySink {
  record(event: AgentTurnEvent): void;
}
export interface StallWatchdogPort {
  attach(session: AgentSession, onStall: () => void): () => void; /* detach */
}
/** Resolves 3 explicit roles; remaining roles use the fallback assignment. */
export interface RoleAssignmentResolver {
  resolve(role: AgentRole): RoleAssignment;
}

/** publicView is the redacted API-safe projection (no secrets). */
export interface AgentRuntimeConfigView {
  mode: "single" | "dual";
  assignments: { role: string; provider: AgentProvider; model: string }[];
}
export interface AgentConfigValidationView {
  valid: boolean;
  errors: string[];
}
export interface ConfigPort {
  fromEnv(env?: Record<string, string | undefined>): AgentRuntimeConfigView;
  validate(cfg: AgentRuntimeConfigView, keys: Record<string, boolean>): AgentConfigValidationView;
  publicView(cfg: AgentRuntimeConfigView): AgentRuntimeConfigView;
}

/** Mode-aware facade. Dual reports both providers and multiplexes streams; it never collapses into single. */
export interface AgentFacadePort {
  getStatus(): Promise<{ mode: "single" | "dual"; providers: AgentProviderHealth[] }>;
  listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
  startEventStream?(onActivity: (a: unknown) => void, signal?: AbortSignal,
    onRunEvent?: (runId: string, body: unknown) => void): Promise<void>;
}
