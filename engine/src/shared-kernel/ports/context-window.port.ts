import type { AgentRole } from "../agent-role.ts";

/**
 * The context window, in tokens, of the model a role runs on, for ONE run. The composition root builds it from what the agent
 * runtime reports live and from the runtime's role -> model assignments; the engine names no model and keeps no table of windows.
 * `undefined` means the window is not known: a caller never substitutes a number for it.
 */
export interface ContextWindowPort {
  windowTokens(role: AgentRole): number | undefined;
}
