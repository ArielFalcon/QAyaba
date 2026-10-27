import type { AgentRole } from "../agent-role.ts";

/**
 * The context window, in tokens, of the model a role runs on, for ONE run. The composition root builds it from what the agent
 * runtime reports live and from the runtime's role -> model assignments; the engine names no model and keeps no table of windows.
 * `model` names a model the caller picked itself (the escalated model of a replacement sidekick); absent, the role's own model.
 * `undefined` means the window is not known: a caller never substitutes a number for it.
 */
export interface ContextWindowPort {
  windowTokens(role: AgentRole, model?: string): number | undefined;
}
