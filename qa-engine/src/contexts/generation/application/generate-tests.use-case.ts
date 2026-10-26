/* Generate-tests use case. One bounded generator repair. Every generation ends in exactly one classified way (GenerationResult.end): with specs the run continues, without them the end says why. */
import type { AgentRuntimePort, AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import { AUTHOR_SIDEKICK, LEAD_AGENT, openSidekickSession } from "@kernel/sidekick-session.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";
import type { PromptRenderingPort } from "./ports/prompt-rendering.port.ts";
import type { VerdictParserPort } from "./ports/verdict-parser.port.ts";
import type { ManifestRepositoryPort } from "./ports/manifest-repository.port.ts";
import type { PromptBudgetPort } from "./ports/prompt-budget.port.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { GeneratorDeliverable } from "../domain/manifest-repository.ts";
import type { OpencodeRunInput } from "../domain/opencode-run-input.ts";
import { isAgentTimeoutError } from "@kernel/domain-error.ts";
import { classifyGenerationEnd, renderGenerationNote } from "../domain/generation-end.ts";
import { declareSpecs } from "../domain/declared-specs.ts";
import { diffStat } from "../../../shared-kernel/diff-stat.ts";
import { generatorTimeBudgetMs, type DiffTimeBudgets } from "../domain/generator-time-budget.ts";
import { isReGenTurn } from "../domain/regen-turn.ts";
import { promptFactsOpts } from "../domain/prompt-facts.ts";
import { REPAIR_TURN_TIMEOUT_MS, renderRepairTimeoutNote, repairTurnLimit } from "../domain/repair-turn.ts";
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
  /** The run's deadline, when the host states one: the first pass is never given more time than it leaves. */
  deadline?: { allowance?(purpose: "first-pass"): number | null };
  onRepair?: () => void;
}

/**
 * What a planning turn came to. `plan` is the object the lead's verdict carried, untrusted: the orchestrator's admission is its
 * only reader. `noopReason` is the reason the lead gave for writing nothing when it declared that instead of planning. A turn
 * that gives neither is `parsed` when its verdict could be read at all. `timedOut` is a turn that ran out of its planning time.
 */
export interface PlanResult {
  plan?: Record<string, unknown>;
  /** The questions the lead asked the explore sidekicks instead of planning: the raw array, untrusted. */
  explore?: unknown[];
  noopReason?: string;
  parsed: boolean;
  timedOut: boolean;
  /** What the turn measured, when its runtime can measure a turn. */
  turn?: AgentTurnStats;
  /** The lead's session, held open when the turn came back with a plan: the lead's next turn (its review of the flows) is asked in it, read-only like the plan. The holder disposes it. */
  lead?: LeadSession;
}

/* The lead's planning session, held open for its next turn. */
export interface LeadSession {
  /* Asks the lead again, read-only; a turn that runs out of its time answers `timedOut` with no output. */
  ask(text: string, opts: { timeoutMs: number }): Promise<{ output: string; timedOut: boolean }>;
  /* Asks the lead again for its plan, read-only, and reads the answer as a planning turn is read: a plan, a declared no-op, a second exploration request, or an answer no verdict could be read from. */
  askForPlan(text: string, opts: { timeoutMs: number }): Promise<{ plan?: Record<string, unknown>; explore?: unknown[]; noopReason?: string; parsed: boolean; timedOut: boolean }>;
  /* Ends the session. Idempotent. */
  dispose(): Promise<void>;
}

export class GenerateTestsUseCase {
  constructor(private readonly ports: AuthoringPorts) {}

  /**
   * The one turn a coordinated run asks its lead for a plan instead of specs. One prompt in one generator session, bounded by the
   * planning time, in which the agent may read and look things up but not write; no reviewer, no repair, no manifest. A turn that
   * runs out of its time is reported, not thrown (the coordinator then refuses the run: `plan-timed-out`); any other fault is thrown. A turn that
   * came back with a plan keeps its session open (`lead`) for the lead's review of the flows; every other turn closes it.
   */
  async plan(input: OpencodeRunInput, opts?: GenerateOpts): Promise<PlanResult> {
    const planning = input.planning;
    if (!planning) throw new Error("GenerateTestsUseCase.plan needs input.planning: the limits the plan will be held to");
    const assembled = this.ports.rendering.renderMain(input);
    const session = await openSidekickSession(this.ports.runtime, LEAD_AGENT, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      timeoutMs: planning.budgetMs,
      timeLimit: "prompt-budget",
      descriptor: { runId: input.runId },
    });
    let output = "";
    let turn: AgentTurnStats | undefined;
    let timedOut = false;
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await session.dispose();
    };
    try {
      const result = await session.prompt(assembled.text, {
        sectionSizes: assembled.sectionSizes,
        ...promptFactsOpts(assembled),
        ...(assembled.providedPaths ? { providedPaths: assembled.providedPaths } : {}),
        ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}),
        finalStepOnly: true,
        withoutWrites: true,
        timeoutMs: planning.budgetMs,
        timeLimit: "prompt-budget",
        onTurnStats: (stats) => { turn = stats; },
      });
      output = result.output;
    } catch (err) {
      await dispose();
      if (!isAgentTimeoutError(err)) throw err;
      timedOut = true;
    }
    if (timedOut) return { parsed: false, timedOut: true, ...(turn ? { turn } : {}) };
    let deliverable: ReturnType<AuthoringPorts["verdicts"]["parseGenerator"]>;
    try {
      deliverable = this.ports.verdicts.parseGenerator(output, `${input.mirrorDir}/${input.e2eRelDir}`);
    } catch (err) {
      await dispose();
      throw err;
    }
    /* Only a plan or a request to explore has a next turn to ask: anything else ends the session here. */
    const continues = Boolean(deliverable.plan ?? deliverable.explore);
    if (!continues) await dispose();
    const ask: LeadSession["ask"] = async (text, askOpts) => {
      try {
        const answer = await session.prompt(text, { finalStepOnly: true, withoutWrites: true, timeoutMs: askOpts.timeoutMs, timeLimit: "prompt-budget" });
        return { output: answer.output, timedOut: false };
      } catch (err) {
        if (!isAgentTimeoutError(err)) throw err;
        return { output: "", timedOut: true };
      }
    };
    const lead: LeadSession | undefined = continues
      ? {
          ask,
          askForPlan: async (text, askOpts) => {
            const answer = await ask(text, askOpts);
            if (answer.timedOut) return { parsed: false, timedOut: true };
            const next = this.ports.verdicts.parseGenerator(answer.output, `${input.mirrorDir}/${input.e2eRelDir}`);
            return {
              ...(next.plan ? { plan: next.plan } : {}),
              ...(next.explore ? { explore: next.explore } : {}),
              ...(next.noopReason ? { noopReason: next.noopReason } : {}),
              parsed: next.parsed !== false,
              timedOut: false,
            };
          },
          dispose,
        }
      : undefined;
    return {
      ...(deliverable.plan ? { plan: deliverable.plan } : {}),
      ...(deliverable.explore ? { explore: deliverable.explore } : {}),
      ...(deliverable.noopReason ? { noopReason: deliverable.noopReason } : {}),
      parsed: deliverable.parsed !== false,
      timedOut: false,
      ...(turn ? { turn } : {}),
      ...(lead ? { lead } : {}),
    };
  }

  /* One turn of an author sidekick over a run's own authoring. Orchestrates the deterministic shell: 1. Build the authoring prompt (via PromptRenderingPort). 2. Open a session of the author kind and fire the prompt (via AgentRuntimePort); every turn opens a session of its own, so a regeneration is told everything it needs. 3. Check generator contract; if invalid, fire ONE bounded repair re-prompt. 4. Parse the deliverable (via VerdictParserPort). 5. Reconcile the manifest (via ManifestRepositoryPort). The independent review is the `review` sidekick kind, dispatched by the run's review step. */
  async author(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult> {
    const { runtime, rendering, verdicts, manifest, repair } = this.ports;

    const assembled = rendering.renderMain(input);

    /* The wall time this first pass may take, from the change's size, which the step cap never bounds because a step can be arbitrarily long. A regeneration keeps the host's default: its callers read a turn without specs as "no fixes", and an expired budget must not hide there. */
    const tierBudgetMs = isReGenTurn(input)
      ? undefined
      : generatorTimeBudgetMs({
          mode: input.mode,
          stat: diffStat({ diff: input.diff, changedFiles: input.intent?.changedFiles }),
          ...(this.ports.promptCapMs !== undefined ? { capMs: this.ports.promptCapMs } : {}),
          ...(this.ports.timeBudgets ? { budgets: this.ports.timeBudgets } : {}),
        });
    /* The tier's time never outlives the run's: the smaller of the two bounds the pass. A tier that bounds nothing stays so, and the deadline's own runtime ends such a turn. */
    const runAllowanceMs = tierBudgetMs !== undefined ? opts?.deadline?.allowance?.("first-pass") ?? null : null;
    const timeBudgetMs = tierBudgetMs !== undefined && runAllowanceMs !== null ? Math.min(tierBudgetMs, runAllowanceMs) : tierBudgetMs;

    /* The budget bounds the whole first pass, the repair included: every prompt is given only what is left of it, and a prompt that finds none left is not sent. */
    const now = this.ports.now ?? Date.now;
    const deadline = timeBudgetMs !== undefined ? now() + timeBudgetMs : undefined;
    const remainingMs = (): number | undefined => (deadline !== undefined ? deadline - now() : undefined);
    const promptTime = (): { timeoutMs?: number; timeLimit?: "tier-budget" } => {
      const left = remainingMs();
      return left !== undefined ? { timeoutMs: left, timeLimit: "tier-budget" } : {};
    };

    const session = await openSidekickSession(runtime, AUTHOR_SIDEKICK, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(timeBudgetMs !== undefined ? { timeoutMs: timeBudgetMs, timeLimit: "tier-budget" as const } : {}),
      descriptor: { runId: input.runId },
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
          ...promptFactsOpts(assembled),
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
                { isRepair: true, withoutTools: true, ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}), finalStepOnly: true, timeoutMs: limit.timeoutMs, timeLimit: limit.boundByCaller ? "tier-budget" : "repair-cap", onTurnStats: (stats) => { repairTurn = stats; } },
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
