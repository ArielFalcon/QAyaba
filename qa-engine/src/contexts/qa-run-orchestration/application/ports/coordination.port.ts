/* Coordinator assignment without knowing provider or model. Not kernel-resident: CoordinationContext holds CycleBudget / WallClockBudget, so this file is a sibling of ports/index.ts, not a re-export from that barrel. */
import type { CoordinationContext } from "../coordination/coordination-context.ts";
import type { CoordinationDecision } from "../coordination/coordination-decision.ts";

export interface CoordinationPort {
  decide(context: CoordinationContext): Promise<CoordinationDecision>;
}
