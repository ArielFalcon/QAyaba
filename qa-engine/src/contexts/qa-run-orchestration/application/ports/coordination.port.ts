// Application-layer port: the coordinator (not yet concrete) returns an assignment
// decision without knowing provider or model. Not kernel-resident — CoordinationContext
// holds CycleBudget / WallClockBudget — so this file is a sibling of ports/index.ts,
// not a re-export from that barrel.
import type { CoordinationContext } from "../coordination/coordination-context.ts";
import type { CoordinationDecision } from "../coordination/coordination-decision.ts";
import type { CoordinationMode } from "../coordination/coordination-mode.ts";

export interface CoordinationPort {
  readonly mode: CoordinationMode;
  decide(context: CoordinationContext): Promise<CoordinationDecision>;
}
