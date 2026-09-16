// Shadow validation (Fase 12). Pipeline result still governs; this only classifies
// whether a coordination proposal was comparable to what actually ran.
import type { CoordinationDecision } from "./coordination-decision.ts";
import type { CoordinationMode } from "./coordination-mode.ts";

export const SHADOW_DIVERGENCE_CLASSES = [
  "better",
  "same",
  "worse",
  "non-comparable",
  "infrastructure",
] as const;
export type ShadowDivergenceClass = (typeof SHADOW_DIVERGENCE_CLASSES)[number];

export function classifyShadowDivergence(input: {
  mode: CoordinationMode;
  proposal: CoordinationDecision | undefined;
  pipelineVerdict: string;
}): ShadowDivergenceClass | undefined {
  if (input.mode !== "shadow") return undefined;
  if (!input.proposal) return undefined;
  if (input.pipelineVerdict === "infra-error") return "infrastructure";
  // Shadow never executes the sidekick path, so a delegate proposal cannot be scored.
  if (input.proposal.action === "delegate") return "non-comparable";
  // Direct/lead proposal matches the pipeline that actually ran.
  if (input.proposal.action === "direct" || input.proposal.action === "takeover") return "same";
  return "non-comparable";
}
