/* Deterministic proposer — no LLM. Prefers direct for simple change-analysis; proposes delegate to sidekick-standard when the change looks hard. AdaptiveRoutingPolicy may raise the file threshold; it never skips budgets, evidence gates, reviewer, FixLoop, or authority.
Non-diff modes stay direct: RunQaUseCase emits change-analysis evidence only in diff mode, so looksDelegable is false. Lead owns guided and whole-repo generation. */
import type { CoordinationPort } from "../ports/coordination.port.ts";
import type { AdaptiveRoutingPolicy, AdaptiveRoutingSignals } from "./adaptive-routing.ts";
import type { CoordinationContext } from "./coordination-context.ts";
import type { CoordinationDecision } from "./coordination-decision.ts";

export interface ProposingCoordinationAdapterOpts {
  readonly policy?: AdaptiveRoutingPolicy;
  /** When absent/undefined, the deterministic default file threshold (8) applies. */
  readonly signals?: () => AdaptiveRoutingSignals | undefined;
}

function looksDelegable(
  context: CoordinationContext,
  fileThreshold: number,
): boolean {
  /* Absent change-analysis → direct (covers non-diff modes by design). */
  const change = context.evidence.find((e) => e.kind === "change-analysis");
  if (!change) return false;
  if (/\bcontradiction\b/i.test(change.summary)) return true;
  const files = /files=(\d+)/.exec(change.summary);
  if (files && Number(files[1]) >= fileThreshold) return true;
  if (
    /\b(generate|exhaustive|complete)\b/i.test(change.summary) &&
    files &&
    Number(files[1]) >= Math.max(4, Math.floor(fileThreshold / 2))
  ) {
    return true;
  }
  return false;
}

export class ProposingCoordinationAdapter implements CoordinationPort {
  constructor(
    private readonly opts: ProposingCoordinationAdapterOpts = {},
  ) {}

  async decide(context: CoordinationContext): Promise<CoordinationDecision> {
    const signals = this.opts.signals?.();
    const fileThreshold =
      signals && this.opts.policy
        ? this.opts.policy.delegationFileThreshold(signals)
        : 8;
    if (looksDelegable(context, fileThreshold)) {
      return {
        action: "delegate",
        reason: `change analysis suggests sidekick (fileThreshold=${fileThreshold})`,
        evidence: context.evidence,
        nextCapability: "sidekick-standard",
      };
    }
    return {
      action: "direct",
      reason: `simple/direct path (fileThreshold=${fileThreshold})`,
      evidence: context.evidence,
    };
  }
}
