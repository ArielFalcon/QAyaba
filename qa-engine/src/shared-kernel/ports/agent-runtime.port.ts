/* Kernel session-management seam. Generation depends on AgentRuntimePort from the kernel, decoupled from the agent-runtime context. Shapes are declared locally so the port never imports src/. */

import type { AgentRole, AgentProvider } from "@kernel/agent-role.ts";

export interface UsageSnapshot { inputTokens: number; outputTokens: number; provider: AgentProvider; }

/** Session-scoped identity. runId/objective are optional so inapplicable call-sites (maintainer) omit them. */
export interface AgentOpenDescriptor {
  runId?: string;
  role?: string;
  objective?: string;
  /**
   * `false` marks a session whose turns still persist (tagged with `runId`) but
   * whose SSE stream must NOT be registered — the explorer's case: registering
   * it would feed the 180s stall watchdog and change its liveness window.
   * Omitted or `true` means "register as usual", as for every other role.
   */
  liveObservation?: boolean;
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

/**
 * What one prompt measured of its own turn, handed to the caller of `prompt` and equal to what is
 * persisted for that turn. Each figure is null when it is unknown: never a fabricated zero or false.
 * A runtime with no step concept (Codex) never supplies stats.
 */
export interface AgentTurnStats {
  /** The limit the turn was judged against: the number its prompt stated, else the agent's configured limit; null when neither exists. */
  maxSteps: number | null;
  /** Steps the turn used; null unless every one of them was observed. */
  stepsUsed: number | null;
  /** True: the turn hit its step limit. False: known not to have. Null: unknown. */
  exhausted: boolean | null;
  /** Files the turn wrote; a lower bound when `observationComplete` is false. */
  writeCount: number | null;
  /** Whether the turn's tool calls and steps were all observed. */
  observationComplete: boolean;
}

export interface AgentPromptOpts {
  /** Return only the model's text, without its reasoning. */
  textOnly?: boolean;
  /** Return only the text of the agent's final step: what it concluded with, not what it said or recalled on the way. */
  finalStepOnly?: boolean;
  round?: number;
  isRepair?: boolean;
  sectionSizes?: Record<string, number> | null;
  /** Files (relative to the session's directory) whose content the prompt already renders, so a read of one is not fresh information. */
  providedPaths?: readonly string[];
  /** Called once per resolved prompt with that turn's stats, by runtimes that can measure them. A fault in the callback is logged and never disturbs the prompt. */
  onTurnStats?: (stats: AgentTurnStats) => void;
  /** The step limit this prompt states, as the runtime enforces it for the session's role. The turn it starts is classified against this number, so the figure a prompt states and the one its turn is judged by are the same. Absent: the prompt states none, and the agent's configured limit stands. */
  stepLimit?: number;
}

export interface AgentSession {
  prompt(text: string, opts?: AgentPromptOpts): Promise<{ output: string }>;
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
