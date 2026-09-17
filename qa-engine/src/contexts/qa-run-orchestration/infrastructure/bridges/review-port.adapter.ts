/* ReviewPort: standalone reviewer session. Fail-closed on parse miss or session fault (approved:false, parsed:false). */

import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewPort, ReviewEnrichment } from "../../application/ports/index.ts";
import { REVIEWER_UNAVAILABLE_MARKER } from "../../application/ports/index.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/ports/index.ts";
import type { ReviewInput } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { renderLearnedRulesForReviewer } from "./generation-port.adapter.ts";

export interface ReviewPortRuntime {
  runtime: AgentRuntimePort;
  rendering: PromptRenderingPort;
  verdicts: VerdictParserPort;
}

export interface ReviewPortStaticContext {
  diff: string;
  mirrorDir: string;
  e2eRelDir: string;
  appName: string;
  mode: RunMode;
  baseUrl?: string;
  guidance?: string;
  target?: TestTarget;
  /* Reviewer's own session deadline. Absent → openSession omits timeoutMs. */
  timeoutMs?: number;
}

export class ReviewPortAdapter implements ReviewPort {
  constructor(
    private readonly deps: ReviewPortRuntime,
    private readonly ctx: ReviewPortStaticContext,
  ) {}

  async review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): Promise<{
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
  }> {
    const { runtime, rendering, verdicts } = this.deps;

    /* Specs under review = case file/name; cases are the only per-spec identity at this seam. */
    const specs = cases.map((c) => c.file ?? c.name);

    const reviewInput: ReviewInput = {
      diff: diff ?? this.ctx.diff,
      specs,
      mirrorDir: this.ctx.mirrorDir,
      e2eRelDir: this.ctx.e2eRelDir,
      appName: this.ctx.appName,
      mode: this.ctx.mode,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
      ...(this.ctx.target ? { target: this.ctx.target } : {}),
      ...(enrichment?.priorCorrections?.length ? { priorCorrections: [...enrichment.priorCorrections] } : {}),
      ...(!this.ctx.guidance && enrichment?.intent?.message ? { objective: enrichment.intent.message } : {}),
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRulesForReviewer(enrichment.learnedRules) } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
    };
    const assembled = rendering.renderReviewer(reviewInput);

    /* Reviewer session is loud-but-non-fatal: log the fault, return parsed:false / approved:false so the run still decides from execution evidence (fail-closed, no regen round). */
    try {
      const session = await runtime.openSession("reviewer", this.ctx.mirrorDir, {
        descriptor: { runId: enrichment?.runId, role: "qa-reviewer" },
        ...(this.ctx.timeoutMs !== undefined ? { timeoutMs: this.ctx.timeoutMs } : {}),
      });
      let output: string;
      try {
        const out = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes });
        output = out.output;
      } finally {
        await session.dispose();
      }

      const judgment = verdicts.parseReview(output);

      /* Parse miss is not an actionable rejection and never a free pass — approved must be false. */
      const approved = judgment.parsed === false ? false : judgment.approved;

      return {
        approved,
        corrections: judgment.corrections,
        ...(judgment.rationale !== undefined ? { rationale: judgment.rationale } : {}),
        ...(judgment.blockingCount !== undefined ? { blockingCount: judgment.blockingCount } : {}),
        ...(judgment.parsed !== undefined ? { parsed: judgment.parsed } : {}),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[qa] reviewer session failed (${reason}) — reviewer unavailable, failing closed without burning a regeneration round.`);
      return {
        approved: false,
        corrections: [],
        rationale: `${REVIEWER_UNAVAILABLE_MARKER}: ${reason}`,
        parsed: false,
      };
    }
  }
}
