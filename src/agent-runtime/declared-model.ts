import { agentConfigFacts } from "../integrations/opencode-client";
import type { DeclaredModels } from "./types";

/* The models agents/opencode.json declares, read live; `configPath` names another roster file (default: the host's). */
export function declaredModelsFrom(configPath?: string): DeclaredModels {
  return (agent) => agentConfigFacts(agent, configPath)?.model;
}

export const declaredAgentModel: DeclaredModels = declaredModelsFrom();
