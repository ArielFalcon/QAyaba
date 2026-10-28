/* ReviewPort: the `review` sidekick kind (session opened as the registry's review entry names it: `REVIEW_SIDEKICK`). Fail-closed on parse miss or session fault (approved:false, parsed:false). A session fault, or a reviewer that returned nothing, is also marked `unavailable`: no judgment was made, which the run must not mistake for a rejection. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewPort } from "../../application/ports/review.port.ts";
import type { ReviewEnrichment } from "../../domain/review-enrichment.ts";
import type { ReviewStats } from "../../domain/review.ts";
import { REVIEWER_UNAVAILABLE_MARKER } from "../../domain/review.ts";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, RepairPort, VerdictParserPort } from "@contexts/generation/application/index.ts";
import type { ReviewInput, StepLimitFor } from "@contexts/generation/application/index.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { renderLearnedRulesForReviewer } from "@contexts/cross-run-learning/application/index.ts";
import { promptFactsOpts } from "@contexts/generation/application/index.ts";
import { renderExecutionResult, type ExecutionResultCase } from "@contexts/generation/infrastructure/prompt-builders/review-render.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { rethrowIfRunDeadline } from "@kernel/run-deadline.ts";
import { isAgentTimeoutError } from "@kernel/domain-error.ts";
import { REPAIR_TURN_TIMEOUT_MS } from "../../domain/repair-turn.ts";
import { openSidekickSession, REVIEW_SIDEKICK } from "@kernel/sidekick-session.ts";

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
  /* The contract repair the author's turn already has. Absent: an answer with no readable verdict fails closed at once. */
  repair?: RepairPort;
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
  /* The longest the one contract-repair prompt may run. Absent: `REPAIR_TURN_TIMEOUT_MS`. */
  repairTimeoutMs?: number;
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
      ...(this.ctx.target ? { target: this.ctx.target } : {}),
      ...(enrichment?.priorCorrections?.length ? { priorCorrections: [...enrichment.priorCorrections] } : {}),
      ...(enrichment?.specChanges ? { specChanges: enrichment.specChanges } : {}),
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRulesForReviewer(enrichment.learnedRules) } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.untakenArms?.length ? { untakenArms: [...enrichment.untakenArms] } : {}),
      ...(enrichment?.routeAvailability?.length ? { routeAvailability: enrichment.routeAvailability } : {}),
      ...(enrichment?.dataContradictions?.length ? { dataContradictions: enrichment.dataContradictions } : {}),
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
      let output: string;
      let judgment: ReturnType<VerdictParserPort["parseReview"]> | undefined;
      let repairChars = 0;
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
        /* An answer with nothing in it is the reviewer's absence, not a verdict to repair. */
        if (output.trim() !== "") {
          judgment = verdicts.parseReview(output);
          /* One tools-disabled turn in the same session asks only for the verdict again, so an answer cut off before its closing JSON is not a rejection by default. */
          if (judgment.parsed === false && this.deps.repair) {
            const repaired = await this.repairVerdict(session, this.deps.repair, output, stepLimit);
            if (repaired !== undefined) {
              repairChars = repaired.length;
              const again = verdicts.parseReview(repaired);
              /* Still unreadable: the first answer's parse miss stands, failing closed. */
              if (again.parsed !== false) judgment = again;
            }
          }
        }
      } finally {
        await session.dispose();
      }
      const stats: ReviewStats = {
        durationMs: Date.now() - startedAt,
        promptBytes: Buffer.byteLength(assembled.text, "utf8"),
        outputChars: output.length + repairChars,
        ...(usage.calls > 0 ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
        ...(usage.calls > 0 && usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
        ...(steps !== undefined ? { steps } : {}),
      };
      /* A reviewer that answered with nothing judged nothing: an errored session (provider refusal, quota, outage) that the transport let through, not a verdict of any kind. */
      if (judgment === undefined) return { ...this.unavailable("the reviewer returned no output"), stats };

      /* Parse miss is not an actionable rejection and never a free pass — approved must be false. */
      const approved = judgment.parsed === false ? false : judgment.approved;

      return {
        approved,
        corrections: judgment.corrections,
        ...(judgment.rationale !== undefined ? { rationale: judgment.rationale } : {}),
        ...(judgment.blockingCount !== undefined ? { blockingCount: judgment.blockingCount } : {}),
        ...(judgment.parsed !== undefined ? { parsed: judgment.parsed } : {}),
        /* The finding filter honors a blocking finding only through its cited evidence. */
        ...(judgment.severities ? { severities: judgment.severities } : {}),
        ...(judgment.citations ? { citations: judgment.citations } : {}),
        stats,
      };
    } catch (err) {
      /* The run's time is spent: that ends the run, it is not a reviewer fault to fail closed on. */
      rethrowIfRunDeadline(err);
      return { ...this.unavailable(err instanceof Error ? err.message : String(err)), stats: { durationMs: Date.now() - startedAt, promptBytes: Buffer.byteLength(assembled.text, "utf8"), outputChars: 0 } };
    }
  }

  /* The reviewer's answer held no readable verdict: ask once, with no tool, for the verdict alone. Undefined when the repair ran past its own cap (the first answer stands). Any other fault propagates like a fault of the first turn, and the run's deadline ends the run: the deadline runtime sends no turn when no time is left. */
  private async repairVerdict(session: AgentSession, repair: RepairPort, priorOutput: string, stepLimit: number | undefined): Promise<string | undefined> {
    const timeoutMs = this.collaborators.repairTimeoutMs ?? REPAIR_TURN_TIMEOUT_MS;
    try {
      const repaired = await session.prompt(
        repair.instruction("reviewer", ["the answer ended with no complete verdict JSON (an object with an `approved` field)"], { priorResponseTail: priorOutput }),
        { isRepair: true, withoutTools: true, textOnly: true, ...(stepLimit !== undefined ? { stepLimit } : {}), timeoutMs, timeLimit: "repair-cap" },
      );
      return repaired.output;
    } catch (err) {
      rethrowIfRunDeadline(err);
      if (!isAgentTimeoutError(err)) throw err;
      engineLog.error(`[qa] the reviewer's contract-repair turn timed out after ${timeoutMs}ms (tools disabled); its first answer stands as a parse miss`);
      return undefined;
    }
  }

  private unavailable(reason: string): { approved: false; corrections: string[]; rationale: string; parsed: false; unavailable: true } {
    engineLog.error(`[qa] reviewer unavailable (${reason}) — failing closed without burning a regeneration round; the run ends as an infra-error, not a rejection.`);
    return {
      approved: false,
      corrections: [],
      rationale: `${REVIEWER_UNAVAILABLE_MARKER}: ${reason}`,
      parsed: false,
      unavailable: true,
    };
  }
}
