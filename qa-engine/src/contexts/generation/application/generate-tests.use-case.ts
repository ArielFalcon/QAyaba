/* Generate-tests use case. Review is fail-closed: an unparseable verdict is approved:false. A parse miss (parsed:false) is distinct from an explicit rejection. One bounded generator repair and one bounded reviewer repair. Every generation ends in exactly one classified way (GenerationResult.end): with specs the run continues, without them the end says why. */
import type { AgentRuntimePort, AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
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
import { classifyGenerationEnd, renderGenerationNote } from "../domain/generation-end.ts";

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
}

export interface GenerationResult {
  specs: string[];
  specMetas?: ManifestEntry[];
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

export class GenerateTestsUseCase {
  constructor(private readonly ports: GenerationPorts) {}

  /* Generate E2E tests for a single input. Orchestrates the deterministic shell: 1. Build the generation prompt (via PromptRenderingPort). 2. Open a session and fire the prompt (via AgentRuntimePort). 3. Check generator contract; if invalid, fire ONE bounded repair re-prompt. 4. Parse the deliverable (via VerdictParserPort). 5. Reconcile the manifest (via ManifestRepositoryPort). 6. If needsReview: open a reviewer session, parse the reviewer verdict, fire ONE bounded repair re-prompt on valid:false, apply the fail-closed gate. */
  async generate(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult> {
    const { runtime, rendering, verdicts, manifest, repair } = this.ports;

    const assembled = rendering.renderMain(input);

    const generatorRole: AgentRole = "primary";
    const session = await runtime.openSession(generatorRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      descriptor: { runId: input.runId, role: "qa-generator" },
    });
    let generatorOutput: string;
    let mainTurn: AgentTurnStats | undefined;
    let repairTurn: AgentTurnStats | undefined;
    try {
      /* The verdict is read from the final step's text alone: what the agent recalled or quoted on the way is not its conclusion. */
      const result = await session.prompt(assembled.text, {
        sectionSizes: assembled.sectionSizes,
        finalStepOnly: true,
        onTurnStats: (stats) => { mainTurn = stats; },
      });
      generatorOutput = result.output;

      /* A session that ran out of steps is never asked to re-emit its verdict: it cannot act on the request. */
      if (repair && mainTurn?.exhausted !== true) {
        const genCheck = repair.checkGenerator(generatorOutput);
        if (!genCheck.valid) {
          opts?.onRepair?.();
          const repairResult = await session.prompt(
            repair.instruction("generator", genCheck.issues, { priorResponseTail: generatorOutput }),
            { isRepair: true, finalStepOnly: true, onTurnStats: (stats) => { repairTurn = stats; } },
          );
          generatorOutput = repairResult.output;
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
    const reconciledEntries = input.target === "code" ? rawEntries : await manifest.reconcile(specDir, rawEntries);

    const end = classifyGenerationEnd({
      specCount: deliverable.specs.length,
      parsed: deliverable.parsed !== false,
      noopReason: deliverable.noopReason,
      exhausted: mainExhausted || repairExhausted,
    });
    const note = noteFor(end, deliverable, mainTurn, mainExhausted ? false : repairExhausted);
    const outcome = { end, note, ...(mainTurn ? { turn: mainTurn } : {}) };

    if (!input.needsReview) {
      return {
        specs: deliverable.specs,
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
    };
    const reviewerAssembled = rendering.renderReviewer(reviewerInput);
    const reviewerSession = await runtime.openSession(reviewerRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      descriptor: { runId: input.runId, role: "qa-reviewer" },
    });
    let reviewJudgment;
    try {
      const reviewOut = await reviewerSession.prompt(reviewerAssembled.text, { sectionSizes: reviewerAssembled.sectionSizes });
      let reviewText = reviewOut.output;

      let v = verdicts.parseReview(reviewText);
      if (!v.valid && repair) {
        opts?.onRepair?.();
        const repaired = await reviewerSession.prompt(
          repair.instruction("reviewer", v.issues, { priorResponseTail: reviewText }),
          { isRepair: true },
        );
        reviewText = repaired.output;
        v = verdicts.parseReview(reviewText);
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
      return deliverable.note;
  }
}
