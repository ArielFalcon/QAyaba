/* Sidekick executor: owns an AgentRuntimePort session for one DelegationBrief. Does not modify GenerateTestsUseCase. Model names stay out of this module. Free-form DelegationResult fields are scrubbed on parse — they re-enter lead context / notes. filesChanged paths are authority inputs (scope check, on-disk adoption) and stay raw; they are scrubbed only where echoed into a summary or concern. */
import type { ContextFit } from "@kernel/context-budget.ts";
import type { TimeLimitSource } from "@kernel/turn-limit.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { unansweredTurn, type DelegationResult } from "./delegation-result.ts";
import { isRunDeadlineError } from "@kernel/run-deadline.ts";
import { describeNoSubmission, SUBMIT_TOOL, type SubmittedTurn } from "@kernel/submission.ts";
import { submitTurn } from "@kernel/submit-turn.ts";
import { assembleDefs, type AssembledPrompt, type WindowFitOutcome } from "@kernel/prompt-sections.ts";
import { FEEDBACK_SECTIONS } from "./coordination-sections/feedback-sections.ts";
import type { DevStateGround } from "./dev-state-backing.ts";
import { delegatingKindSpec, type SidekickKind } from "./sidekick-kinds.ts";
import { SESSION_GONE, turnEndOf } from "./sidekick-turn-end.ts";

export interface SidekickRender {
  (brief: DelegationBrief): { text: string; sectionSizes: Record<string, number>; sectionHashes?: Record<string, string>; stablePrefixBytes?: number; sectionsDegraded?: number };
}

export interface SidekickExecutorDeps {
  /* Where every free-form string a sidekick returns or is sent is redacted. */
  redaction: RedactionPort;
  runtime: Pick<AgentRuntimePort, "openSession">;
  render?: SidekickRender;
}

export interface SidekickExecuteOpts {
  cwd: string;
  /* The kind of sidekick the session is for: the registry says which agent runs it, how its brief is rendered and how its answer is read. */
  kind: SidekickKind;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The bound `timeoutMs` is, as a turn that reaches it reports it; absent: the session timeout. */
  timeLimit?: TimeLimitSource;
  feedback?: string;
  /** The flow of a plan the session is opened for: the run_spec loop and the browser share the flow's own are found by it. */
  delegationId?: string;
  /** Tools the session's prompts are denied, whatever the sidekick's configuration allows. */
  denyTools?: readonly string[];
  /** How the brief fits the window of the model the session runs on, for the first turn's telemetry. */
  contextFit?: ContextFit;
  /** The window fit rule of the model the session runs on: the brief is rendered with it, so a brief over the window gives its degradable sections up as references. Absent, nothing is degraded. */
  fit?: (bytes: number) => WindowFitOutcome;
  /** What the orchestrator holds of the flow by its own means, read afresh for each answer (the flow's reads grow turn by turn): an unmet criterion the sidekick attributes to DEV's state is backed by it or blocks. */
  devStateGround?: () => DevStateGround;
  /** The holder reuses a session whose first turn did not answer (it ran out of its time, its flow was stopped, or a fault of the transport or provider ended it): the session is kept, idle, with a failed first result that carries the turn's typed end, instead of being disposed before the error leaves. Only the run's own deadline and a session the runtime says is gone dispose it. */
  keepUnanswered?: boolean;
}

/* A sidekick's session, held open after its first answer so that the lead's follow-up reaches the session that did the work. */
export interface SidekickSession {
  /* What the brief's prompt came to. */
  readonly first: DelegationResult;
  /* Asks the same session again; the answer is read as the first one was. A turn that does not answer returns a failed result with its typed end and leaves the session as it was; only the run's own deadline throws. A session the runtime says is gone is ended here, and a session already ended (the runtime said so in an earlier turn, its continuation included) is not prompted: the turn ends `session-gone`. */
  ask(instruction: string, opts?: { timeoutMs?: number; timeLimit?: TimeLimitSource }): Promise<DelegationResult>;
  /* Ends the session. Idempotent. */
  dispose(): Promise<void>;
}

/* What the lead sends a sidekick after its brief, as the registered sections assemble it. */
export function assembleSidekickFeedback(redaction: RedactionPort, feedback: string, contract: string): AssembledPrompt {
  return assembleDefs(FEEDBACK_SECTIONS, { feedback, contract, scrub: (value: string) => redaction.redact(value) }, { separator: "\n\n" });
}

export class SidekickExecutor {
  constructor(private readonly deps: SidekickExecutorDeps) {}

  /* One answer in a session of its own, which ends with it. */
  async execute(brief: DelegationBrief, opts: SidekickExecuteOpts): Promise<DelegationResult> {
    const session = await this.open(brief, opts);
    await session.dispose();
    return session.first;
  }

  /* Opens the sidekick's session and asks it the brief; the session stays open for the holder to ask again and to dispose. */
  async open(brief: DelegationBrief, opts: SidekickExecuteOpts): Promise<SidekickSession> {
    const spec = delegatingKindSpec(opts.kind);
    const role = spec.role;
    const render: SidekickRender = this.deps.render ?? ((b) => spec.render(this.deps.redaction, b, opts.fit));
    const contract = spec.contract(this.deps.redaction, brief);
    /* The turn's result: what its accepted submission came to, or the orchestrator's own statement that it delivered none. A turn that needed its one continuation says so. */
    const resultOf = (turn: SubmittedTurn<Record<string, unknown>>): DelegationResult => {
      const result = turn.submitted ? spec.read(this.deps.redaction, turn.value, brief, opts.devStateGround?.()) : spec.unsubmitted(this.deps.redaction, brief, describeNoSubmission(turn));
      return turn.continued ? { ...result, repaired: true } : result;
    };
    const session = await this.deps.runtime.openSession(role, opts.cwd, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      ...(opts.timeLimit !== undefined ? { timeLimit: opts.timeLimit } : {}),
      descriptor: {
        runId: brief.runId,
        role,
        objective: this.deps.redaction.redact(brief.objective),
        ...(opts.delegationId !== undefined ? { delegationId: opts.delegationId } : {}),
        ...(opts.denyTools?.length ? { denyTools: opts.denyTools } : {}),
      },
    });
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await session.dispose();
    };
    const feedbackOf = (feedback: string) => assembleSidekickFeedback(this.deps.redaction, feedback, restated);
    const askAgain: SidekickSession["ask"] = async (instruction, askOpts) => {
      if (disposed) return unansweredTurn(brief, { kind: SESSION_GONE });
      const followUp = feedbackOf(instruction);
      try {
        return resultOf(await submitTurn(session, followUp.text, { sectionSizes: followUp.sectionSizes, ...(followUp.sectionHashes ? { sectionHashes: followUp.sectionHashes } : {}), promptStablePrefixBytes: followUp.stablePrefixBytes, ...(askOpts?.timeoutMs !== undefined ? { timeoutMs: askOpts.timeoutMs, ...(askOpts.timeLimit !== undefined ? { timeLimit: askOpts.timeLimit } : {}) } : {}) }, contract));
      } catch (err) {
        if (isRunDeadlineError(err)) throw err;
        const end = turnEndOf(err);
        if (end.kind === SESSION_GONE) await dispose();
        return unansweredTurn(brief, end);
      }
    };
    const restated = `Report your result with ${SUBMIT_TOOL.RESULT}, for delegationId=${brief.delegationId} runId=${brief.runId}.`;
    try {
      const assembled = render(brief);
      /* A fresh session that has seen nothing gets the brief and any feedback in one prompt: answering the brief on its own first would spend the flow's budget on work that is then thrown away. */
      const feedback = opts.feedback ? feedbackOf(opts.feedback) : undefined;
      const text = feedback ? [assembled.text, feedback.text].join("\n\n") : assembled.text;
      const sectionSizes = { ...assembled.sectionSizes, ...feedback?.sectionSizes };
      const sectionHashes = { ...assembled.sectionHashes, ...feedback?.sectionHashes };
      const turn = await submitTurn(
        session,
        text,
        {
          sectionSizes,
          ...(Object.keys(sectionHashes).length > 0 ? { sectionHashes } : {}),
          ...(assembled.stablePrefixBytes !== undefined ? { promptStablePrefixBytes: assembled.stablePrefixBytes } : {}),
          ...(assembled.sectionsDegraded !== undefined ? { sectionsDegraded: assembled.sectionsDegraded } : {}),
          ...(opts.contextFit ? { contextFit: opts.contextFit } : {}),
        },
        contract,
      );
      return { first: resultOf(turn), ask: askAgain, dispose };
    } catch (err) {
      if (!opts.keepUnanswered || isRunDeadlineError(err)) {
        await dispose();
        throw err;
      }
      const end = turnEndOf(err, opts.signal);
      if (end.kind === SESSION_GONE) await dispose();
      return { first: unansweredTurn(brief, end), ask: askAgain, dispose };
    }
  }
}
