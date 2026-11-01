/* ReviewPort: the `review` sidekick kind (session opened as the registry's review entry names it: `REVIEW_SIDEKICK`). A reviewer that could not be reached, or returned nothing, is marked `unavailable` and carries no verdict at all: no judgment was made, and it is neither an approval nor a rejection. A reached reviewer whose answer cannot be read is a parse miss: fail-closed, and an answer the run does not pass on. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { LOG_EFFECT, levelOfEffect } from "@kernel/ports/logger.port.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewerVerdict } from "../../domain/verdict-validate.ts";
import type { ReviewPort } from "../../application/ports/review.port.ts";
import type { ReviewEnrichment } from "../../domain/review-enrichment.ts";
import type { ReviewStats } from "../../domain/review.ts";
import { REVIEWER_UNAVAILABLE_MARKER } from "../../domain/review.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/index.ts";
import type { ReviewInput, StepLimitFor } from "@contexts/generation/application/index.ts";
import type { RunMode } from "@kernel/run-mode.ts";
import { promptFactsOpts } from "@contexts/generation/application/index.ts";
import { renderExecutionResult, type ExecutionResultCase } from "@contexts/generation/infrastructure/prompt-builders/review-render.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { rethrowIfRunDeadline } from "@kernel/run-deadline.ts";
import { describeNoSubmission, renderSubmissionErrors, type SubmittedTurn } from "@kernel/submission.ts";
import { submitTurn } from "@kernel/submit-turn.ts";
import { openSidekickSession, REVIEW_SIDEKICK } from "@kernel/sidekick-session.ts";
import { reviewerVerdictContract } from "../../domain/reviewer-verdict.contract.ts";

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

  async review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): ReturnType<ReviewPort["review"]> {
    const { runtime, rendering, verdicts } = this.deps;

    /* Specs under review = case file/name, one entry per spec file (many cases run in one file); cases are the only per-spec identity at this seam. */
    const specs = [...new Set(cases.map((c) => normalizeSpecPath(c.file ?? c.name) || (c.file ?? c.name)))];
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
      ...(enrichment?.priorCorrections?.length ? { priorCorrections: [...enrichment.priorCorrections] } : {}),
      ...(enrichment?.specChanges ? { specChanges: enrichment.specChanges } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.untakenArms?.length ? { untakenArms: [...enrichment.untakenArms] } : {}),
      ...(enrichment?.routeAvailability?.length ? { routeAvailability: enrichment.routeAvailability } : {}),
      ...(enrichment?.dataContradictions?.length ? { dataContradictions: enrichment.dataContradictions } : {}),
      ...(enrichment?.ambientDataPins?.length ? { ambientDataPins: enrichment.ambientDataPins } : {}),
      ...(enrichment?.executionEvidence ? { executionResult: renderExecutionResult({ verdict: enrichment.executionEvidence.verdict, cases: enrichment.executionEvidence.cases.map(executionResultCase) }) } : {}),
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
      ...(enrichment?.changeView ? { changeView: enrichment.changeView } : {}),
      /* The limit the runtime enforces for the reviewer's session. Absent -> omitted, never a made-up number. */
      ...(stepLimit !== undefined ? { stepLimit } : {}),
    };
    const assembled = rendering.renderReviewer(reviewInput);
    const startedAt = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
    let steps: number | undefined;

    /* Reviewer session is loud-but-non-fatal: log the fault and return it as unavailable (parsed:false / approved:false, fail-closed, no regen round); the run ends on it as an infra-error and never reads it as a rejection. */
    try {
      const session = await openSidekickSession(runtime, REVIEW_SIDEKICK, this.ctx.mirrorDir, {
        descriptor: { runId: enrichment?.runId },
        ...(this.ctx.timeoutMs !== undefined ? { timeoutMs: this.ctx.timeoutMs, timeLimit: "session-timeout" as const } : {}),
        /* Usage is reported per attempt; a fallback attempt adds to the same turn. */
        onUsage: (u) => {
          usage.inputTokens += u.input;
          usage.outputTokens += u.output;
          usage.costUsd += u.cost;
          usage.calls++;
        },
      });
      let delivery: SubmittedTurn<ReviewerVerdict>;
      try {
        /* The reviewer delivers its verdict by calling its submit tool; a turn that ends without an accepted one gets one continuation in the same session. */
        delivery = await submitTurn(
          session,
          assembled.text,
          {
            sectionSizes: assembled.sectionSizes,
            ...promptFactsOpts(assembled),
            ...(stepLimit !== undefined ? { stepLimit } : {}),
            onTurnStats: (stats) => {
              if (stats.stepsUsed !== null) steps = stats.stepsUsed;
            },
          },
          reviewerVerdictContract,
        );
      } finally {
        await session.dispose();
      }
      const stats: ReviewStats = {
        durationMs: Date.now() - startedAt,
        promptBytes: Buffer.byteLength(assembled.text, "utf8"),
        outputChars: delivery.output.length,
        ...(usage.calls > 0 ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
        ...(usage.calls > 0 && usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
        ...(steps !== undefined ? { steps } : {}),
      };
      if (!delivery.submitted) {
        /* A reviewer that made no call and wrote nothing judged nothing: an errored session (provider refusal, quota, outage) that the transport let through, not a verdict of any kind. */
        if (delivery.calls === 0 && delivery.output.trim() === "") return { ...this.unavailable("the reviewer returned no output"), stats };
        /* A turn that never delivered an accepted verdict, even after its continuation, is a parse miss: never a rejection, never a free pass, and nothing of it reaches the decision. */
        const reason = describeNoSubmission(delivery);
        engineLog[levelOfEffect(LOG_EFFECT.CARRIED_ON)](`[qa] the reviewer delivered no verdict (${reason}) — failing closed as a parse miss without burning a regeneration round.`);
        return { approved: false, findings: [], parsed: false, issues: delivery.errors.length > 0 ? delivery.errors.map((error) => renderSubmissionErrors([error])) : [reason], stats };
      }
      const judgment = verdicts.readReview(delivery.value);

      return {
        approved: judgment.approved,
        /* The finding filter honors a blocking finding only through its cited evidence. */
        findings: judgment.findings,
        ...(judgment.rationale !== undefined ? { rationale: judgment.rationale } : {}),
        ...(judgment.blockingCount !== undefined ? { blockingCount: judgment.blockingCount } : {}),
        ...(judgment.parsed !== undefined ? { parsed: judgment.parsed } : {}),
        ...(judgment.issues.length > 0 ? { issues: judgment.issues } : {}),
        stats,
      };
    } catch (err) {
      /* The run's time is spent: that ends the run, it is not a reviewer fault to fail closed on. */
      rethrowIfRunDeadline(err);
      return { ...this.unavailable(err instanceof Error ? err.message : String(err)), stats: { durationMs: Date.now() - startedAt, promptBytes: Buffer.byteLength(assembled.text, "utf8"), outputChars: 0 } };
    }
  }

  private unavailable(reason: string): { findings: []; rationale: string; parsed: false; unavailable: true } {
    engineLog.error(`[qa] reviewer unavailable (${reason}) — failing closed without burning a regeneration round; the run ends as an infra-error, not a rejection.`);
    return {
      findings: [],
      rationale: `${REVIEWER_UNAVAILABLE_MARKER}: ${reason}`,
      parsed: false,
      unavailable: true,
    };
  }
}
