// Domain dispatch capability for the coordination seam (Fase 1). Distinct from
// AgentRole (kernel runtime: primary | reviewer | worker | …). Reviewer stays on
// ReviewPort and is not a member of this union. Takeover is CoordinationDecision.action,
// not a capability. Infra resolver (later): lead→primary, sidekick-standard→worker,
// sidekick-escalated→external config.
export const AGENT_CAPABILITIES = ["lead", "sidekick-standard", "sidekick-escalated"] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}
