/* Generate-tests use case. Review is fail-closed: an unparseable verdict is approved:false. A parse miss (parsed:false) is distinct from an explicit rejection. One bounded generator repair and one bounded reviewer repair. Every generation ends in exactly one classified way (GenerationResult.end): with specs the run continues, without them the end says why. */
import type { AgentRuntimePort, AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";
import type {
  PromptRenderingPort,
  VerdictParserPort,
  ManifestRepositoryPort,
  PromptBudgetPort,
  ManifestEntry,
  GeneratorDeliverable,
} from "./ports/index.ts";
import type { OpencodeRunInput, ReviewInput } from "./ports/generation-ports.ts";
import { isAgentTimeoutError } from "@kernel/domain-error.ts";
import { classifyGenerationEnd, renderGenerationNote } from "../domain/generation-end.ts";
import { declareSpecs } from "../domain/declared-specs.ts";
import { diffStat } from "../domain/diff-stat.ts";
import { generationRunsReviewer } from "../domain/generation-review.ts";
import { generatorTimeBudgetMs, type DiffTimeBudgets } from "../domain/generator-time-budget.ts";
import { isReGenTurn } from "../domain/regen-turn.ts";
import { REPAIR_TURN_TIMEOUT_MS, renderRepairTimeoutNote, repairTurnLimit } from "../domain/repair-turn.ts";

export interface RepairPort {
  checkGenerator(text: string): { valid: boolean; issues: string[] };
  instruction(kind: "generator" | "reviewer", issues: string[], opts?: { priorResponseTail?: string }): string;
}

export interface GenerationPorts {
  runtime: AgentRuntimePort;
  rendering: PromptRenderingPort;
  verdicts: VerdictParserPort;
  manifest: ManifestRepositoryPort;

  budget: PromptBudgetPort;
  repair?: RepairPort;
  /** The longest a single prompt may run on this host: the deadline of its transport. A tier's time at or above it could never fire before that deadline, so no budget is set and a timeout there stays the host's. Absent: the host states none, and the budget is applied as the effort tier gives it. */
  promptCapMs?: number;
  /** The time each effort tier allows the first pass, as the composition root resolved it (operator overrides applied). Absent: the defaults. Still clamped by `promptCapMs`. */
  timeBudgets?: DiffTimeBudgets;
  /** The clock the first pass's deadline is read from, in milliseconds. Absent: the system clock. */
  now?: () => number;
  /** The longest one contract-repair prompt may run, whatever time is left. Absent: `REPAIR_TURN_TIMEOUT_MS`. */
  repairTimeoutMs?: number;
}

export interface GenerationResult {
  specs: string[];
  specMetas?: ManifestEntry[];
  /** What the verdict declares for the specs it delivered (flow, objective), one entry per spec, the verdict's own word and not what the manifest kept: what the run carries forward into its regenerations. Absent when no spec was delivered. `specMetas` is the manifest's side of it, for publication. */
  declaredSpecs?: DeliveredSpec[];
  approved: boolean;
  reviewed: boolean;
  /** For a generation that ended without specs, the explanation the run records: the agent's own reason for a declared no-op, otherwise what happened, what the turn measured and the end of its output. */
  note?: string;
  /* parsed: did the GENERATOR emit a parseable closing verdict at all (VerdictParserPort.parseGenerator's own `parsed`)? FALSE means the agent runtime returned no usable output — an empty/errored session (provider quota exhausted, timeout, model refusal, runtime outage), NOT a deliberate agent no-op. */
  parsed?: boolean;
  /** How the generation ended. Only a declared no-op is a decision to write nothing; a generation that ran out of steps or decided nothing never reads as one. */
  end: GenerationEndKind;
  /** What the generation's MAIN turn measured, when its runtime can measure a turn (Codex cannot). */
  turn?: AgentTurnStats;
}

export interface GenerateOpts {
  signal?: AbortSignal;
  onRepair?: () => void;
}

/**
 * What a planning turn came to. `plan` is the object the lead's verdict carried, untrusted: the orchestrator's admission is its
 * only reader. `noopReason` is the reason the lead gave for writing nothing when it declared that instead of planning. A turn
 * that gives neither is `parsed` when its verdict could be read at all. `timedOut` is a turn that ran out of its planning time.
 */
export interface PlanResult {
  plan?: Record<string, unknown>;
  noopReason?: string;
  parsed: boolean;
  timedOut: boolean;
  /** What the turn measured, when its runtime can measure a turn. */
  turn?: AgentTurnStats;
}

export class GenerateTestsUseCase {
  constructor(private readonly ports: GenerationPorts) {}

  /**
   * The one turn a coordinated run asks its lead for a plan instead of specs. One prompt in one generator session, bounded by the
   * planning time, in which the agent may read and look things up but not write; no reviewer, no repair, no manifest. A turn that
   * runs out of its time is reported, not thrown (the run then goes on as one piece of work); any other fault is thrown.
   */
  async plan(input: OpencodeRunInput, opts?: GenerateOpts): Promise<PlanResult> {
    const planning = input.planning;
    if (!planning) throw new Error("GenerateTestsUseCase.plan needs input.planning: the limits the plan will be held to");
    const assembled = this.ports.rendering.renderMain(input);
    const session = await this.ports.runtime.openSession("primary", input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      timeoutMs: planning.budgetMs,
      descriptor: { runId: input.runId, role: "qa-generator" },
    });
    let output = "";
    let turn: AgentTurnStats | undefined;
    let timedOut = false;
    try {
      const result = await session.prompt(assembled.text, {
        sectionSizes: assembled.sectionSizes,
        ...(assembled.providedPaths ? { providedPaths: assembled.providedPaths } : {}),
        ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}),
        finalStepOnly: true,
        withoutWrites: true,
        timeoutMs: planning.budgetMs,
        onTurnStats: (stats) => { turn = stats; },
      });
      output = result.output;
    } catch (err) {
      if (!isAgentTimeoutError(err)) throw err;
      timedOut = true;
    } finally {
      await session.dispose();
    }
    if (timedOut) return { parsed: false, timedOut: true, ...(turn ? { turn } : {}) };
    const deliverable = this.ports.verdicts.parseGenerator(output, `${input.mirrorDir}/${input.e2eRelDir}`);
    return {
      ...(deliverable.plan ? { plan: deliverable.plan } : {}),
      ...(deliverable.noopReason ? { noopReason: deliverable.noopReason } : {}),
      parsed: deliverable.parsed !== false,
      timedOut: false,
      ...(turn ? { turn } : {}),
    };
  }

  /* Generate E2E tests for a single input. Orchestrates the deterministic shell: 1. Build the generation prompt (via PromptRenderingPort). 2. Open a session and fire the prompt (via AgentRuntimePort). 3. Check generator contract; if invalid, fire ONE bounded repair re-prompt. 4. Parse the deliverable (via VerdictParserPort). 5. Reconcile the manifest (via ManifestRepositoryPort). 6. If the run reviews (needsReview, never in context mode): open a reviewer session, parse the reviewer verdict, fire ONE bounded repair re-prompt on valid:false, apply the fail-closed gate. */
  async generate(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult> {
    const { runtime, rendering, verdicts, manifest, repair } = this.ports;

    const assembled = rendering.renderMain(input);

    /* The wall time this first pass may take, from the change's size, which the step cap never bounds because a step can be arbitrarily long. A regeneration keeps the host's default: its callers read a turn without specs as "no fixes", and an expired budget must not hide there. */
    const timeBudgetMs = isReGenTurn(input)
      ? undefined
      : generatorTimeBudgetMs({
          mode: input.mode,
          stat: diffStat({ diff: input.diff, changedFiles: input.intent?.changedFiles }),
          ...(this.ports.promptCapMs !== undefined ? { capMs: this.ports.promptCapMs } : {}),
          ...(this.ports.timeBudgets ? { budgets: this.ports.timeBudgets } : {}),
        });

    /* The budget bounds the whole first pass, the repair included: every prompt is given only what is left of it, and a prompt that finds none left is not sent. */
    const now = this.ports.now ?? Date.now;
    const deadline = timeBudgetMs !== undefined ? now() + timeBudgetMs : undefined;
    const remainingMs = (): number | undefined => (deadline !== undefined ? deadline - now() : undefined);
    const promptTime = (): { timeoutMs?: number } => {
      const left = remainingMs();
      return left !== undefined ? { timeoutMs: left } : {};
    };

    const generatorRole: AgentRole = "primary";
    const session = await runtime.openSession(generatorRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(timeBudgetMs !== undefined ? { timeoutMs: timeBudgetMs } : {}),
      descriptor: { runId: input.runId, role: "qa-generator" },
    });
    let generatorOutput = "";
    let mainTurn: AgentTurnStats | undefined;
    let repairTurn: AgentTurnStats | undefined;
    /* The budget and the turn it cut off, when one did. Only a deadline the generator was given a budget for is this; any other timeout, a prompt that merely mentions one included, is the integration error it always was. */
    let timeCut: { budgetMs: number; repair: boolean } | undefined;
    /* The repair prompt ran past its own cap, with the first-pass budget (if any) to spare: the first turn's output stands and says nothing readable. */
    let repairTimedOutMs: number | undefined;
    const repairCapMs = this.ports.repairTimeoutMs ?? REPAIR_TURN_TIMEOUT_MS;
    const cutByBudget = (err: unknown, repair: boolean): { budgetMs: number; repair: boolean } | undefined =>
      timeBudgetMs !== undefined && isAgentTimeoutError(err) ? { budgetMs: timeBudgetMs, repair } : undefined;
    try {
      /* The verdict is read from the final step's text alone: what the agent recalled or quoted on the way is not its conclusion. */
      try {
        const result = await session.prompt(assembled.text, {
          sectionSizes: assembled.sectionSizes,
          ...(assembled.providedPaths ? { providedPaths: assembled.providedPaths } : {}),
          ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}),
          finalStepOnly: true,
          ...promptTime(),
          onTurnStats: (stats) => { mainTurn = stats; },
        });
        generatorOutput = result.output;
      } catch (err) {
        timeCut = cutByBudget(err, false);
        if (!timeCut) throw err;
      }

      /* A session that ran out of steps is never asked to re-emit its verdict: it cannot act on the request, and one that ran out of time has no time left to spend on it. The repair runs in the same session under the same limit, so it is sent the number the prompt it repairs stated. */
      if (repair && !timeCut && mainTurn?.exhausted !== true) {
        const genCheck = repair.checkGenerator(generatorOutput);
        if (!genCheck.valid) {
          const left = remainingMs();
          if (timeBudgetMs !== undefined && left !== undefined && left <= 0) {
            /* The main turn spent the whole budget: its output stands and there is no time to ask for more. */
            timeCut = { budgetMs: timeBudgetMs, repair: true };
          } else {
            opts?.onRepair?.();
            const limit = repairTurnLimit({ capMs: repairCapMs, ...(left !== undefined ? { leftMs: left } : {}) });
            try {
              const repairResult = await session.prompt(
                repair.instruction("generator", genCheck.issues, { priorResponseTail: generatorOutput }),
                { isRepair: true, withoutTools: true, ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}), finalStepOnly: true, timeoutMs: limit.timeoutMs, onTurnStats: (stats) => { repairTurn = stats; } },
              );
              generatorOutput = repairResult.output;
            } catch (err) {
              /* The first turn's output stands: a repair that did not finish changes nothing it said. */
              timeCut = limit.boundByCaller ? cutByBudget(err, true) : undefined;
              if (!timeCut) {
                if (!(isAgentTimeoutError(err) && !limit.boundByCaller)) throw err;
                repairTimedOutMs = limit.timeoutMs;
                console.error(`[qa] the generator's contract-repair turn timed out after ${limit.timeoutMs}ms (tools disabled); its first answer stands`);
              }
            }
          }
        }
      }
    } finally {
      await session.dispose();
    }
    /* Only a turn known to have hit its limit counts: an unknown exhaustion is not exhaustion. */
    const mainExhausted = mainTurn?.exhausted === true;
    const repairExhausted = repairTurn?.exhausted === true;

    /* Spec paths are suite-relative (as the runner reports failing files); a code-target run has no suite dir to resolve names against. */
    const specDir = `${input.mirrorDir}/${input.e2eRelDir}`;
    const deliverable = verdicts.parseGenerator(generatorOutput, input.target === "code" ? undefined : specDir);

    /* A spec in specs[] with no specMetas[] entry gets no manifest row — silent, because the spec file is what execution needs. */
    const changeType = input.intent?.type ?? "unknown";
    const rawEntries: ManifestEntry[] = (deliverable.specMetas ?? []).map((m) => ({
      id: m.flow,
      file: m.file,
      flow: m.flow,
      objective: m.objective,
      targets: m.targets,
      changeRef: { sha: input.sha, type: changeType },
      ...(m.sha256 ? { sha256: m.sha256 } : {}),
    }));
    const reconciledEntries = input.target === "code" ? rawEntries : await manifest.reconcile({ mirrorDir: input.mirrorDir, specDir }, rawEntries);

    const end = classifyGenerationEnd({
      specCount: deliverable.specs.length,
      parsed: deliverable.parsed !== false,
      noopReason: deliverable.noopReason,
      exhausted: mainExhausted || repairExhausted,
      timedOut: timeCut !== undefined,
    });
    const endNote = timeCut && end === GENERATION_END.TIME_BUDGET
      ? renderGenerationNote({ end, ...timeCut })
      : noteFor(end, deliverable, mainTurn, mainExhausted ? false : repairExhausted);
    /* A repair that timed out explains an end that has no specs to show for it; with specs delivered, or a no-op declared, it changed nothing. */
    const note = repairTimedOutMs !== undefined && (end === GENERATION_END.NO_VERDICT || end === GENERATION_END.UNDECIDED_EMPTY)
      ? [endNote, renderRepairTimeoutNote(repairTimedOutMs)].filter(Boolean).join(" ")
      : endNote;
    const outcome = { end, note, ...(mainTurn ? { turn: mainTurn } : {}) };
    /* The verdict's own declarations, read before the manifest drops anything: a spec the reviewer rejects, or one the manifest cannot hash, is still a spec the run delivered. */
    const declaredSpecs = declareSpecs(deliverable.specs, deliverable.specMetas);
    const declared = declaredSpecs.length > 0 ? { declaredSpecs } : {};

    /* A generation that ran out of time, or that declared a no-op, has no specs to review: the reviewer's session would be spent on nothing, and opening it after the run's time is spent would end a valid no-op as a time-budget error. */
    if (!generationRunsReviewer(input) || end === GENERATION_END.TIME_BUDGET || end === GENERATION_END.DECLARED_NOOP) {
      return {
        specs: deliverable.specs,
        ...declared,
        reviewed: false,
        approved: true,
        parsed: deliverable.parsed,
        ...outcome,
      };
    }

    /* ── 6. Independent reviewer session ────────────────────────────────────── The reviewer is the AUTHORITATIVE publish gate. Opens a SEPARATE session to guarantee independence — the generator cannot influence the reviewer. (mirrors reviewIndependently in opencode-client.ts:952-1009) */
    const reviewerRole: AgentRole = "reviewer";
    /* Ground this FIRST reviewer pass the same way review-port.adapter.ts grounds every regen
       pass (domSnapshot, learned rules, guidance, baseUrl, target), plus the full CommitIntent this
       use case holds, whose type the reviewer prompt names as the run type. The reviewer gets the
       reviewer render of the learned rules (proven rules only), never the generator render: the
       generator's unproven candidates must not become grounds for rejection at the publish gate. */
    const reviewerInput: ReviewInput = {
      diff: input.diff,
      specs: deliverable.specs,
      mirrorDir: input.mirrorDir,
      e2eRelDir: input.e2eRelDir,
      appName: input.appName,
      mode: input.mode,
      target: input.target,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.guidance ? { guidance: input.guidance } : {}),
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.reviewerLearnedRules ? { learnedRules: input.reviewerLearnedRules } : {}),
      ...(input.domSnapshot ? { domSnapshot: input.domSnapshot } : {}),
      /* The reviewer's session runs under a limit of its own: the generator's never stands in for it. */
      ...(input.reviewerStepLimit !== undefined ? { stepLimit: input.reviewerStepLimit } : {}),
    };
    const reviewerAssembled = rendering.renderReviewer(reviewerInput);
    const reviewerSession = await runtime.openSession(reviewerRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      descriptor: { runId: input.runId, role: "qa-reviewer" },
    });
    let reviewJudgment;
    try {
      const reviewOut = await reviewerSession.prompt(reviewerAssembled.text, {
        sectionSizes: reviewerAssembled.sectionSizes,
        ...(reviewerInput.stepLimit !== undefined ? { stepLimit: reviewerInput.stepLimit } : {}),
      });
      let reviewText = reviewOut.output;

      let v = verdicts.parseReview(reviewText);
      if (!v.valid && repair) {
        opts?.onRepair?.();
        try {
          const repaired = await reviewerSession.prompt(
            repair.instruction("reviewer", v.issues, { priorResponseTail: reviewText }),
            { isRepair: true, withoutTools: true, timeoutMs: repairCapMs, ...(reviewerInput.stepLimit !== undefined ? { stepLimit: reviewerInput.stepLimit } : {}) },
          );
          reviewText = repaired.output;
          v = verdicts.parseReview(reviewText);
        } catch (err) {
          /* The reviewer's first answer stands, unreadable: the gate below fails closed on it. Any other fault is an integration error and surfaces. */
          if (!isAgentTimeoutError(err)) throw err;
          console.error(`[qa] the reviewer's contract-repair turn timed out after ${repairCapMs}ms (tools disabled); its first answer stands`);
        }
      }

      reviewJudgment = v;
    } finally {
      await reviewerSession.dispose();
    }

    /* Apply the fail-closed gate: no parseable verdict → approved:false (parse miss, not a real rejection). blockingCount:0 (with parsed:true) → may approve. */
    const approved = reviewJudgment.parsed === false
      ? false
      : (reviewJudgment.blockingCount !== undefined
          ? reviewJudgment.blockingCount === 0 && reviewJudgment.approved
          : reviewJudgment.approved);

    return {
      specs: deliverable.specs,
      specMetas: reconciledEntries,
      ...declared,
      reviewed: true,
      approved,
      parsed: deliverable.parsed,
      ...outcome,
      note: approved ? outcome.note : (reviewJudgment.rationale ?? "the reviewer did not approve the E2E tests"),
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
