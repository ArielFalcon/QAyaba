/* Generate-tests use case. Review is fail-closed: an unparseable verdict is approved:false. A parse miss (parsed:false) is distinct from an explicit rejection. One bounded generator repair and one bounded reviewer repair. */
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type {
  PromptRenderingPort,
  VerdictParserPort,
  ManifestRepositoryPort,
  PromptBudgetPort,
  ManifestEntry,
} from "./ports/index.ts";
import type { OpencodeRunInput } from "./ports/generation-ports.ts";

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
  note?: string;
  /* parsed: did the GENERATOR emit a parseable closing verdict at all (VerdictParserPort.parseGenerator's own `parsed`)? FALSE means the agent runtime returned no usable output — an empty/errored session (provider quota exhausted, timeout, model refusal, runtime outage), NOT a deliberate agent no-op. The orchestrator uses this to keep the "approved + zero specs -> skipped" no-op invariant from swallowing a runtime failure into a silent "no test-worthy change" skip (surface-integration-errors -loudly invariant). */
  parsed?: boolean;
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
    try {
      const result = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes });
      generatorOutput = result.output;

      if (repair) {
        const genCheck = repair.checkGenerator(generatorOutput);
        if (!genCheck.valid) {
          opts?.onRepair?.();
          const repairResult = await session.prompt(
            repair.instruction("generator", genCheck.issues, { priorResponseTail: generatorOutput }),
            { isRepair: true },
          );
          generatorOutput = repairResult.output;
        }
      }
    } finally {
      await session.dispose();
    }

    const deliverable = verdicts.parseGenerator(generatorOutput);

    /* A spec in specs[] with no specMetas[] entry gets no manifest row — silent, because the spec file is what execution needs. */
    const specDir = `${input.mirrorDir}/${input.e2eRelDir}`;
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

    if (!input.needsReview) {
      return {
        specs: deliverable.specs,
        reviewed: false,
        approved: true,
        note: deliverable.note,
        parsed: deliverable.parsed,
      };
    }

    /* ── 6. Independent reviewer session ────────────────────────────────────── The reviewer is the AUTHORITATIVE publish gate. Opens a SEPARATE session to guarantee independence — the generator cannot influence the reviewer. (mirrors reviewIndependently in opencode-client.ts:952-1009) */
    const reviewerRole: AgentRole = "reviewer";
    const reviewerInput = {
      diff: input.diff,
      specs: deliverable.specs,
      mirrorDir: input.mirrorDir,
      e2eRelDir: input.e2eRelDir,
      appName: input.appName,
      mode: input.mode,
    };
    const reviewerAssembled = rendering.renderReviewer(reviewerInput as Parameters<typeof rendering.renderReviewer>[0]);
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
      note: approved ? undefined : (reviewJudgment.rationale ?? "the reviewer did not approve the E2E tests"),
      parsed: deliverable.parsed,
    };
  }
}
