/* Coordination dispatch capability. Distinct from AgentRole (kernel runtime). Reviewer stays on ReviewPort. Takeover is CoordinationDecision.action, not a capability. Resolver: lead → primary, sidekick-* → sidekick. */
export const AGENT_CAPABILITIES = ["lead", "sidekick-standard", "sidekick-escalated"] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}
