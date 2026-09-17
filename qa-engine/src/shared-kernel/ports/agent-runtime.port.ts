/* Kernel session-management seam. Generation depends on AgentRuntimePort from the kernel, decoupled from the agent-runtime context. Shapes are declared locally so the port never imports src/. */

import type { AgentRole, AgentProvider } from "@kernel/agent-role.ts";

export interface UsageSnapshot { inputTokens: number; outputTokens: number; provider: AgentProvider; }

/** Session-scoped identity. runId/objective are optional so inapplicable call-sites (maintainer) omit them. */
export interface AgentOpenDescriptor {
  runId?: string;
  role?: string;
  objective?: string;
}

/** Per-turn telemetry. runId is nullable for runs without a run context. */
export interface AgentTurnEvent {
  runId: string | null;
  role: AgentRole;
  objective?: string;
  round: number;
  isRepair: boolean;
  sectionSizes: Record<string, number> | null;
}

export interface AgentSession {
  prompt(
    text: string,
    opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null },
  ): Promise<{ output: string }>;
  dispose(): Promise<void> | void;
}
export interface OpenSessionOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  onUsage?: (u: UsageSnapshot) => void;
  onTurn?: (t: AgentTurnEvent) => void;
  descriptor?: AgentOpenDescriptor;
}
export interface AgentRuntimePort {
  openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession>;
}
