/* ReviewPort: standalone reviewer session. Fail-closed on parse miss or session fault (approved:false, parsed:false). A session fault, or a reviewer that returned nothing, is also marked `unavailable`: no judgment was made, which the run must not mistake for a rejection. */

import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewPort } from "../../application/ports/review.port.ts";
import type { ReviewEnrichment } from "../../domain/review-enrichment.ts";
import type { ReviewStats } from "../../domain/review.ts";
import { REVIEWER_UNAVAILABLE_MARKER } from "../../domain/review.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/index.ts";
import type { ReviewInput, StepLimitFor } from "@contexts/generation/application/index.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { renderLearnedRulesForReviewer } from "@contexts/cross-run-learning/application/index.ts";
import { promptFactsOpts } from "@contexts/generation/application/index.ts";
import { renderExecutionResult, type ExecutionResultCase } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { rethrowIfRunDeadline } from "@kernel/run-deadline.ts";

/* One executed case as the reviewer's execution evidence: only the fields the renderer shows, and only when the run captured them. */
function executionResultCase(c: QaCase): ExecutionResultCase {
  return {
    name: c.name,
    ...(c.httpStatus !== undefined ? { httpStatus: c.httpStatus } : {}),
    ...(c.finalUrl !== undefined ? { finalUrl: c.finalUrl } : {}),
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
  };
}

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
    stats?: ReviewStats;
  }> {
    const { runtime, rendering, verdicts } = this.deps;

    /* Specs under review = case file/name; cases are the only per-spec identity at this seam. */
    const specs = cases.map((c) => c.file ?? c.name);
    const stepLimit = await this.collaborators.stepLimitFor?.("reviewer");

    const reviewInput: ReviewInput = {
      diff: diff ?? this.ctx.diff,
      specs,
      ...(enrichment?.existingSpecFiles?.length ? { existingSpecFiles: [...enrichment.existingSpecFiles] } : {}),
      mirrorDir: this.ctx.mirrorDir,
      e2eRelDir: this.ctx.e2eRelDir,
      appName: this.ctx.appName,
      mode: this.ctx.mode,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
      ...(this.ctx.target ? { target: this.ctx.target } : {}),
      ...(enrichment?.priorCorrections?.length ? { priorCorrections: [...enrichment.priorCorrections] } : {}),
      ...(enrichment?.specChanges ? { specChanges: enrichment.specChanges } : {}),
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRulesForReviewer(enrichment.learnedRules) } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.executionEvidence ? { executionResult: renderExecutionResult({ verdict: enrichment.executionEvidence.verdict, cases: enrichment.executionEvidence.cases.map(executionResultCase) }) } : {}),
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
      /* The limit the runtime enforces for the reviewer's session. Absent -> omitted, never a made-up number. */
      ...(stepLimit !== undefined ? { stepLimit } : {}),
    };
    const assembled = rendering.renderReviewer(reviewInput);
    const startedAt = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
    let steps: number | undefined;

    /* Reviewer session is loud-but-non-fatal: log the fault and return it as unavailable (parsed:false / approved:false, fail-closed, no regen round); the run ends on it as an infra-error and never reads it as a rejection. */
    try {
      const session = await runtime.openSession("reviewer", this.ctx.mirrorDir, {
        descriptor: { runId: enrichment?.runId, role: "qa-reviewer" },
        ...(this.ctx.timeoutMs !== undefined ? { timeoutMs: this.ctx.timeoutMs, timeLimit: "session-timeout" as const } : {}),
        /* Usage is reported per attempt; a fallback attempt adds to the same turn. */
        onUsage: (u) => {
          usage.inputTokens += u.input;
          usage.outputTokens += u.output;
          usage.costUsd += u.cost;
          usage.calls++;
        },
      });
      let output: string;
      try {
        /* The turn is judged by the limit the prompt states. textOnly drops the model's reasoning
         * parts: the verdict is its spoken answer, and the reasoning is not what the parser reads. */
        const out = await session.prompt(assembled.text, {
          sectionSizes: assembled.sectionSizes,
          ...promptFactsOpts(assembled),
          ...(stepLimit !== undefined ? { stepLimit } : {}),
          textOnly: true,
          onTurnStats: (stats) => {
            if (stats.stepsUsed !== null) steps = stats.stepsUsed;
          },
        });
        output = out.output;
      } finally {
        await session.dispose();
      }
      const stats: ReviewStats = {
        durationMs: Date.now() - startedAt,
        promptBytes: Buffer.byteLength(assembled.text, "utf8"),
        outputChars: output.length,
        ...(usage.calls > 0 ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
        ...(usage.calls > 0 && usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
        ...(steps !== undefined ? { steps } : {}),
      };
      /* A reviewer that answered with nothing judged nothing: an errored session (provider refusal, quota, outage) that the transport let through, not a verdict of any kind. */
      if (output.trim() === "") return { ...this.unavailable("the reviewer returned no output"), stats };

      const judgment = verdicts.parseReview(output);

      /* Parse miss is not an actionable rejection and never a free pass — approved must be false. */
      const approved = judgment.parsed === false ? false : judgment.approved;

      return {
        approved,
        corrections: judgment.corrections,
        ...(judgment.rationale !== undefined ? { rationale: judgment.rationale } : {}),
        ...(judgment.blockingCount !== undefined ? { blockingCount: judgment.blockingCount } : {}),
        ...(judgment.parsed !== undefined ? { parsed: judgment.parsed } : {}),
        stats,
      };
    } catch (err) {
      /* The run's time is spent: that ends the run, it is not a reviewer fault to fail closed on. */
      rethrowIfRunDeadline(err);
      return { ...this.unavailable(err instanceof Error ? err.message : String(err)), stats: { durationMs: Date.now() - startedAt, promptBytes: Buffer.byteLength(assembled.text, "utf8"), outputChars: 0 } };
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
