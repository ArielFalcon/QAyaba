/* ReviewPort: standalone reviewer session. Fail-closed on parse miss or session fault (approved:false, parsed:false). A session fault, or a reviewer that returned nothing, is also marked `unavailable`: no judgment was made, which the run must not mistake for a rejection. */

import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewPort, ReviewEnrichment } from "../../application/ports/index.ts";
import { REVIEWER_UNAVAILABLE_MARKER } from "../../application/ports/index.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/ports/index.ts";
import type { ReviewInput, StepLimitFor } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { renderLearnedRulesForReviewer } from "./generation-port.adapter.ts";
import { rethrowIfRunDeadline } from "@kernel/run-deadline.ts";

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

export interface ReviewPortCollaborators {
  /* The step limit the runtime enforces for a role this run, asked for on every review. Absent -> no review input states a limit. */
  stepLimitFor?: StepLimitFor;
}

export class ReviewPortAdapter implements ReviewPort {
  constructor(
    private readonly deps: ReviewPortRuntime,
    private readonly ctx: ReviewPortStaticContext,
    private readonly collaborators: ReviewPortCollaborators = {},
  ) {}

  async review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): Promise<{
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
    unavailable?: boolean;
  }> {
    const { runtime, rendering, verdicts } = this.deps;

    /* Specs under review = case file/name; cases are the only per-spec identity at this seam. */
    const specs = cases.map((c) => c.file ?? c.name);
    const stepLimit = await this.collaborators.stepLimitFor?.("reviewer");

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
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRulesForReviewer(enrichment.learnedRules) } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
      /* The limit the runtime enforces for the reviewer's session. Absent -> omitted, never a made-up number. */
      ...(stepLimit !== undefined ? { stepLimit } : {}),
    };
    const assembled = rendering.renderReviewer(reviewInput);

    /* Reviewer session is loud-but-non-fatal: log the fault and return it as unavailable (parsed:false / approved:false, fail-closed, no regen round); the run ends on it as an infra-error and never reads it as a rejection. */
    try {
      const session = await runtime.openSession("reviewer", this.ctx.mirrorDir, {
        descriptor: { runId: enrichment?.runId, role: "qa-reviewer" },
        ...(this.ctx.timeoutMs !== undefined ? { timeoutMs: this.ctx.timeoutMs } : {}),
      });
      let output: string;
      try {
        /* The turn is judged by the limit the prompt states. */
        const out = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes, ...(stepLimit !== undefined ? { stepLimit } : {}) });
        output = out.output;
      } finally {
        await session.dispose();
      }
      /* A reviewer that answered with nothing judged nothing: an errored session (provider refusal, quota, outage) that the transport let through, not a verdict of any kind. */
      if (output.trim() === "") return this.unavailable("the reviewer returned no output");

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
      /* The run's time is spent: that ends the run, it is not a reviewer fault to fail closed on. */
      rethrowIfRunDeadline(err);
      return this.unavailable(err instanceof Error ? err.message : String(err));
    }
  }

  private unavailable(reason: string): { approved: false; corrections: string[]; rationale: string; parsed: false; unavailable: true } {
    console.error(`[qa] reviewer unavailable (${reason}) — failing closed without burning a regeneration round; the run ends as an infra-error, not a rejection.`);
    return {
      approved: false,
      corrections: [],
      rationale: `${REVIEWER_UNAVAILABLE_MARKER}: ${reason}`,
      parsed: false,
      unavailable: true,
    };
  }
}
