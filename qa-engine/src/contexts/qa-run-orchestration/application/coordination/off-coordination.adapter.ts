// Mode=off adapter: same RunQaUseCase path, no new delegation. Always assigns the
// work to the lead (`direct`). Not a Coordinator — Fase 1 forbids a concrete coordinator.
// Lives next to the port because it has no IO; it is the default no-op of the seam.
import type { CoordinationPort } from "../ports/coordination.port.ts";
import type { CoordinationContext } from "./coordination-context.ts";
import type { CoordinationDecision } from "./coordination-decision.ts";

export class OffCoordinationAdapter implements CoordinationPort {
  readonly mode = "off" as const;

  async decide(context: CoordinationContext): Promise<CoordinationDecision> {
    return {
      action: "direct",
      reason: "coordination.mode=off",
      evidence: context.evidence,
    };
  }
}
