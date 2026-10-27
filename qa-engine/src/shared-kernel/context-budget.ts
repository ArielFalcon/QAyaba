/*
 * Whether a prompt fits a model's context window: prompt + the working room the turn needs <= window. The window comes from the
 * per-run ContextWindowPort and the room from a WorkingRoomEstimate (telemetry of real turns). Neither is a fixed share and neither
 * is invented: an unknown window or an unknown room makes the outcome `unknown`, and a caller then acts as if nothing limited it.
 */
import type { AgentRole } from "./agent-role.ts";
import type { ContextWindowPort } from "./ports/context-window.port.ts";
import type { RoleWorkingRoom, WorkingRoomEstimate } from "./working-room.ts";

/*
 * Bytes to tokens: one token is estimated as 4 bytes of prompt text. This is the widely used rule of thumb for English prose and
 * source code under BPE tokenizers; there is no tokenizer at this layer, so it is an estimator, not a count.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

export function tokensOfBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

export function bytesOfTokens(tokens: number): number {
  return tokens * BYTES_PER_TOKEN_ESTIMATE;
}

/* The context a role's steps add to its session: growth per step x usual steps. */
export function roomTokens(room: RoleWorkingRoom): number {
  return Math.ceil(room.growthTokensPerStep * room.steps);
}

export type PromptSize = { readonly tokens: number } | { readonly bytes: number };

export interface FitRequest {
  readonly prompt: PromptSize;
  readonly role: AgentRole;
  /* A model the caller picked itself; absent, the role's own. */
  readonly model?: string;
}

export interface ContextFit {
  readonly outcome: "fits" | "over" | "unknown";
  readonly promptTokens: number;
  readonly windowTokens?: number;
  readonly workingRoomTokens?: number;
  readonly roomBasis?: "history" | "cold-start";
}

export class ContextBudget {
  constructor(
    private readonly windows: ContextWindowPort,
    private readonly room: WorkingRoomEstimate,
  ) {}

  /* The run's window of a role (or of a model the caller picked), in tokens; undefined when not known. */
  windowTokens(role: AgentRole, model?: string): number | undefined {
    return this.windows.windowTokens(role, model);
  }

  fit({ prompt, role, model }: FitRequest): ContextFit {
    const promptTokens = "tokens" in prompt ? prompt.tokens : tokensOfBytes(prompt.bytes);
    const windowTokens = this.windows.windowTokens(role, model);
    const room = this.room.forRole(role);
    const workingRoomTokens = room ? roomTokens(room) : undefined;
    const known = {
      promptTokens,
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      ...(workingRoomTokens !== undefined ? { workingRoomTokens } : {}),
      ...(room ? { roomBasis: room.basis } : {}),
    };
    if (windowTokens === undefined || workingRoomTokens === undefined) return { outcome: "unknown", ...known };
    return { outcome: promptTokens + workingRoomTokens <= windowTokens ? "fits" : "over", ...known };
  }
}
