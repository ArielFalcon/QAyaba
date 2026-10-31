import { agentConfigFacts, turnModel } from "./opencode-client";
import type { DeclaredModels } from "./types";

/* The models a roster file declares; `configPath` names the file (default: the host's). */
export function declaredModelsFrom(configPath?: string): DeclaredModels {
  return (agent) => agentConfigFacts(agent, configPath)?.model;
}

/* The model each agent runs on: the one the OpenCode server last listed for it (the roster it serves), the host's file only for an agent it has not listed. */
export const declaredAgentModel: DeclaredModels = (agent) => turnModel(agent);
