/* Generate-tests use case. One bounded generator repair. Every generation ends in exactly one classified way (GenerationResult.end): with specs the run continues, without them the end says why. */
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { AgentRuntimePort, AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import { AUTHOR_SIDEKICK, LEAD_AGENT, openSidekickSession } from "@kernel/sidekick-session.ts";
import type { LeadSubmission, LeadTurnOpts } from "@kernel/plan-output.ts";
import { describeNoSubmission, type SubmissionContract, type SubmittedTurn } from "@kernel/submission.ts";
import { submitTurn } from "@kernel/submit-turn.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";
import type { PromptRenderingPort } from "./ports/prompt-rendering.port.ts";
import type { VerdictParserPort } from "./ports/verdict-parser.port.ts";
import type { ManifestRepositoryPort } from "./ports/manifest-repository.port.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { GeneratorDeliverable } from "../domain/manifest-repository.ts";
import type { OpencodeRunInput } from "../domain/opencode-run-input.ts";
import { isAgentTimeoutError } from "@kernel/domain-error.ts";
import { classifyGenerationEnd, renderGenerationNote } from "../domain/generation-end.ts";
import { declareSpecs } from "../domain/declared-specs.ts";
import { isReGenTurn } from "../domain/regen-turn.ts";
import { promptFactsOpts } from "../domain/prompt-facts.ts";
import { REPAIR_TURN_TIMEOUT_MS, renderRepairTimeoutNote } from "../domain/repair-turn.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";

export interface RepairPort {
  checkGenerator(text: string): { valid: boolean; issues: string[] };
  instruction(kind: "generator" | "reviewer", issues: string[], opts?: { priorResponseTail?: string }): string;
}

export interface AuthoringPorts {
  runtime: AgentRuntimePort;
  rendering: PromptRenderingPort;
  verdicts: VerdictParserPort;
  manifest: ManifestRepositoryPort;

  repair?: RepairPort;
  /** The longest one contract-repair prompt may run, whatever time is left. Absent: `REPAIR_TURN_TIMEOUT_MS`. */
  repairTimeoutMs?: number;
}

export interface GenerationResult {
  specs: string[];
  specMetas?: ManifestEntry[];
  /** What the verdict declares for the specs it delivered (flow, objective), one entry per spec, the verdict's own word and not what the manifest kept: what the run carries forward into its regenerations. Absent when no spec was delivered. `specMetas` is the manifest's side of it, for publication. */
  declaredSpecs?: DeliveredSpec[];
  /** For a generation that ended without specs, the explanation the run records: the agent's own reason for a declared no-op, otherwise what happened, what the turn measured and the end of its output. */
  note?: string;
  /* parsed: did the GENERATOR emit a parseable closing verdict at all (VerdictParserPort.parseGenerator's own `parsed`)? FALSE means the agent runtime returned no usable output — an empty/errored session (provider quota exhausted, timeout, model refusal, runtime outage), NOT a deliberate agent no-op. */
  parsed?: boolean;
  /** How the generation ended. Only a declared no-op is a decision to write nothing; a generation that ran out of steps or decided nothing never reads as one. */
  end: GenerationEndKind;
  /** For a declared no-op, the reason the verdict named (`noop.kind`), `unspecified` when it named none. Absent for every other end. */
  noopKind?: NoopKind;
  /** What the generation's MAIN turn measured, when its runtime can measure a turn. */
  turn?: AgentTurnStats;
  /** The generator's typed claim that the test is correct; a claim, never evidence. Absent unless the verdict carried one. */
  testCorrect?: { cause: "env" | "app"; reason: string };
  /** The findings the generator disputes instead of correcting, each with the basis the run checks. Absent unless the verdict carried one. */
  rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[];
}

export interface GenerateOpts {
  signal?: AbortSignal;
  onRepair?: () => void;
}

/**
 * What a planning turn came to. `plan` is the submission the lead's contract accepted, untrusted beyond that check: the
 * orchestrator's admission reads it again under the run's time. A turn that delivered none, even after its one continuation, says
 * why in `noSubmission`. `timedOut` is a turn that ran out of its planning time.
 */
export interface PlanResult {
  plan?: Record<string, unknown>;
  noSubmission?: string;
  timedOut: boolean;
  /** What the turn measured, when its runtime can measure a turn. */
  turn?: AgentTurnStats;
  /** The lead's session, held open whenever the turn answered: the lead's next turn (the plan's amendment, its review of the flows) is asked in it, read-only like the plan. The holder disposes it. */
  lead?: LeadSession;
}

/* The lead's planning session, held open for its next turn. */
export interface LeadSession {
  /* Asks the lead again, read-only, for the answer of one contract; a turn that runs out of its time answers `timedOut`, one that delivers none says why. */
  askSubmitting<T>(text: string, opts: LeadTurnOpts, contract: SubmissionContract<T>): Promise<LeadSubmission<T>>;
  /* Asks the lead again for its plan, read-only, through the plan contract as a planning turn is: a plan the contract accepted, or why none was delivered. */
  askForPlan(text: string, opts: LeadTurnOpts): Promise<{ plan?: Record<string, unknown>; noSubmission?: string; timedOut: boolean }>;
  /* Ends the session. Idempotent. */
  dispose(): Promise<void>;
}

export class GenerateTestsUseCase {
  constructor(private readonly ports: AuthoringPorts) {}

  /**
   * The one turn a coordinated run asks its lead for a plan instead of specs. One prompt in one lead session, bounded by the
   * planning time, in which the agent may read and look things up but not write; no reviewer, no manifest. The plan is delivered by
   * the lead's submit tool and judged by the plan contract inside the turn; a turn that delivers none gets one continuation
   * (`submitTurn`) and is then reported with its reason. A turn that runs out of its time is reported, not thrown (the coordinator
   * then refuses the run: `plan-timed-out`); any other fault is thrown. A turn that answered keeps its session open (`lead`):
   * the plan's amendment and the review of the flows are asked there. A turn that timed out or faulted closes it.
   */
  async plan(input: OpencodeRunInput, opts?: GenerateOpts): Promise<PlanResult> {
    const planning = input.planning;
    if (!planning) throw new Error("GenerateTestsUseCase.plan needs input.planning: the limits the plan will be held to");
    const contract = planning.submit;
    if (!contract) throw new Error("GenerateTestsUseCase.plan needs input.planning.submit: the contract the plan is delivered through");
    const assembled = this.ports.rendering.renderMain(input);
    const session = await openSidekickSession(this.ports.runtime, LEAD_AGENT, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      timeoutMs: planning.budgetMs,
      timeLimit: "plan-budget",
      descriptor: { runId: input.runId },
    });
    let turn: AgentTurnStats | undefined;
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await session.dispose();
    };
    const submitted = (result: SubmittedTurn<Record<string, unknown>>): { plan?: Record<string, unknown>; noSubmission?: string } =>
      result.submitted ? { plan: result.value } : { noSubmission: describeNoSubmission(result) };
    let first: SubmittedTurn<Record<string, unknown>>;
    try {
      first = await submitTurn(
        session,
        assembled.text,
        {
          sectionSizes: assembled.sectionSizes,
          ...promptFactsOpts(assembled),
          ...(assembled.providedPaths ? { providedPaths: assembled.providedPaths } : {}),
          ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}),
          withoutWrites: true,
          timeoutMs: planning.budgetMs,
          timeLimit: "plan-budget",
          onTurnStats: (stats) => { turn = stats; },
        },
        contract,
      );
    } catch (err) {
      await dispose();
      if (!isAgentTimeoutError(err)) throw err;
      return { timedOut: true, ...(turn ? { turn } : {}) };
    }
    const askSubmitting: LeadSession["askSubmitting"] = async (text, askOpts, asked) => {
      try {
        const again = await submitTurn(
          session,
          text,
          {
            withoutWrites: true,
            timeoutMs: askOpts.timeoutMs,
            timeLimit: askOpts.timeLimit ?? "plan-budget",
            ...(askOpts.sectionSizes ? { sectionSizes: askOpts.sectionSizes } : {}),
            ...(askOpts.sectionHashes ? { sectionHashes: askOpts.sectionHashes } : {}),
          },
          asked,
        );
        return again.submitted ? { value: again.value, timedOut: false } : { noSubmission: describeNoSubmission(again), timedOut: false };
      } catch (err) {
        if (!isAgentTimeoutError(err)) throw err;
        return { timedOut: true };
      }
    };
    const lead: LeadSession = {
      askSubmitting,
      askForPlan: async (text, askOpts) => {
        const again = await askSubmitting(text, askOpts, contract);
        return { ...(again.value !== undefined ? { plan: again.value } : {}), ...(again.noSubmission !== undefined ? { noSubmission: again.noSubmission } : {}), timedOut: again.timedOut };
      },
      dispose,
    };
    return { ...submitted(first), timedOut: false, ...(turn ? { turn } : {}), lead };
  }

  /* One turn of an author sidekick over a run's own authoring. Orchestrates the deterministic shell: 1. Build the authoring prompt (via PromptRenderingPort). 2. Open a session of the author kind and fire the prompt (via AgentRuntimePort); every turn opens a session of its own, so a regeneration is told everything it needs. 3. Check generator contract; if invalid, fire ONE bounded repair re-prompt. 4. Parse the deliverable (via VerdictParserPort). 5. Reconcile the manifest (via ManifestRepositoryPort). The independent review is the `review` sidekick kind, dispatched by the run's review step. */
  async author(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult> {
    const { runtime, rendering, verdicts, manifest, repair } = this.ports;

    const assembled = rendering.renderMain(input);

    /* The first pass states no time of its own: the run deadline's runtime holds it to what the run allots the generate purpose and names that bound when it ends the turn, and the stall watchdog and the step cap end a turn that is stuck. */
    const session = await openSidekickSession(runtime, AUTHOR_SIDEKICK, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      descriptor: { runId: input.runId },
    });
    let generatorOutput = "";
    let mainTurn: AgentTurnStats | undefined;
    let repairTurn: AgentTurnStats | undefined;
    /* The repair prompt ran past its own cap: the first turn's output stands and says nothing readable. */
    let repairTimedOutMs: number | undefined;
    const repairCapMs = this.ports.repairTimeoutMs ?? REPAIR_TURN_TIMEOUT_MS;
    try {
      /* The verdict is read from the final step's text alone: what the agent recalled or quoted on the way is not its conclusion. */
      const result = await session.prompt(assembled.text, {
        sectionSizes: assembled.sectionSizes,
        ...promptFactsOpts(assembled),
        ...(assembled.providedPaths ? { providedPaths: assembled.providedPaths } : {}),
        ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}),
        finalStepOnly: true,
        onTurnStats: (stats) => { mainTurn = stats; },
      });
      generatorOutput = result.output;

      /* A session that ran out of steps is never asked to re-emit its verdict: it cannot act on the request. The repair runs in the same session under the same step limit, so it is sent the number the prompt it repairs stated. */
      if (repair && mainTurn?.exhausted !== true) {
        const genCheck = repair.checkGenerator(generatorOutput);
        if (!genCheck.valid) {
          opts?.onRepair?.();
          try {
            const repairResult = await session.prompt(
              repair.instruction("generator", genCheck.issues, { priorResponseTail: generatorOutput }),
              { isRepair: true, withoutTools: true, ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}), finalStepOnly: true, timeoutMs: repairCapMs, timeLimit: "repair-cap", onTurnStats: (stats) => { repairTurn = stats; } },
            );
            generatorOutput = repairResult.output;
          } catch (err) {
            /* The first turn's output stands: a repair that did not finish changes nothing it said. */
            if (!isAgentTimeoutError(err)) throw err;
            repairTimedOutMs = repairCapMs;
            engineLog.error(`[qa] the generator's contract-repair turn timed out after ${repairCapMs}ms (tools disabled); its first answer stands`);
          }
        }
      }
    } finally {
      await session.dispose();
    }
    /* Only a turn known to have hit its limit counts: an unknown exhaustion is not exhaustion. */
    const mainExhausted = mainTurn?.exhausted === true;
    const repairExhausted = repairTurn?.exhausted === true;

    /* Spec paths are suite-relative (as the runner reports failing files). */
    const specDir = `${input.mirrorDir}/${input.e2eRelDir}`;
    const deliverable = verdicts.parseGenerator(generatorOutput, specDir);

    /* A spec in specs[] with no specMetas[] entry gets no manifest row — silent, because the spec file is what execution needs. */
    /* mutation-scope:begin intent-change-type */
    const changeType = input.intent?.type ?? "unknown";
    const rawEntries: ManifestEntry[] = (deliverable.specMetas ?? []).map((m) => ({
    /* mutation-scope:end intent-change-type */
      id: m.flow,
      file: m.file,
      flow: m.flow,
      objective: m.objective,
      targets: m.targets,
      changeRef: { sha: input.sha, type: changeType },
      ...(m.sha256 ? { sha256: m.sha256 } : {}),
    }));
    const reconciledEntries = await manifest.reconcile({ mirrorDir: input.mirrorDir, specDir }, rawEntries);

    const end = classifyGenerationEnd({
      specCount: deliverable.specs.length,
      parsed: deliverable.parsed !== false,
      noopReason: deliverable.noopReason,
      exhausted: mainExhausted || repairExhausted,
    });
    const endNote = noteFor(end, deliverable, mainTurn, mainExhausted ? false : repairExhausted);
    /* A repair that timed out explains an end that has no specs to show for it; with specs delivered, or a no-op declared, it changed nothing. */
    const note = repairTimedOutMs !== undefined && (end === GENERATION_END.NO_VERDICT || end === GENERATION_END.UNDECIDED_EMPTY)
      ? [endNote, renderRepairTimeoutNote(repairTimedOutMs)].filter(Boolean).join(" ")
      : endNote;
    const outcome = {
      end,
      note,
      /* The kind the declared no-op names (`unspecified` when its verdict names none): recorded with the run, read by nothing that decides it. */
      ...(end === GENERATION_END.DECLARED_NOOP && deliverable.noopKind ? { noopKind: deliverable.noopKind } : {}),
      ...(mainTurn ? { turn: mainTurn } : {}),
    };
    /* The verdict's own declarations, read before the manifest drops anything: a spec the reviewer rejects, or one the manifest cannot hash, is still a spec the run delivered. */
    const declaredSpecs = declareSpecs(deliverable.specs, deliverable.specMetas);
    const declared = declaredSpecs.length > 0 ? { declaredSpecs } : {};

    return {
      specs: deliverable.specs,
      specMetas: reconciledEntries,
      ...declared,
      parsed: deliverable.parsed,
      ...(deliverable.testCorrect ? { testCorrect: deliverable.testCorrect } : {}),
      ...(deliverable.rebuttals?.length ? { rebuttals: deliverable.rebuttals } : {}),
      ...outcome,
    };
  }
}

/** The note a generation carries: an explanation for the ends that stop a run without specs, otherwise whatever the agent noted. */
function noteFor(end: GenerationEndKind, deliverable: GeneratorDeliverable, turn: AgentTurnStats | undefined, repairExhausted: boolean): string | undefined {
  switch (end) {
    case GENERATION_END.DECLARED_NOOP:
      return renderGenerationNote({ end, noopReason: deliverable.noopReason ?? "" });
    case GENERATION_END.EXHAUSTED:
    case GENERATION_END.UNDECIDED_EMPTY:
      return renderGenerationNote({ end, ...(turn ? { turn } : {}), outputTail: deliverable.outputTail ?? "", repairExhausted });
    case GENERATION_END.DELIVERED:
    case GENERATION_END.NO_VERDICT:
    /* A time-budget end is worded by the caller, which holds the budget; it never reaches here. */
    case GENERATION_END.TIME_BUDGET:
      return deliverable.note;
  }
}
