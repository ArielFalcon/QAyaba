/* Sidekick executor: owns an AgentRuntimePort session for one DelegationBrief. Does not modify GenerateTestsUseCase. Model names stay out of this module — callers pass OpenSessionOpts.model for escalated capacity from external config. Free-form DelegationResult fields are scrubbed on parse — they re-enter lead context / notes. filesChanged paths are authority inputs (scope check, on-disk adoption) and stay raw; they are scrubbed only where echoed into a summary or concern. */
import type { ContextFit } from "@kernel/context-budget.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { assembleDefs, type AssembledPrompt, type WindowFitOutcome } from "@kernel/prompt-sections.ts";
import { FEEDBACK_SECTIONS } from "./coordination-sections/feedback-sections.ts";
import { delegatingKindSpec, type SidekickKind } from "./sidekick-kinds.ts";

export interface SidekickRender {
  (brief: DelegationBrief): { text: string; sectionSizes: Record<string, number>; sectionHashes?: Record<string, string>; stablePrefixBytes?: number };
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
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  feedback?: string;
  /** The flow of a plan the session is opened for: the run_spec loop and the browser share the flow's own are found by it. */
  delegationId?: string;
  /** Tools the session's prompts are denied, whatever the sidekick's configuration allows. */
  denyTools?: readonly string[];
  /** How the brief fits the window of the model the session runs on, for the first turn's telemetry. */
  contextFit?: ContextFit;
  /** The window fit rule of the model the session runs on: the brief is rendered with it, so a brief over the window gives its degradable sections up as references. Absent, nothing is degraded. */
  fit?: (bytes: number) => WindowFitOutcome;
}

/* A sidekick's session, held open after its first answer so that the lead's follow-up reaches the session that did the work. */
export interface SidekickSession {
  /* What the brief's prompt came to. */
  readonly first: DelegationResult;
  /* Asks the same session again; the answer is read as the first one was. */
  ask(instruction: string, opts?: { timeoutMs?: number }): Promise<DelegationResult>;
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
    const read = (output: string): DelegationResult => spec.parse(this.deps.redaction, output, brief);
    const session = await this.deps.runtime.openSession(role, opts.cwd, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      model: opts.model,
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
    const feedbackOf = (feedback: string) => assembleSidekickFeedback(this.deps.redaction, feedback, contract);
    const contract = `Respond with the SAME JSON output contract for delegationId=${brief.delegationId} runId=${brief.runId}.`;
    try {
      const assembled = render(brief);
      /* A fresh session that has seen nothing gets the brief and any feedback in one prompt: answering the brief on its own first would spend the flow's budget on work that is then thrown away. */
      const feedback = opts.feedback ? feedbackOf(opts.feedback) : undefined;
      const text = feedback ? [assembled.text, feedback.text].join("\n\n") : assembled.text;
      const sectionSizes = { ...assembled.sectionSizes, ...feedback?.sectionSizes };
      const sectionHashes = { ...assembled.sectionHashes, ...feedback?.sectionHashes };
      const { output } = await session.prompt(text, {
        sectionSizes,
        ...(Object.keys(sectionHashes).length > 0 ? { sectionHashes } : {}),
        ...(assembled.stablePrefixBytes !== undefined ? { promptStablePrefixBytes: assembled.stablePrefixBytes } : {}),
        ...(opts.contextFit ? { contextFit: opts.contextFit } : {}),
      });
      const first = read(output);
      return {
        first,
        ask: async (instruction, askOpts) => {
          const followUp = feedbackOf(instruction);
          const answer = await session.prompt(followUp.text, { sectionSizes: followUp.sectionSizes, ...(followUp.sectionHashes ? { sectionHashes: followUp.sectionHashes } : {}), promptStablePrefixBytes: followUp.stablePrefixBytes, ...(askOpts?.timeoutMs !== undefined ? { timeoutMs: askOpts.timeoutMs } : {}) });
          return read(answer.output);
        },
        dispose,
      };
    } catch (err) {
      await dispose();
      throw err;
    }
  }
}
