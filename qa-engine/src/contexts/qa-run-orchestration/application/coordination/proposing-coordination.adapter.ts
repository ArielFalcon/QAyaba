// Deterministic proposer for shadow/active decide(). No LLM. Prefers direct for simple
// change-analysis; proposes delegate to sidekick-standard when the change looks hard.
import type { CoordinationPort } from "../ports/coordination.port.ts";
import type { CoordinationContext } from "./coordination-context.ts";
import type { CoordinationDecision } from "./coordination-decision.ts";
import type { CoordinationMode } from "./coordination-mode.ts";

function looksDelegable(context: CoordinationContext): boolean {
  const change = context.evidence.find((e) => e.kind === "change-analysis");
  if (!change) return false;
  if (/\bcontradiction\b/i.test(change.summary)) return true;
  const files = /files=(\d+)/.exec(change.summary);
  if (files && Number(files[1]) >= 8) return true;
  if (/\b(generate|exhaustive|complete)\b/i.test(change.summary) && files && Number(files[1]) >= 4) return true;
  return false;
}

export class ProposingCoordinationAdapter implements CoordinationPort {
  constructor(readonly mode: Exclude<CoordinationMode, "off">) {}

  async decide(context: CoordinationContext): Promise<CoordinationDecision> {
    if (looksDelegable(context)) {
      return {
        action: "delegate",
        reason: `coordination.mode=${this.mode}: change analysis suggests sidekick`,
        evidence: context.evidence,
        nextCapability: "sidekick-standard",
      };
    }
    return {
      action: "direct",
      reason: `coordination.mode=${this.mode}: simple/direct path`,
      evidence: context.evidence,
    };
  }
}
