import type { RunVerdict } from "@kernel/run-verdict.ts";

export type PublishOutcome = "pr" | "issue" | "shadow" | "quarantine" | "held" | "noop";
export interface PublishContext {
  verdict: RunVerdict;
  /* The verdict a review reached: `true` approved, `false` rejected, absent when no verdict was reached. An absent one is no approval either. */
  reviewerApproved?: boolean;
  coverageBlocks: boolean;
  shadow: boolean;
  e2eChanged: boolean;
  /* The run found a defect by the engine's own facts: it is reported whatever the verdict. */
  defectFound?: boolean;
}
export interface PublishDecision { outcome: PublishOutcome; reason: string; }

export class PublishDecisionService {
  decide(ctx: PublishContext): PublishDecision {
    if (ctx.shadow) return { outcome: "shadow", reason: "shadow mode — side effects replaced with logs" };
    switch (ctx.verdict) {
      case "pass":
        if (ctx.reviewerApproved === false) return { outcome: "issue", reason: "green but reviewer rejected" };
        if (ctx.reviewerApproved === undefined) return { outcome: "issue", reason: "green but no reviewer verdict — nothing is published on an approval nobody gave" };
        if (ctx.coverageBlocks) return { outcome: "held", reason: "green but change-coverage enforce-blocks the PR — held, nothing opened in the repository" };
        if (!ctx.e2eChanged) return { outcome: "noop", reason: "green with no e2e/ changes — nothing to publish" };
        return { outcome: "pr", reason: "green, approved, covered — open PR with auto-merge" };
      case "flaky":
        if (ctx.defectFound) return { outcome: "issue", reason: "flaky, and a defect was found — quarantine the flaky case, open an Issue for the defect" };
        return { outcome: "quarantine", reason: "flaky — quarantine, no PR" };
      case "infra-error":
        if (ctx.defectFound) return { outcome: "issue", reason: "infra-error, and a defect was found — open an Issue for the defect" };
        return { outcome: "noop", reason: "infra-error — the run could not reach a verdict, not a code bug; no side effect" };
      case "skipped":
        if (ctx.defectFound) return { outcome: "issue", reason: "skipped, and a defect was found — open an Issue for the defect" };
        return { outcome: "noop", reason: "skipped — no work to publish" };
      case "fail":
      case "invalid":
      default:
        return { outcome: "issue", reason: `${ctx.verdict} — open an Issue` };
    }
  }
}
