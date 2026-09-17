/*
 * RunQaUseCase drives the QA run lifecycle through segregated ports.
 * Approved + zero specs is skipped, never invalid. Change-coverage "unknown"
 * never blocks publish. Classify runs only in diff mode; cleanup only when
 * previousNamespace is set. Coordination fails open to GenerationPort.
 * Pre-exec gateSignals use the number 0, not undefined, when unwired.
 */

import { Sha } from "@kernel/sha.ts";
import { relative } from "node:path";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunMode, TestTarget, TriggerSource } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { isOk } from "@kernel/result.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import type { IndexStatusPort } from "@kernel/ports/index-status.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type {
  ChangeAnalysisPort,
  GenerationPort,
  ReviewPort,
  ValidationPort,
  ExecutionPort,
  ObjectiveSignalPort,
  PublicationPort,
  LearningPort,
  WorkspacePort,
  DeployGatePort,
  RunHistoryPort,
  SetupPort,
  CleanupPort,
  ObserverPort,
  CommitIntent,
  PreExecGroundingPort,
  PreGenerationGroundingPort,
  ReviewDomGroundingPort,
  RetrievedRule,
  StructuralSignalPort,
  ServiceLinksPort,
  ServiceLink,
  ContractDrift,
  CrossRepoImpactPort,
  CrossRepoImpact,
  ConfinementPort,
  MirrorGcPort,
  CurriculumPort,
  ArchitectureContext,
  ExplorationBrief,
} from "./ports/index.ts";
import { REVIEWER_UNAVAILABLE_MARKER } from "./ports/index.ts";
import { decide, type RunEvidence } from "../domain/run-decision.service.ts";
import { RunDecision } from "../domain/run-decision.ts";
import { FixLoop, type FixLoopExecutionPort, type FixLoopGenerationPort, type FixLoopSelectorCheckPort } from "../domain/fix-loop.aggregate.ts";
import type { AdjudicatorVerdict } from "../domain/adjudicate.service.ts";
import { checkSpecSelectors } from "../domain/helpers/selector-check.ts";
import { resolveErrorClass } from "../domain/helpers/error-class.ts";
import { shouldDistillLearning } from "../domain/helpers/should-distill-learning.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";
import type { CoordinationPort } from "./ports/coordination.port.ts";
import type { CoordinationTelemetryPort } from "./coordination/coordination-telemetry.ts";
import type { CoordinationActivePoint } from "./coordination/active-gate.ts";
import type { SidekickExecutor } from "./coordination/sidekick-executor.ts";
import {
  advanceAfterNeedsLead,
  appendLeadDecision,
  appendLeadDelegation,
  appendLeadQuestions,
  buildProgressSnapshot,
  capabilityForFixLoopRound,
  createDelegationBrief,
  createLeadContext,
  evidenceFromBudget,
  evidenceFromChangeAnalysis,
  evidenceFromExecution,
  evidenceFromSelectors,
  proposeFromDecision,
  raiseCapabilityFloor,
  routeOrchestration,
  existingWritableFiles,
  resolveSidekickModel,
  shouldHonorActiveDelegation,
  shouldHonorFixLoopSidekick,
  type AgentCapability,
  type LeadContext,
  type ProgressSnapshot,
} from "./coordination/index.ts";
import type { ProposedOrchestrationDecision } from "./coordination/proposed-orchestration-decision.ts";
import { renderCoverageGap } from "@contexts/objective-signal/domain/render-coverage-gap.ts";
import { checkPreExecGrounding, checkPersistingAmbiguity } from "../domain/pre-exec-grounding.service.ts";
import type { ReflectorPort, ReflectionInput, ProcessAuditPort } from "@contexts/cross-run-learning/application/ports/index.ts";
import { detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";

/* Same minRatio the coverage policy uses for the E-COVERAGE-GAP band. */
const DEFAULT_MIN_COVERAGE_RATIO = 0.7;

/* Static-gate repair-round bound. */
const MAX_STATIC_FIX_ROUNDS = 2;

/* Caps static-gate error text in the repair regen prompt. */
const STATIC_GATE_ERROR_DETAIL_MAX_CHARS = 4000;

/*
 * Renders every failing case's failureDom into one prompt-facing block.
 * Distinct from the aggregate's per-case line splitter. Undefined when no
 * failing case carries a failureDom.
 */
function buildFailureDomSnapshot(cases: readonly QaCase[]): string | undefined {
  const parts: string[] = [];
  for (const c of cases) {
    if (c.status !== "fail" || !c.failureDom) continue;
    const lines = c.failureDom.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    parts.push(`### ${c.name}\n${lines.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Subset of host AppConfig the composition root passes in. The full shape is a shell concern. */
export interface RunQaConfig {
  needsReview: boolean;
  shadow: boolean;
  onFailure: string;
  maxRetries: number;
  isCode: boolean;
  /**
   * "signal" (default) measures and records but never blocks publish. Only
   * "enforce" holds the PR on a "fail" status. "unknown" never blocks in any mode.
   */
  coveragePolicyMode: "off" | "signal" | "enforce";
  /**
   * Per-mode agent session budget (ms). 0 / omitted derives WallClockBudget but
   * MUST NOT enforce it — a zero budget would abort every retry immediately.
   */
  agentTimeoutMs?: number;
  /** When set, WallClockBudget uses this instead of cycleBudget.ceiling * agentTimeoutMs. */
  wallClockBudgetMs?: number;
  iterationBudget?: number;
}

export interface RunQaUseCaseDeps {
  changeAnalysis: ChangeAnalysisPort;
  generation: GenerationPort;
  review: ReviewPort;
  validation: ValidationPort;
  execution: ExecutionPort;
  objectiveSignal: ObjectiveSignalPort;
  publication: PublicationPort;
  learning: LearningPort;
  workspace: WorkspacePort;
  /** Absent for static sites and the code target. */
  deployGate?: DeployGatePort;
  runHistory: RunHistoryPort;
  /** Absent: setup is skipped. A throw from setup() is infra-error, never a code verdict. */
  setup?: SetupPort;
  /**
   * Absent: cleanup is skipped. Runs only when previousNamespace is set.
   * A cleanup failure is logged and MUST NEVER alter this run's verdict.
   */
  cleanup?: CleanupPort;
  /**
   * Absent: onStep/onEvent are no-ops. onStep fires only for phases this run
   * actually crosses — never fabricated. onEvent fires live during execute().
   * Callers that also reconstruct events from the final cases array must pick
   * one path; this use-case does not de-dupe across that boundary.
   * FixLoop retries collapse to one "retry" emission per fail-verdict engagement.
   */
  observer?: ObserverPort;
  /**
   * Absent: the pre-exec grounding gate is skipped and related gateSignals stay 0,
   * not undefined.
   */
  preExecGrounding?: PreExecGroundingPort;
  /**
   * Absent: generation falls back to live-MCP exploration (fail-open). Invoked
   * once after setup and before the initial generate(); output is reused on regen.
   */
  preGenerationGrounding?: PreGenerationGroundingPort;
  /** Absent: the reviewer defers on unverifiable UI facts (fail-open). */
  reviewDomGrounding?: ReviewDomGroundingPort;
  /**
   * Advisory only; a throw is caught and logged, never aborts the run.
   * Outside diff mode the BlastRadius is empty and the port short-circuits to "".
   */
  structuralSignal?: StructuralSignalPort;
  /**
   * Not gated on diff mode — service links are app-static per SHA, so this runs
   * for every generation mode. Throw is fail-open.
   */
  serviceLinks?: ServiceLinksPort;
  /**
   * Invoked only on cross-repo runs (triggerRepo set and a resolved link targets
   * it). Same-repo runs never call this. Throw is fail-open.
   */
  crossRepoImpact?: CrossRepoImpactPort;
  /**
   * Invoked after learning.fold(), gated stricter than the fold: no flaky/
   * E-INFRA/E-FLAKY. Fault-isolated inside the adapter — no extra try/catch here.
   */
  reflector?: ReflectorPort;
  /**
   * After every generate() and once more immediately before every publish().
   * A thrown enforce() is caught here, logged, and never alters the verdict or
   * blocks publish. Results this run are merged into one gateSignals.confinement.
   */
  confinement?: ConfinementPort;
  /**
   * Same gate as reflector, checked independently so one collaborator being
   * absent never affects the other. Fault-isolated inside the adapter.
   */
  processAudit?: ProcessAuditPort;
  /** Off-path. Fault-isolated inside the adapter — neither call site needs a try/catch. */
  curriculum?: CurriculumPort;
  /**
   * Once, after pre-publish confinement and publish have both resolved, so gc
   * never races this run's git write. The sequential queue already prevents other
   * runs overlapping. A thrown prune() is caught here and never alters the verdict.
   */
  mirrorGc?: MirrorGcPort;
  /**
   * Requires both ports. Fail-open: a throw or IndexFailed never becomes
   * infra-error and does not setLastIndexedSha. SHA skip when lastIndexedSha
   * matches. Classify-skip returns before this phase. No onStep.
   */
  indexStatus?: IndexStatusPort;
  codeGraph?: CodeGraphPort;
  /**
   * Classify-source repo root (SERVICE mirror on a webhook, PRIMARY otherwise).
   * Absent → index workspace.mirrorDir.
   */
  codeGraphRepoDir?: string;
  /**
   * Absent: no proposal. Shadow/off proposals are advisory and MUST NOT change
   * generation or publish. decide() errors fail open — generation continues.
   */
  coordination?: CoordinationPort;
  /** Absent: proposals are only logged via observer log.line when coordination is wired. */
  coordinationTelemetry?: CoordinationTelemetryPort;
  /**
   * Which active-mode points may govern. Absent/empty: active still records
   * proposals but never replaces generation.
   */
  coordinationEnabledPoints?: readonly CoordinationActivePoint[];
  /** Absent: active delegate cannot run; fail-open to GenerationPort (lead path). */
  sidekick?: SidekickExecutor;
  /** Infra model id for sidekick-escalated openSession; absent → same worker model as standard. */
  sidekickEscalatedModel?: string;
  /**
   * App DEV base URL for sidekick browser grounding (artifact-threaded, not env).
   * Reuse over re-exploration.
   */
  sidekickDevBaseUrl?: string;
  /**
   * Per-delegation wall-clock cap. Without it a hung sidekick eats the whole
   * run's agentTimeout before fail-open fires. Absent → cfg.agentTimeoutMs.
   */
  sidekickTimeoutMs?: number;
  config?: Partial<RunQaConfig>;
}

export interface RunQaInput {
  app: string;
  sha: Sha;
  source: TriggerSource;
  mode: RunMode;
  target: TestTarget;
  guidance?: string;
  runId: string;
  /**
   * Set when a SERVICE-repo webhook triggered this run. Measure must starve the
   * coverage diff so change-coverage stays "unknown" (unknown never blocks).
   */
  triggerRepo?: string;
  /** Prior interrupted run's namespace. Absent: cleanup never fires this run. */
  previousNamespace?: string;
  /** When set, this run's diff spans baseSha..sha. Absent: single-commit classification. */
  baseSha?: Sha;
  /** Continuation provenance from the /continue API only. Absent is never fabricated. */
  parentRunId?: string;
}

export interface RunQaResult {
  decision: RunDecision;
  /**
   * The exact RunOutcome this run persisted — not a second derivation with a new
   * Date. Absent when nothing was persisted.
   */
  outcome?: RunOutcome;
  /**
   * Surfaced here so the shell adapter can forward the same fields this use-case
   * persisted (it has no RunHistoryPort read-back).
   */
  errorClass: string | null;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerApproved?: boolean;
    retries: number;
    preExecAmbiguityCatches: number;
    deterministicSelectorBlocks: number;
    /** Always a number (0, not undefined) once the pre-exec gate is in the type. */
    catalogGateInWindow: number;
    catalogGateAdvisory: number;
    catalogGateFailClosed: number;
  };
  cases: QaCase[];
  /** One-shot post-execution string. Absent on early exits that never reached execute(). */
  logs?: string;
  /** Retrieved rule ids (not trigger text) for by-id fold attribution. */
  rulesRetrieved: string[];
  /**
   * Diagnostic note. Two sources, never both: an infra-error/invalid message, or
   * the publish outcome string. Absent when neither applies; never fabricated.
   */
  note?: string;
}

const DEFAULT_CONFIG: RunQaConfig = {
  needsReview: false,
  shadow: false,
  onFailure: "github-issue",
  maxRetries: 2,
  isCode: false,
  coveragePolicyMode: "signal",
};

export class RunQaUseCase {
  constructor(private readonly deps: RunQaUseCaseDeps) {}

  async run(input: RunQaInput, signal?: AbortSignal): Promise<RunQaResult> {
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    const startedAt = Date.now();
    const cycleBudget = CycleBudget.derive({
      maxRetries: cfg.maxRetries,
      ...(cfg.iterationBudget !== undefined ? { iterationBudget: cfg.iterationBudget } : {}),
    });
    const wallClockBudget = WallClockBudget.derive({
      cycleBudget,
      agentTimeoutMs: cfg.agentTimeoutMs ?? 0,
      ...(cfg.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: cfg.wallClockBudgetMs } : {}),
    });
    /*
     * A zero agentTimeoutMs with no YAML override MUST NOT enforce exhausted() —
     * that budget is 0 and would stop every retry on the first millisecond.
     */
    const wallClockArmed = (cfg.agentTimeoutMs ?? 0) > 0 || cfg.wallClockBudgetMs !== undefined;

    /* Already-aborted signal short-circuits before the entry gate. */
    if (signal?.aborted) {
      return this.abortedResult();
    }

    this.deps.observer?.onStep("gate");
    if (this.deps.deployGate) {
      const gateResult = await this.deps.deployGate.waitUntilServing(input.sha);
      if (!isOk(gateResult)) {
        /* Thread the deploy-gate InfraError message as the diagnostic note — never drop it. */
        return this.infraErrorResult(gateResult.error.message);
      }
    }
    if (signal?.aborted) {
      return this.abortedResult();
    }

    const workspace = await this.deps.workspace.prepare(input.sha);

    /*
     * confinementAcc stays undefined until the first enforce() completes, so an
     * unwired or never-called confinement never persists a fabricated {strays:0}.
     */
    let confinementAcc: { strays: number; dangerous: number; reverted: string[] } | undefined;
    const enforceConfinement = async (): Promise<void> => {
      if (!this.deps.confinement) return;
      try {
        const result = await this.deps.confinement.enforce(workspace.mirrorDir, cfg.isCode, signal);
        confinementAcc = {
          strays: (confinementAcc?.strays ?? 0) + result.strays,
          dangerous: (confinementAcc?.dangerous ?? 0) + result.dangerous,
          reverted: [...(confinementAcc?.reverted ?? []), ...result.reverted],
        };
      } catch (err) {
        /*
         * Log loudly, never throw, never alter the verdict or block publish. A thrown
         * enforce() means this call's counts are unknowable — increment dangerous
         * without fabricating a reverted path.
         */
        console.error(
          `[qa] write-confinement enforcement FAILED (fault-isolated — run continues, never blocks publish): ${err instanceof Error ? err.message : String(err)}`,
        );
        confinementAcc = {
          strays: confinementAcc?.strays ?? 0,
          dangerous: (confinementAcc?.dangerous ?? 0) + 1,
          reverted: confinementAcc?.reverted ?? [],
        };
      }
    };

    /*
     * Only "diff" mode classifies; the others always generate.
     * Classify-skip is a bare return (save no, fold no). Agent-no-op skip later
     * persists (save yes, fold no) even though both verdicts are "skipped".
     * classificationDiff / intent are undefined outside diff mode.
     */
    let classificationDiff: string | undefined;
    let classificationIntent: CommitIntent | undefined;
    /* Classifier reason — absent outside diff mode. */
    let classificationReason: string | undefined;
    let classificationContradiction: boolean | undefined;
    /*
     * "regression" runs the existing suite without generating. Non-diff modes
     * never classify, so they always generate.
     */
    let generating = true;
    if (input.mode === "diff") {
      this.deps.observer?.onStep("classify");
      const classification = await this.deps.changeAnalysis.classify(input.sha, input.baseSha ? { baseSha: input.baseSha } : undefined);
      classificationDiff = classification.diff;
      classificationIntent = classification.intent;
      classificationReason = classification.reason;
      classificationContradiction = classification.contradiction;
      if (classification.action === "skip") {
        /*
         * Prepare already checked out the mirror. Classify-skip does not persist, but
         * the working copy was touched and must still be pruned.
         */
        await this.pruneMirrorIfWired(workspace.mirrorDir);
        return this.skippedResult();
      }
      generating = classification.action !== "regression";
    }

    /*
     * Requires both ports. Classify-skip already returned (that path may GC the
     * mirror). SHA skip does not call syncTo. IndexFailed does not setLastIndexedSha.
     * Throws are fail-open. No onStep("index").
     */
    if (this.deps.indexStatus && this.deps.codeGraph) {
      try {
        const indexDir = this.deps.codeGraphRepoDir ?? workspace.mirrorDir;
        const lastIndexedSha = await this.deps.indexStatus.getLastIndexedSha(indexDir);
        if (lastIndexedSha !== input.sha.toString()) {
          const changedFiles = classificationIntent?.changedFiles ?? [];
          const result = await this.deps.codeGraph.syncTo(indexDir, changedFiles);
          if (result.ok) {
            await this.deps.indexStatus.setLastIndexedSha(indexDir, input.sha.toString());
          } else {
            console.warn("[qa] mirror indexing failed (non-blocking):", result.error.reason);
          }
        }
      } catch (err) {
        console.warn("[qa] mirror indexing failed (non-blocking):", err);
      }
    }

    if (signal?.aborted) {
      return this.abortedResult(workspace.mirrorDir);
    }

    /*
     * After classify (skip already returned) and before generate. A throw is
     * infra-error, never a code verdict, and is not persisted.
     */
    if (this.deps.setup) {
      this.deps.observer?.onStep("setup");
      try {
        await this.deps.setup.setup(workspace.specDir, signal);
      } catch (err) {
        /* Never swallow an integration error into an empty result. */
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[qa] setup phase failed:", err);
        return this.infraErrorResult(`setup failed: ${msg}`, workspace.mirrorDir);
      }
    }
    if (signal?.aborted) {
      return this.abortedResult(workspace.mirrorDir);
    }

    /*
     * Orphan-data cleanup for a PRIOR interrupted run. e2e-only; requires
     * previousNamespace. Failure is logged and MUST NEVER alter this run's verdict.
     */
    if (this.deps.cleanup && input.previousNamespace && !cfg.isCode) {
      this.deps.observer?.onStep("setup", "orphan-data cleanup (prior interrupted run)");
      try {
        await this.deps.cleanup.cleanup(workspace.specDir, {
          namespace: input.previousNamespace,
          signal,
        });
      } catch (err) {
        console.error(`[qa] cleanup warning (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (signal?.aborted) {
      return this.abortedResult(workspace.mirrorDir);
    }

    /*
     * sha is always present so manifest changeRef.sha is never empty.
     * retrieve() is enrichment, not a requirement: failure is caught and generation
     * continues. Prompt renderers use trigger/action; retrievedRuleIds (r.id) are
     * for by-id fold attribution — never conflate the two.
     */
    let retrievedRules: RetrievedRule[] = [];
    try {
      retrievedRules = await this.deps.learning.retrieve(input.sha);
    } catch (err) {
      console.error("[qa] learning retrieval failed (non-fatal, generation continues ungrounded):", err);
    }
    const retrievedRuleIds = retrievedRules.map((r) => r.id);

    /*
     * Settled before any prompt is built. The fold must credit exactly the
     * archetypes this prompt carried. A regression run never calls generate(), so
     * the set stays empty — including any later coverage regen on that run.
     */
    const selectedExemplars = generating && this.deps.curriculum
      ? await this.deps.curriculum.select(classificationDiff, classificationIntent?.changedFiles ?? [])
      : [];
    const offeredArchetypes = selectedExemplars.map((e) => e.archetype);

    /*
     * Once after setup, before the first generate(); reused unchanged on regen.
     * Fail-open: a misbehaving adapter must never abort the run over grounding.
     */
    let groundingContextPack: string | undefined;
    let groundingExistingSpecFiles: string[] | undefined;
    let groundingContextMap: ArchitectureContext | undefined;
    let groundingContextBrief: ExplorationBrief | undefined;
    if (this.deps.preGenerationGrounding) {
      this.deps.observer?.onStep("generate", "pre-generation grounding");
      try {
        const grounding = await this.deps.preGenerationGrounding.ground(
          workspace.specDir,
          signal,
          classificationDiff,
          { sha: input.sha.toString(), ...(classificationIntent ? { intent: classificationIntent } : {}) },
        );
        groundingContextPack = grounding.contextPack;
        groundingExistingSpecFiles = grounding.existingSpecFiles;
        groundingContextMap = grounding.contextMap;
        groundingContextBrief = grounding.contextBrief;
      } catch (err) {
        /* Abort during grounding takes the abort route, not ungrounded continue. */
        if (signal?.aborted) return this.abortedResult(workspace.mirrorDir);
        console.error("[qa] WARNING: pre-generation grounding failed (non-fatal, generation continues ungrounded):", err);
      }
    }
    /*
     * The adapter may resolve a partial GroundingResult on abort instead of
     * throwing — this check is what actually routes abort vs continue.
     */
    if (signal?.aborted) return this.abortedResult(workspace.mirrorDir);

    /*
     * Built from classificationIntent.changedFiles. Empty outside diff mode.
     * The same BlastRadius is reused for measure() so the code-target oracle is
     * scoped to the diff; the e2e oracle ignores it.
     */
    const runBlastRadius = BlastRadius.of(input.sha, classificationIntent?.changedFiles ?? []);
    /*
     * Advisory only; throw degrades to "" and never aborts.
     * Queried against the classify-source repo so a cross-repo BlastRadius hits
     * the matching graph.
     */
    let blastRadiusSignal = "";
    if (this.deps.structuralSignal) {
      try {
        blastRadiusSignal = await this.deps.structuralSignal.render(workspace.specDir, runBlastRadius);
      } catch (err) {
        console.error("[qa] WARNING: structural blast-radius signal failed (non-fatal, generation continues without it):", err);
      }
    }

    /* Not gated on diff mode. Advisory; throw degrades to empty links/drift. */
    let resolvedServiceLinks: readonly ServiceLink[] = [];
    let resolvedContractDrift: readonly ContractDrift[] = [];
    if (this.deps.serviceLinks) {
      try {
        const r = await this.deps.serviceLinks.resolve();
        resolvedServiceLinks = r.links;
        resolvedContractDrift = r.drift;
      } catch (err) {
        console.error("[qa] WARNING: service-links resolution failed (non-fatal, generation continues without it):", err);
      }
    }

    /*
     * Only on cross-repo runs. The .some() pre-filter skips the await when no
     * resolved link targets triggerRepo. Throw is fail-open.
     */
    let crossRepoImpact: CrossRepoImpact | null = null;
    if (
      this.deps.crossRepoImpact &&
      input.triggerRepo &&
      resolvedServiceLinks.length &&
      resolvedServiceLinks.some((l) => l.to.repo === input.triggerRepo)
    ) {
      try {
        crossRepoImpact = await this.deps.crossRepoImpact.resolve(input.triggerRepo, input.sha.toString(), resolvedServiceLinks);
      } catch (err) {
        console.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, generation continues without it):", err);
      }
    }

    const baseEnrichment = {
      sha: input.sha.toString(),
      runId: input.runId,
      ...(classificationIntent ? { intent: classificationIntent } : {}),
      ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
      ...(groundingContextPack ? { contextPack: groundingContextPack } : {}),
      ...(groundingExistingSpecFiles?.length ? { existingSpecFiles: groundingExistingSpecFiles } : {}),
      ...(groundingContextMap ? { contextMap: groundingContextMap } : {}),
      ...(groundingContextBrief ? { contextBrief: groundingContextBrief } : {}),
      ...(blastRadiusSignal ? { staticSignal: blastRadiusSignal } : {}),
      ...(selectedExemplars.length ? { skillExemplars: selectedExemplars } : {}),
      ...(resolvedServiceLinks.length ? { serviceLinks: resolvedServiceLinks } : {}),
      ...(resolvedContractDrift.length ? { contractDrift: resolvedContractDrift } : {}),
      ...(crossRepoImpact?.impactedLinks.length ? { crossRepoImpact: { impactedLinks: crossRepoImpact.impactedLinks } } : {}),
      /* contradiction is spread only when true — never fabricated as false. */
      ...(classificationReason ? { classificationReason } : {}),
      ...(classificationContradiction ? { contradiction: true } : {}),
    };

    /* After classification+grounding, before generate. Fail-open on decide() errors. */
    let coordinationProposal: ProposedOrchestrationDecision | undefined;
    let leadContext: LeadContext | undefined;
    let coordinationEscalations = 0;
    let preGenerateAttempt = 0;
    if (this.deps.coordination) {
      try {
        const objective = input.guidance ?? classificationIntent?.message ?? `QA run ${input.runId}`;
        leadContext = createLeadContext({ runId: input.runId, objective });
        const evidence = [
          ...(classificationReason !== undefined
            ? [
                evidenceFromChangeAnalysis({
                  action: generating ? "generate" : "regression",
                  reason: classificationReason,
                  fileCount: classificationIntent?.changedFiles.length ?? 0,
                  ...(classificationContradiction ? { contradiction: true } : {}),
                }),
              ]
            : []),
          evidenceFromBudget({
            cycleCeiling: cycleBudget.ceiling,
            cycleCount: cycleBudget.cycleCount,
            wallClockMs: wallClockBudget.budgetMs,
          }),
        ];
        const decision = await this.deps.coordination.decide({
          runId: input.runId,
          objective,
          acceptanceCriteria: [],
          evidence,
          budgets: { cycle: cycleBudget, wallClock: wallClockBudget },
        });
        coordinationProposal = proposeFromDecision(decision);
        leadContext = appendLeadDecision(leadContext, decision);
        this.deps.coordinationTelemetry?.record({
          runId: input.runId,
          kind: "proposal",
          action: decision.action,
          capability: decision.nextCapability,
          reason: decision.reason,
          at: coordinationProposal.recordedAt,
        });
        this.deps.observer?.onEvent({
          type: "log.line",
          level: "info",
          text: `coordination proposal: ${decision.action} (${decision.reason})`,
        });
      } catch (err) {
        console.error(
          `[qa] coordination.decide failed (fail-open — generation continues unchanged): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    /*
     * Separate from generation enrichment: ReviewEnrichment has no sha/contextPack.
     * domSnapshot is captured per review round on the current specs.
     */
    const baseReviewEnrichment = {
      runId: input.runId,
      ...(classificationIntent ? { intent: classificationIntent } : {}),
      ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
    };

    /*
     * Skipped when generating is false (regression) — the synthetic empty approved
     * result is not a GenerationPort call.
     * Active delegate: success with in-scope files wins; needs-lead/blocked/failed/
     * empty fail open to GenerationPort. FixLoop regen is a separate enabled point.
     */
    this.deps.observer?.onStep("generate", generating ? undefined : "regression: running the existing suite, not generating");
    let generated: {
      specs: string[];
      approved: boolean;
      note?: string;
      specSources?: string[];
      parsed?: boolean;
      specMetas?: { flow?: string; objective?: string }[];
    };
    if (!generating) {
      generated = { specs: [], approved: true };
    } else {
      let fromSidekick: typeof generated | undefined;
      const honorDelegate = shouldHonorActiveDelegation({
        proposal: coordinationProposal,
        enabledPoints: this.deps.coordinationEnabledPoints ?? [],
        point: "pre-generate",
        sidekickAvailable: !!this.deps.sidekick,
      });
      if (honorDelegate && this.deps.sidekick && coordinationProposal) {
        try {
          const e2eRel = relative(workspace.mirrorDir, workspace.specDir).replace(/\\/g, "/") || "e2e";
          const writableRoot = cfg.isCode ? "." : `${e2eRel}/`;
          const objective =
            input.guidance ?? classificationIntent?.message ?? `QA run ${input.runId}`;
          const brief = createDelegationBrief({
            delegationId: `${input.runId}-pre-generate`,
            runId: input.runId,
            objective,
            /*
             * Executor instruction, not the bare intent: the sidekick must write the specs
             * and close with the DelegationResult JSON contract.
             */
            task: `Write the Playwright E2E spec file(s) NOW, inside ${writableRoot}, covering this objective: ${objective}\n`
              + `Rules: real selectors only (fixture import + grounding rules apply); do not stop at a plan; finish by emitting the DelegationResult JSON contract from the brief.`,
            acceptanceCriteria: [],
            scope: {
              readablePaths: cfg.isCode ? ["."] : [e2eRel, "src/", "app/"],
              writablePaths: [writableRoot],
              allowedCommands: [],
            },
            knownFacts: coordinationProposal.decision.evidence,
            /* Give the sidekick the live DEV URL so it does not boot its own server. */
            ...(this.deps.sidekickDevBaseUrl
              ? { artifactRefs: [{ id: "dev-base-url", path: this.deps.sidekickDevBaseUrl }] }
              : {}),
          });
          const capability = coordinationProposal.decision.nextCapability ?? "sidekick-standard";
          const sidekickModel = resolveSidekickModel(capability, this.deps.sidekickEscalatedModel);
          preGenerateAttempt += 1;
          const delegationStarted = Date.now();
          const delegation = await this.deps.sidekick.execute(brief, {
            cwd: workspace.mirrorDir,
            capability,
            ...(sidekickModel ? { model: sidekickModel } : {}),
            signal,
            timeoutMs: this.deps.sidekickTimeoutMs ?? cfg.agentTimeoutMs,
          });
          this.deps.coordinationTelemetry?.record({
            runId: input.runId,
            kind: "delegation",
            action: coordinationProposal.decision.action,
            capability,
            reason: `sidekick status=${delegation.status}`,
            delegationId: brief.delegationId,
            attempt: preGenerateAttempt,
            durationMs: Date.now() - delegationStarted,
            at: Date.now(),
          });
          if (leadContext) {
            leadContext = appendLeadDelegation(leadContext, {
              delegationId: brief.delegationId,
              status: delegation.status,
              summary: delegation.summary,
            });
            if (delegation.unresolvedQuestions.length) {
              leadContext = appendLeadQuestions(leadContext, delegation.unresolvedQuestions);
            }
          }
          /* JSON claims alone are not success — require files on disk under writable scope (fail-open). */
          const onDisk =
            delegation.status === "completed" || delegation.status === "completed-with-concerns"
              ? existingWritableFiles(workspace.mirrorDir, delegation.filesChanged, [writableRoot])
              : [];
          if (onDisk.length > 0) {
            const prefix = writableRoot.endsWith("/") ? writableRoot : `${writableRoot}/`;
            const specs = onDisk.map((f) => {
              const p = f.path.replace(/\\/g, "/");
              if (p.startsWith(prefix)) return p.slice(prefix.length);
              if (!cfg.isCode && p.startsWith(`${e2eRel}/`)) return p.slice(e2eRel.length + 1);
              return p;
            });
            fromSidekick = {
              specs,
              approved: true,
              parsed: true,
              note: delegation.summary,
              specMetas: specs.map((s) => ({ flow: s, objective })),
            };
            this.deps.observer?.onEvent({
              type: "log.line",
              level: "info",
              text: `coordination active pre-generate: sidekick ${delegation.status} specs=${specs.length}`,
            });
          } else {
            const claimed = delegation.filesChanged.length;
            this.deps.observer?.onEvent({
              type: "log.line",
              level: "info",
              text:
                claimed > 0 &&
                (delegation.status === "completed" || delegation.status === "completed-with-concerns")
                  ? `coordination active pre-generate: sidekick claimed ${claimed} files but none on disk — falling back to lead GenerationPort`
                  : `coordination active pre-generate: sidekick ${delegation.status} — falling back to lead GenerationPort`,
            });
          }
        } catch (err) {
          console.error(
            `[qa] coordination sidekick failed (fail-open — lead GenerationPort runs): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      generated = fromSidekick
        ?? (await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, baseEnrichment));
    }
    /*
     * Confinement after a real generate() only. The regression synthetic stand-in
     * wrote nothing. Sidekick writes are still agent writes.
     */
    if (generating) await enforceConfinement();

    /*
     * Zero specs AND approved===false is not the agent-no-op skip (that requires
     * approved===true). Stash the agent's note for whichever terminal this run reaches.
     */
    const generationNote = !generated.approved && generated.specs.length === 0 && generated.note ? generated.note : undefined;

    /*
     * parsed===false AND zero specs is a runtime failure, not a no-op skip.
     * approved defaults true on an unparseable verdict — without this guard it would
     * masquerade as a clean skip. Ordered before the no-op skip. Routes to infra-error.
     */
    if (generating && generated.parsed === false && generated.specs.length === 0) {
      const emptyNote =
        generated.note ||
        "generation produced no parseable output — the agent runtime returned an empty/errored session " +
          "(provider unavailable, quota exhausted, timeout, or model refusal). Not a code defect and not a " +
          "no-op decision; surfaced as infra-error so it is diagnosable rather than a silent skip.";
      console.error(`[qa] generation runtime failure (empty, unparseable output): ${emptyNote}`);
      return this.infraErrorResult(emptyNote, workspace.mirrorDir);
    }

    /*
     * Approved + zero specs is a valid skipped, never invalid. Gated on generating:
     * a regression synthetic {approved:true, specs:[]} must not be classified as
     * an agent no-op — it must run the existing suite. This skip persists; classify-skip does not.
     */
    if (generating && generated.approved && generated.specs.length === 0) {
      /* Agent-no-op is approved===true by this branch's guard — persist that value. */
      const skipped = this.skippedResult(cfg.needsReview ? generated.approved : undefined);
      const skippedOutcome = this.toRunOutcome(input, skipped.decision, [], 0, null, skipped.errorClass, {
        reviewerApproved: skipped.gateSignals.reviewerApproved,
        ...(confinementAcc !== undefined ? { confinement: confinementAcc } : {}),
      });
      await this.deps.runHistory.save(skippedOutcome);
      await this.pruneMirrorIfWired(workspace.mirrorDir);
      return { ...skipped, outcome: skippedOutcome };
    }

    /* Shared retries counter for the static-fix loop AND the FixLoop — accumulate, never reset. */
    let retries = 0;
    /* Winning FixLoop execute namespace (`${runId}-rN`). Absent when the loop never ran. */
    let coverageNamespace: string | undefined;
    /* Undefined when FixLoop never engaged — never fabricated. */
    let lastAdjudicatorVerdictClass: string | undefined;
    /* Full adjudicator verdict for the Issue body. Undefined when FixLoop never engaged. */
    let lastAdjudicatorVerdict: AdjudicatorVerdict | undefined;
    /* FixLoop's final specMetas. Undefined when it never regenerated. resolveTested() decides precedence. */
    let fixLoopFinalSpecMetas: { flow?: string; objective?: string }[] | undefined;

    /* Absent port: counters stay 0, not undefined. Accumulated so they survive every terminal. */
    let preExecAmbiguityCatches = 0;
    let deterministicSelectorBlocks = 0;
    let catalogGateInWindow = 0;
    let catalogGateAdvisory = 0;
    let catalogGateFailClosed = 0;
    /* Re-reads on-disk specs every call so a post-regen re-check is not stale. */
    const runPreExecGrounding = async (): Promise<string[]> => {
      if (!this.deps.preExecGrounding) return [];
      const { specSources, routes } = await this.deps.preExecGrounding.capture(workspace.specDir, signal);
      const result = checkPreExecGrounding({ specSources, routes });
      preExecAmbiguityCatches += result.preExecAmbiguityCatches;
      catalogGateInWindow += result.catalogGateInWindow;
      catalogGateAdvisory += result.catalogGateAdvisory;
      catalogGateFailClosed += result.catalogGateFailClosed;
      return result.corrections;
    };
    /*
     * One-shot corrective regen before the static gate. Adopt the regen only if it
     * produced specs — an empty result must not discard the original specs.
     */
    const w1Corrections = await runPreExecGrounding();
    if (w1Corrections.length > 0) {
      this.deps.observer?.onStep("retry", "pre-exec grounding: corrective regen (W1)");
      const corrected = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
        ...baseEnrichment,
        selectorContradictions: w1Corrections,
      });
      await enforceConfinement();
      if (corrected.specs.length > 0) {
        generated = corrected;
      }
    }
    /* Pre-exec corrections still feed later FixLoop regens until the post-static-fix re-check refreshes them. */
    let pendingSelectorContradictions: string[] = w1Corrections;

    /*
     * Bounded repair of static-gate errors (MAX_STATIC_FIX_ROUNDS). Skipped when
     * nothing was generated. Repair rounds get validation errors as fixCases; the
     * initial generate() does not. lastGenerated is the latest attempt's approved flag.
     * changedFiles scopes the code-target compile gate; ignored by e2e. Empty outside diff mode.
     */
    const validateChangedFiles = classificationIntent?.changedFiles ?? [];
    this.deps.observer?.onStep("validate");
    let validation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles);
    let lastGenerated = generated;
    /*
     * Prefer FixLoop's final specMetas when present; otherwise lastGenerated's.
     * Undefined when neither source has anything — the "tested" section is omitted.
     */
    const resolveTested = (): { flow?: string; objective?: string }[] | undefined =>
      fixLoopFinalSpecMetas?.length ? fixLoopFinalSpecMetas : lastGenerated.specMetas;
    let staticFixRounds = 0;
    while (!validation.ok && !validation.infra && generating && lastGenerated.specs.length > 0 && staticFixRounds < MAX_STATIC_FIX_ROUNDS) {
      /* Cancel mid-repair must stop before burning another generate()+validate() round-trip. */
      if (signal?.aborted) {
        return this.abortedResult(workspace.mirrorDir);
      }
      staticFixRounds++;
      retries++;
      this.deps.observer?.onStep("retry", `static-fix round ${staticFixRounds}/${MAX_STATIC_FIX_ROUNDS}`);
      /* Repair regen reuses the same classificationDiff/intent as the initial generate(). */
      const staticGateErrorDetail = validation.errors.join("\n\n").slice(0, STATIC_GATE_ERROR_DETAIL_MAX_CHARS);
      lastGenerated = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
        ...baseEnrichment,
        fixCases: [{ name: "static-gate", status: "fail", detail: staticGateErrorDetail }],
      });
      await enforceConfinement();
      validation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles);
    }

    /*
     * If a strict-mode ambiguity persists after static-fix, fold it into the static
     * gate so invalid holds the run before execution. Catalog corrections never
     * reach this block — only the one-shot repair and FixLoop channels.
     */
    if (this.deps.preExecGrounding && preExecAmbiguityCatches > 0 && validation.ok) {
      const { specSources, routes } = await this.deps.preExecGrounding.capture(workspace.specDir, signal);
      const persisting = checkPersistingAmbiguity({ specSources, routes });
      deterministicSelectorBlocks = persisting.length;
      if (persisting.length > 0) {
        validation = {
          ok: false,
          infra: false,
          errors: persisting.map((a) => `strict-mode selector ambiguity (deterministic — would fail at runtime; scope to a unique parent): ${a}`),
        };
      }
    }

    /*
     * reviewerApproved default is generation's own flag, from lastGenerated.
     * Gated on generating: a regression stand-in is not a real agent decision.
     */
    const reviewerApprovedFromGeneration = cfg.needsReview && generating ? lastGenerated.approved : undefined;

    if (!validation.ok) {
      /*
       * Context-mode validate() failure does not persist (Issue only).
       * validation.infra is infra-error: the gate itself could not run, not a code defect.
       */
      console.error("[qa] static gate failed:", validation.errors);
      /* Append generationNote so static-gate errors do not hide why nothing was generated. */
      const staticGateNote = [validation.errors.slice(0, 2).join("\n\n") || undefined, generationNote]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") || undefined;
      /* Last confinement pass immediately before this exit's publish(). */
      await enforceConfinement();
      return await this.terminalResult(
        validation.infra ? "infra-error" : "invalid",
        cfg,
        input,
        { generating, static: false },
        reviewerApprovedFromGeneration,
        !validation.infra && input.mode === "context",
        /* Static-fix retries consumed before the gate gave up. */
        retries,
        staticGateNote,
        { preExecAmbiguityCatches, deterministicSelectorBlocks, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed },
        retrievedRuleIds,
        detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
        confinementAcc,
        resolveTested(),
        workspace.mirrorDir,
      );
    }

    /*
     * Mid-run DEV pre-flight, distinct from the entry gate. Absent DeployGatePort
     * (static sites / code) defaults to always-healthy. The InfraError message is
     * captured as a side effect so FixLoop can keep a boolean-returning contract.
     */
    this.deps.observer?.onStep("health");
    let lastHealthCheckError: string | undefined;
    const devHealthy = async (): Promise<boolean> => {
      if (!this.deps.deployGate) return true;
      const result = await this.deps.deployGate.waitUntilServing(input.sha);
      if (!isOk(result)) {
        lastHealthCheckError = result.error.message;
        return false;
      }
      return true;
    };
    if (!(await devHealthy())) {
      /*
       * This exit persists static:false even though validation already passed — the
       * stored field for this source is false. Append generationNote if generation
       * was also empty and unapproved.
       */
      const healthNote = [lastHealthCheckError ?? "DEV health pre-flight failed before execute", generationNote]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      console.error("[qa] health pre-flight failed before execute:", healthNote);
      /* Confinement still runs for revert even though this exit does not publish. */
      await enforceConfinement();
      return await this.terminalResult(
        "infra-error",
        cfg,
        input,
        { generating, static: false },
        reviewerApprovedFromGeneration,
        false,
        retries,
        healthNote,
        { preExecAmbiguityCatches, deterministicSelectorBlocks, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed },
        /*
         * Retrieved ids reach the persisted outcome for diagnosability but this
         * infra-error never folds or reflects.
         */
        retrievedRuleIds,
        detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
        confinementAcc,
        resolveTested(),
        workspace.mirrorDir,
      );
    }
    if (signal?.aborted) {
      return this.abortedResult(workspace.mirrorDir);
    }

    /*
     * Context mode never executes — context.json is not a Playwright spec.
     * A successful context generation is an immediate pass with zero cases.
     */
    if (input.mode !== "context") {
      this.deps.observer?.onStep("execute");
    }
    /* Live per-case ObserverPort events during execute(). Absent observer: callbacks are no-ops. */
    const liveExecutionOpts = {
      ...(signal ? { signal } : {}),
      onCase: (c: QaCase) => {
        this.deps.observer?.onEvent(
          c.status === "pass"
            ? { type: "test.passed", name: c.name, durationMs: c.durationMs ?? 0 }
            : c.status === "fail"
              ? { type: "test.failed", name: c.name, detail: c.detail, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) }
              : { type: "test.flaky", name: c.name, attempts: 2 },
        );
      },
      onRunning: (title: string) => {
        this.deps.observer?.onEvent({ type: "test.started", name: title });
      },
      onDiscovered: (title: string, file?: string) => {
        this.deps.observer?.onEvent({ type: "test.discovered", name: title, ...(file ? { file } : {}) });
      },
    };
    let run = input.mode === "context"
      ? { verdict: "pass" as const, cases: [] as QaCase[], logs: generated.note ?? "" }
      : await this.deps.execution.execute(workspace.specDir, liveExecutionOpts);
    if (signal?.aborted) {
      return this.abortedResult(workspace.mirrorDir);
    }

    /* FixLoop only when the initial verdict is "fail". Context mode's synthetic pass never enters. */
    if (run.verdict === "fail") {
      this.deps.observer?.onStep("retry", "fix-loop engaged after a failing execute()");
      const fixLoopExecution: FixLoopExecutionPort = {
        /*
         * Filtered retry scopes to failing spec files. Per-attempt namespace
         * (`${runId}-rN`) isolates Playwright test-data so a retry cannot collide with
         * its prior attempt on apps with no delete.
         */
        execute: async (fixLoopInput) => {
          const r = await this.deps.execution.execute(workspace.specDir, {
            ...liveExecutionOpts,
            ...(fixLoopInput.specFiles ? { specFiles: fixLoopInput.specFiles } : {}),
            ...(fixLoopInput.namespace ? { namespace: fixLoopInput.namespace } : {}),
          });
          return { verdict: r.verdict, cases: r.cases };
        },
      };
      /*
       * Who regenerates is selected here; FixLoop keeps retries/adjudication/selector checks.
       * Never demote below the escalation floor.
       */
      let fixLoopCapability: AgentCapability =
        coordinationProposal?.decision.nextCapability ?? "lead";
      let fixLoopCapabilityFloor: AgentCapability | undefined;
      let fixLoopPreviousProgress: ProgressSnapshot | undefined;
      let fixLoopSidekickNeedsLead = false;
      let fixLoopSidekickAttempt = 0;
      const e2eRelForFix = relative(workspace.mirrorDir, workspace.specDir).replace(/\\/g, "/") || "e2e";
      const writableRootForFix = cfg.isCode ? "." : `${e2eRelForFix}/`;
      const mapSidekickSpecs = (files: readonly { path: string }[]): string[] => {
        const prefix = writableRootForFix.endsWith("/") ? writableRootForFix : `${writableRootForFix}/`;
        return files.map((f) => {
          const p = f.path.replace(/\\/g, "/");
          if (p.startsWith(prefix)) return p.slice(prefix.length);
          if (!cfg.isCode && p.startsWith(`${e2eRelForFix}/`)) return p.slice(e2eRelForFix.length + 1);
          return p;
        });
      };
      const fixLoopGeneration: FixLoopGenerationPort = {
        /* Forward FixLoopGenerateInput so a retry prompt sees what failed. */
        generate: async (fixLoopInput) => {
          /*
           * Wall-clock / infra aborts go through abort-human.
           * Merge leftover pre-exec selector contradictions with FixLoop's post-failure
           * check — independent evidence; neither suppresses the other.
           */
          const mergedSelectorContradictions = [
            ...pendingSelectorContradictions,
            ...(fixLoopInput.selectorContradictions ?? []),
          ];

          /* Capability for THIS regen round. FixLoop still owns when to regenerate. */
          const failingNames = fixLoopInput.fixCases
            .filter((c) => c.status === "fail")
            .map((c) => c.name);
          const progress = buildProgressSnapshot({
            failureClass: "fail",
            failingNames,
            selectorContradictions: mergedSelectorContradictions,
          });
          const evidence = [
            evidenceFromExecution({ verdict: "fail", failing: failingNames.length }),
            ...(mergedSelectorContradictions.length
              ? [evidenceFromSelectors({ contradictions: mergedSelectorContradictions.length })]
              : []),
            evidenceFromBudget({
              cycleCeiling: cycleBudget.ceiling,
              cycleCount: cycleBudget.cycleCount,
              wallClockMs: wallClockBudget.budgetMs,
            }),
          ];
          const orchestration = routeOrchestration({
            evidence,
            currentCapability: fixLoopCapability,
            previous: fixLoopPreviousProgress,
            current: progress,
            budgetExhausted: wallClockArmed && wallClockBudget.exhausted(Date.now() - startedAt),
            infraFailure: false,
            sidekickNeedsLead: fixLoopSidekickNeedsLead,
          });
          if (orchestration.action === "abort-human") {
            coordinationEscalations += 1;
            this.deps.coordinationTelemetry?.record({
              runId: input.runId,
              kind: "escalation",
              action: "abort-human",
              capability: fixLoopCapability,
              reason: orchestration.reason,
              progressFingerprint: progress.failureFingerprint,
              failureClass: "fail",
              escalations: coordinationEscalations,
              at: Date.now(),
            });
            if (leadContext) {
              leadContext = appendLeadDecision(leadContext, {
                action: "abort",
                reason: orchestration.reason,
                evidence,
              });
            }
            return {
              specs: [],
              approved: lastGenerated.approved,
              note: `coordination abort-human: ${orchestration.reason}`,
            };
          }
          fixLoopCapability = raiseCapabilityFloor(
            capabilityForFixLoopRound({
              orchestration,
              fallback: fixLoopCapability,
            }),
            fixLoopCapabilityFloor,
          );
          if (
            orchestration.action === "escalate-sidekick" ||
            orchestration.action === "lead-takeover"
          ) {
            fixLoopCapabilityFloor = fixLoopCapability;
            coordinationEscalations += 1;
            this.deps.coordinationTelemetry?.record({
              runId: input.runId,
              kind: "escalation",
              action: orchestration.action,
              capability: fixLoopCapability,
              reason: orchestration.reason,
              progressFingerprint: progress.failureFingerprint,
              failureClass: "fail",
              escalations: coordinationEscalations,
              at: Date.now(),
            });
          }
          fixLoopPreviousProgress = progress;
          fixLoopSidekickNeedsLead = false;

          const honorSidekick = shouldHonorFixLoopSidekick({
            enabledPoints: this.deps.coordinationEnabledPoints ?? [],
            capability: fixLoopCapability,
            sidekickAvailable: !!this.deps.sidekick,
          });
          if (honorSidekick && this.deps.sidekick) {
            try {
              const failSummary = failingNames.slice(0, 8).join(", ") || "failing tests";
              const selectorLines = mergedSelectorContradictions.slice(0, 20);
              const taskParts = [
                `Fix the failing tests (${failSummary}) within scope; keep suite green.`,
                failingNames.length
                  ? `Failing cases:\n${failingNames.slice(0, 20).map((n) => `- ${n}`).join("\n")}`
                  : "",
                selectorLines.length
                  ? `Selector contradictions:\n${selectorLines.map((s) => `- ${s}`).join("\n")}`
                  : "",
              ].filter(Boolean);
              const brief = createDelegationBrief({
                delegationId: `${input.runId}-fix-loop-regen`,
                runId: input.runId,
                objective: `Repair failing QA specs: ${failSummary}`,
                task: taskParts.join("\n\n"),
                acceptanceCriteria: ["Failing cases pass on re-execute", "No writes outside scope"],
                scope: {
                  readablePaths: cfg.isCode ? ["."] : [e2eRelForFix, "src/", "app/"],
                  writablePaths: [writableRootForFix],
                  allowedCommands: [],
                },
                knownFacts: evidence,
                artifactRefs: [
                  ...(this.deps.sidekickDevBaseUrl
                    ? [{ id: "dev-base-url", path: this.deps.sidekickDevBaseUrl }]
                    : []),
                  ...(selectorLines.length
                    ? selectorLines.slice(0, 8).map((s, i) => ({
                        id: `selector-${i}`,
                        path: s.slice(0, 200),
                      }))
                    : []),
                ],
              });
              const sidekickModel = resolveSidekickModel(fixLoopCapability, this.deps.sidekickEscalatedModel);
              const leadFeedback =
                leadContext?.unresolvedQuestions.length
                  ? leadContext.unresolvedQuestions.slice(0, 12).join("\n")
                  : undefined;
              const delegationStarted = Date.now();
              fixLoopSidekickAttempt += 1;
              const delegation = await this.deps.sidekick.execute(brief, {
                cwd: workspace.mirrorDir,
                capability: fixLoopCapability,
                ...(sidekickModel ? { model: sidekickModel } : {}),
                ...(leadFeedback ? { feedback: leadFeedback } : {}),
                signal,
                timeoutMs: this.deps.sidekickTimeoutMs ?? cfg.agentTimeoutMs,
              });
              this.deps.coordinationTelemetry?.record({
                runId: input.runId,
                    kind: "delegation",
                action: orchestration.action,
                capability: fixLoopCapability,
                reason: `fix-loop-regen sidekick status=${delegation.status}`,
                delegationId: brief.delegationId,
                attempt: fixLoopSidekickAttempt,
                durationMs: Date.now() - delegationStarted,
                progressFingerprint: progress.failureFingerprint,
                failureClass: "fail",
                at: Date.now(),
              });
              if (leadContext) {
                leadContext = appendLeadDelegation(leadContext, {
                  delegationId: brief.delegationId,
                  status: delegation.status,
                  summary: delegation.summary,
                });
                if (delegation.unresolvedQuestions.length) {
                  leadContext = appendLeadQuestions(leadContext, delegation.unresolvedQuestions);
                }
              }
              if (delegation.status === "needs-lead") {
                fixLoopSidekickNeedsLead = true;
                const advanced = advanceAfterNeedsLead(fixLoopCapability);
                fixLoopCapability = advanced;
                fixLoopCapabilityFloor = advanced;
                coordinationEscalations += 1;
                this.deps.coordinationTelemetry?.record({
                  runId: input.runId,
                        kind: "escalation",
                  action: "lead-takeover",
                  capability: advanced,
                  reason: "sidekick needs-lead — advance escalation ladder",
                  delegationId: brief.delegationId,
                  attempt: fixLoopSidekickAttempt,
                  progressFingerprint: progress.failureFingerprint,
                  escalations: coordinationEscalations,
                  at: Date.now(),
                });
              }
              const onDisk =
                delegation.status === "completed" || delegation.status === "completed-with-concerns"
                  ? existingWritableFiles(workspace.mirrorDir, delegation.filesChanged, [writableRootForFix])
                  : [];
              if (onDisk.length > 0) {
                const specs = mapSidekickSpecs(onDisk);
                await enforceConfinement();
                pendingSelectorContradictions = [];
                this.deps.observer?.onEvent({
                  type: "log.line",
                  level: "info",
                  text: `coordination active fix-loop-regen: sidekick ${delegation.status} specs=${specs.length}`,
                });
                return {
                  specs,
                  approved: true,
                  note: delegation.summary,
                  specMetas: specs.map((s) => ({ flow: s, objective: brief.objective })),
                };
              }
              const claimed = delegation.filesChanged.length;
              this.deps.observer?.onEvent({
                type: "log.line",
                level: "info",
                text:
                  claimed > 0 &&
                  (delegation.status === "completed" || delegation.status === "completed-with-concerns")
                    ? `coordination active fix-loop-regen: sidekick claimed ${claimed} files but none on disk — falling back to lead GenerationPort`
                    : `coordination active fix-loop-regen: sidekick ${delegation.status} — falling back to lead GenerationPort`,
              });
            } catch (err) {
              console.error(
                `[qa] coordination fix-loop sidekick failed (fail-open — lead GenerationPort runs): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          const r = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
            ...baseEnrichment,
            fixCases: fixLoopInput.fixCases,
            ...(mergedSelectorContradictions.length ? { selectorContradictions: mergedSelectorContradictions } : {}),
            ...(fixLoopInput.domSnapshot ? { domSnapshot: fixLoopInput.domSnapshot } : {}),
          });
          await enforceConfinement();
          /* Pre-exec corrections are one-shot — clear after the first FixLoop regen. */
          pendingSelectorContradictions = [];
          /* Forward just-generated specSources so the next Lever-2 check is not empty. */
          return {
            specs: r.specs,
            approved: r.approved,
            note: r.note,
            specSources: r.specSources,
            ...(r.specMetas ? { specMetas: r.specMetas } : {}),
          };
        },
      };
      const fixLoopSelectorCheck: FixLoopSelectorCheckPort = {
        check: (specSources, trees) => checkSpecSelectors(specSources, trees),
      };
      const fixLoop = new FixLoop({
        execution: fixLoopExecution,
        generation: fixLoopGeneration,
        selectorCheck: fixLoopSelectorCheck,
        /* Re-validate before retry execute so a compile error does not hit live DEV. */
        revalidate: (specDir) => this.deps.validation.validate(specDir),
      });
      /*
       * coverageLikelyMeasured omits the cross-repo conjunct on purpose: a false
       * positive only disables filtered-retry (widens the safety net). Threading true
       * prevents filtered-retry from undercounting change-coverage's denominator.
       */
      const coverageWillMeasure = generating && input.mode === "diff" && cfg.coveragePolicyMode !== "off";
      /* Round 0 Lever-2 seed. Absent when the adapter has no readSpecSource — never fabricated. */
      const initialSpecSources = lastGenerated.specSources;
      /* Failure-point DOM from the initial failing cases, before any FixLoop re-execute. */
      const failureDomSnapshot = buildFailureDomSnapshot(run.cases);
      const fixLoopResult = await fixLoop.run({
        initialRun: { verdict: run.verdict, cases: run.cases },
        isCode: cfg.isCode,
        generating,
        mode: input.mode,
        objectiveSource: [],
        maxRetries: cfg.maxRetries,
        cycleBudget,
        wallClockBudget,
        devHealthy,
        namespace: input.runId,
        coverageWillMeasure,
        ...(initialSpecSources?.length ? { initialSpecSources } : {}),
        ...(failureDomSnapshot ? { failureDomSnapshot } : {}),
        specDir: workspace.specDir,
      });
      run = { verdict: fixLoopResult.run.verdict, cases: fixLoopResult.run.cases, logs: run.logs };
      /* Accumulate onto shared retries (`+=`); a reassignment would drop static-fix rounds. */
      retries += fixLoopResult.retries;
      coverageNamespace = fixLoopResult.coverageNamespace;
      /* Undefined when the loop never reached adjudicate() — never fabricated. */
      lastAdjudicatorVerdictClass = fixLoopResult.lastAdjudicatorVerdict?.class;
      lastAdjudicatorVerdict = fixLoopResult.lastAdjudicatorVerdict;
      fixLoopFinalSpecMetas = fixLoopResult.lastSpecMetas;
    }

    /*
     * Capture executedRed before `if (run.verdict === "pass")` narrows the type;
     * inside that block a fail-check would be an unreachable comparison.
     */
    const finalRunVerdict: typeof run.verdict = run.verdict;

    /* Unknown NEVER blocks. Consumed, never re-implemented. */
    let blocksPublish = false;
    let coverageRatio: number | null = null;
    /*
     * Hoisted for the curriculum fold so pass/fail is not re-derived from ratio.
     * `undefined` means measure never ran. Distinct from a measured "unknown".
     */
    let coverageStatus: "pass" | "fail" | "unknown" | undefined;
    /* null when the oracle is unwired — never a fabricated 0. */
    let valueScore: number | null = null;
    if (run.verdict === "pass") {
      /*
       * onStep("coverage") only when this pass actually measures (diff mode, not
       * cross-repo). Do not emit the step for a pass that never measured.
       */
      if (input.mode === "diff" && !input.triggerRepo) {
        this.deps.observer?.onStep("coverage");
      }
      /*
       * Change-coverage assembler runs only when a real per-commit diff is present.
       * Cross-repo: starve the diff arg so coverage is "unknown" (never blocks) while
       * the value-oracle inside measure() still runs.
       */
      if (input.triggerRepo) {
        /* Log so a cross-repo "unknown" is diagnosable, never a silent null. */
        console.log(`[qa] change-coverage: skipped — the changed lines live in ${input.triggerRepo}; browser coverage maps only the frontend (status=unknown).`);
      }
      /* This pass's own passing case names — the green baseline the fault-injection oracle needs. */
      const baselineCases = run.cases.filter((c) => c.status === "pass").map((c) => c.name);
      const signal = await this.deps.objectiveSignal.measure(
        runBlastRadius,
        workspace.specDir,
        input.triggerRepo ? undefined : classificationDiff,
        baselineCases,
        ...(coverageNamespace ? [{ namespace: coverageNamespace }] : []),
      );
      coverageRatio = signal.ratio;
      coverageStatus = signal.status;
      valueScore = signal.valueScore ?? null;
      /*
       * Ask the port: only enforce+fail blocks. Unknown/pass never block. Do not
       * re-implement the mode check here.
       */
      blocksPublish = this.deps.objectiveSignal.blocks(signal.status);

      /*
       * Enforce-mode one-shot coverage regen. Own boolean, not the FixLoop budget.
       * A regen throw propagates. Validate-fail, non-pass rerun, or 0-spec regen keeps
       * the first measurement's blocksPublish (never fabricated).
       */
      let oneShotCoverageRegenUsed = false;
      if (blocksPublish && input.mode === "diff" && !input.triggerRepo && !oneShotCoverageRegenUsed) {
        oneShotCoverageRegenUsed = true;
        const gap = renderCoverageGap(signal.uncovered ?? []);
        /*
         * The method's AbortSignal parameter is shadowed here by the measure() result
         * `signal`. This generate() omits it rather than rename every `signal.*` read.
         */
        const regen = await this.deps.generation.generate([], workspace.specDir, undefined, classificationDiff, {
          ...baseEnrichment,
          coverageGap: gap,
        });
        await enforceConfinement();
        if (regen.specs.length > 0) {
          const regenValidation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles);
          if (regenValidation.ok) {
            const regenNamespace = `${input.runId}-coverage-regen`;
            const regenRun = await this.deps.execution.execute(workspace.specDir, {
              ...liveExecutionOpts,
              namespace: regenNamespace,
            });
            if (regenRun.verdict === "pass") {
              const regenBaselineCases = regenRun.cases.filter((c) => c.status === "pass").map((c) => c.name);
              /*
               * Re-measure MUST read the regen's own dumps under regenNamespace — never the
               * first run's composition-time namespace.
               */
              const signal2 = await this.deps.objectiveSignal.measure(
                runBlastRadius,
                workspace.specDir,
                classificationDiff,
                regenBaselineCases,
                { namespace: regenNamespace },
              );
              coverageRatio = signal2.ratio;
              coverageStatus = signal2.status;
              blocksPublish = this.deps.objectiveSignal.blocks(signal2.status);
            }
          }
        }
      }
    }

    let reviewerApproved = true;
    /*
     * Default reviewerApproved to generation's own flag (needsReview only) so
     * fail/flaky/invalid paths still have a value. A genuine review call overwrites it.
     */
    let reviewerApprovedForOutcome: boolean | undefined = reviewerApprovedFromGeneration;
    /* Stays [] when the review loop never runs — never fabricated. */
    let finalReviewerCorrections: string[] = [];
    /*
     * Populated only when rationale matches REVIEWER_UNAVAILABLE_MARKER — not on
     * parsed===false alone, and never on a genuine rejection.
     */
    let finalReviewerRationale: string | undefined;
    /*
     * Also gated on generating: a regression run never invokes the reviewer
     * (nothing new to judge; decide()'s !generating branch already wins).
     */
    if (run.verdict === "pass" && cfg.needsReview && generating) {
      /*
       * MAX_REVIEW_ROUNDS = 2. parsed:false is a parse miss — fail closed immediately
       * without burning a regen round. Gate is approved && blockingCount === 0;
       * absent blockingCount defaults to corrections.length (fail-closed).
       * Last-round rejection is terminal. A regen that produces zero specs must not
       * inherit the generator's self-approval.
       */
      const MAX_REVIEW_ROUNDS = 2;
      let reviewCases = run.cases;
      let previousRoundCorrections: string[] | undefined;
      /*
       * Do not set finalReviewerCorrections on parse-miss or executedRed exits
       * (no real reviewer-authored text). Re-capture DOM only when the reviewed spec
       * set changed round-to-round.
       */
      let reviewDomSnapshot: string | undefined;
      /*
       * Sentinel undefined so round 0 always captures — a "" initial would collide
       * with an empty reviewCases key and skip round 0.
       */
      let lastReviewSpecsKey: string | undefined;
      for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
        /* Absent port: snapshot stays undefined (fail-open). Capture must not throw. */
        if (this.deps.reviewDomGrounding) {
          const specsForReview = reviewCases.map((c) => c.file ?? c.name);
          const specsKey = [...specsForReview].sort().join(",");
          if (specsKey !== lastReviewSpecsKey) {
            try {
              reviewDomSnapshot = await this.deps.reviewDomGrounding.capture(workspace.specDir, specsForReview, signal);
            } catch (err) {
              /* Abort during capture stops the run, not an ungrounded review round. */
              if (signal?.aborted) return this.abortedResult(workspace.mirrorDir);
              console.error("[qa] WARNING: reviewer DOM grounding failed (non-fatal, review continues ungrounded):", err);
              reviewDomSnapshot = undefined;
            }
            lastReviewSpecsKey = specsKey;
          }
          if (signal?.aborted) return this.abortedResult(workspace.mirrorDir);
        }
        const reviewResult = await this.deps.review.review(workspace.specDir, reviewCases, classificationDiff, {
          ...baseReviewEnrichment,
          ...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {}),
          ...(reviewDomSnapshot ? { domSnapshot: reviewDomSnapshot } : {}),
        });
        /* parsed:false fails closed immediately, without burning a regeneration round. */
        if (reviewResult.parsed === false) {
          reviewerApproved = false;
          /*
           * Match the unavailable marker, not parsed===false alone. Verdict path is
           * unchanged (still fail-closed via reviewerApproved=false).
           */
          if (reviewResult.rationale?.includes(REVIEWER_UNAVAILABLE_MARKER)) {
            finalReviewerRationale = reviewResult.rationale;
          }
          break;
        }
        /*
         * A reviewer that sees a red spec must not approve it. Round-0-only: after
         * internal regen the spec is fresh and unexecuted. Dormant under the current
         * pass-only entry guard — defense in depth if review becomes reachable on fail.
         */
        const executedRed = round === 0 && finalRunVerdict === "fail";
        if (executedRed) {
          console.error("[qa] executedRed override: the executed run was red — reviewer approval overridden fail-closed (round 0, known-red spec, no regeneration).");
          reviewerApproved = false;
          break;
        }
        const blockingCount = reviewResult.blockingCount ?? reviewResult.corrections.length;
        const gateApproves = reviewResult.approved && blockingCount === 0;
        reviewerApproved = gateApproves;
        /*
         * Only a rejecting round's corrections become a learning/errorClass signal.
         * An approving round clears them, including its own advisory notes — otherwise
         * a passing run would derive a failure class.
         */
        finalReviewerCorrections = gateApproves ? [] : reviewResult.corrections;
        if (gateApproves) break;
        /* Rejected. Terminal on the last round — no further regeneration. */
        if (round === MAX_REVIEW_ROUNDS - 1) break;
        retries++;
        this.deps.observer?.onStep("retry", `reviewer-correction round ${round + 1}/${MAX_REVIEW_ROUNDS}`);
        previousRoundCorrections = reviewResult.corrections;
        const regen = await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
          ...baseEnrichment,
          reviewCorrections: reviewResult.corrections,
        });
        await enforceConfinement();
        if (regen.specs.length === 0) {
          /* A regen that produced no reviewable specs must not inherit the generator's self-approval. */
          reviewerApproved = false;
          break;
        }
        /* This loop does not re-execute regenerated specs against DEV. Execution evidence is round-0-only. */
        reviewCases = regen.specs.map((file) => ({ name: file, file, status: run.cases[0]?.status ?? "pass" }));
      }
      /* A genuine review verdict overwrites generation's self-approval default. */
      reviewerApprovedForOutcome = reviewerApproved;
    }

    /* Publish never emits its own step; "decide" covers the decide+publish pair. */
    this.deps.observer?.onStep("decide");
    const evidence: RunEvidence = {
      verdict: run.verdict,
      generating,
      needsReview: cfg.needsReview,
      reviewerApproved,
      blocksPublish,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
    };
    const decision = decide(evidence);

    if (this.deps.coordination && this.deps.coordinationTelemetry) {
      const reviewOutcome =
        !cfg.needsReview ? "skipped" as const
        : reviewerApproved === true ? "approved" as const
        : reviewerApproved === false ? "rejected" as const
        : "n/a" as const;
      this.deps.coordinationTelemetry.record({
        runId: input.runId,
        kind: "outcome",
        action: coordinationProposal?.decision.action,
        capability: coordinationProposal?.decision.nextCapability,
        reason: `pipeline verdict=${decision.verdict}`,
        finalOutcome: decision.verdict,
        reviewOutcome,
        /* Quality sampled at the same instant the outcome is stamped. */
        ...(coverageRatio !== undefined
          ? { coverageRatio }
          : {}),
        ...(valueScore !== null ? { valueScore } : {}),
        escalations: coordinationEscalations,
        durationMs: Date.now() - startedAt,
        at: Date.now(),
      });
    }

    /*
     * Every side-effect-bearing decision calls publish — not just "pr". "none" is
     * the only skip. Thread this run's reviewerApproved and blocksPublish so a
     * green-but-rejected run opens an Issue and an enforce coverage fail holds the PR.
     * e2eChanged is omitted (no computed source — do not fabricate).
     * Cross-repo Issues file in triggerRepo; PRs still target the primary.
     */
    await enforceConfinement();
    let publishOutcome: string | undefined;
    if (decision.sideEffect !== "none") {
      /*
       * Publication can throw after a verdict is already decided. Catch here, keep
       * the decided record, and surface the hop failure as a diagnostic. Non-Error
       * throws still escape.
       */
      let published: Awaited<ReturnType<PublicationPort["publish"]>>;
      try {
        published = await this.deps.publication.publish({
        verdict: run.verdict,
        cases: run.cases,
        logs: run.logs,
        reviewerApproved,
        coverageBlocks: blocksPublish,
        ...(input.triggerRepo ? { issueRepo: input.triggerRepo } : {}),
        /* Adjudication is absent when FixLoop never engaged — never fabricated. */
        ...(lastAdjudicatorVerdict ? { adjudication: lastAdjudicatorVerdict } : {}),
        /* Reviewer-unavailable note is marker-scoped — never fabricated. */
        ...(finalReviewerRationale ? { reviewerNote: finalReviewerRationale } : {}),
        /* Real per-run mirrorDir + sha for the "pr" git-write. This is the only pr-capable call site. */
        mirrorDir: workspace.mirrorDir,
        sha: input.sha.toString(),
        /*
         * tested omitted when empty. parentRunId only from /continue — never fabricated.
         * Intra-run regens reuse this same input object.
         */
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        isCode: cfg.isCode,
        ...(resolveTested()?.length ? { tested: resolveTested() } : {}),
      });
      } catch (pubErr) {
        return this.infraErrorResult(
          `publication failed after verdict was decided (decided: ${run.verdict}, reviewerApproved: ${reviewerApproved}): ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`,
          workspace.mirrorDir,
        );
      }
      publishOutcome = published.outcome;
      /*
       * Merge denylist reverts into gateSignals.confinement. Count only
       * revertedDangerous toward dangerous — not every revert is a secret leak.
       * Absent revertedDangerous is treated as zero, never "everything is dangerous".
       */
      if (published.revertedDenylisted?.length) {
        confinementAcc = {
          strays: (confinementAcc?.strays ?? 0) + published.revertedDenylisted.length,
          dangerous: (confinementAcc?.dangerous ?? 0) + (published.revertedDangerous?.length ?? 0),
          reverted: [...(confinementAcc?.reverted ?? []), ...published.revertedDenylisted],
        };
      }
    }

    /* Once, after confinement and publish, so gc never races this run's git write. */
    await this.pruneMirrorIfWired(workspace.mirrorDir);

    /*
     * A clean context-mode pass must not persist or fold. Other context outcomes
     * (e.g. context-invalid) still persist+fold.
     */
    const isContextCleanPass = input.mode === "context" && decision.verdict === "pass";
    /* Derive errorClass/valueScore once for both the persisted outcome and the returned result. */
    const gateValueScore = valueScore;
    /* Thread the review loop's real final-round corrections into errorClass derivation. */
    const errorClass = this.deriveErrorClass(decision.verdict, coverageRatio, gateValueScore, finalReviewerCorrections);
    let mainlineOutcome: RunOutcome | undefined;
    if (!isContextCleanPass) {
      mainlineOutcome = this.toRunOutcome(input, decision, run.cases, retries, coverageRatio, errorClass, {
        staticOk: validation.ok,
        reviewerApproved: reviewerApprovedForOutcome,
        valueScore: gateValueScore,
        reviewerCorrections: finalReviewerCorrections,
        /* Persist reviewer-unavailable rationale only when the marker matched — never fabricated. */
        ...(finalReviewerRationale ? { reviewerRationale: finalReviewerRationale } : {}),
        /* Publish outcome string — never fabricated when publish() was not called. */
        ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
        /* Rule ids on the mainline persist only. Other exits omit them. */
        ...(retrievedRuleIds.length ? { rulesRetrieved: retrievedRuleIds } : {}),
        /* Real pre-exec counters, not a hardcoded 0. */
        preExecAmbiguityCatches,
        deterministicSelectorBlocks,
        catalogGateInWindow,
        catalogGateAdvisory,
        catalogGateFailClosed,
        /*
         * structuralSignalBytes is gated on a non-empty render (empty is not "0 bytes").
         * serviceLinksCount/contractDriftCount are gated on the resolver being wired,
         * so 0 means "ran, found none", distinct from unwired.
         */
        ...(blastRadiusSignal ? { structuralSignalBytes: Buffer.byteLength(blastRadiusSignal, "utf8") } : {}),
        ...(this.deps.serviceLinks
          ? { serviceLinksCount: resolvedServiceLinks.length, contractDriftCount: resolvedContractDrift.length }
          : {}),
        /*
         * impactedLinksCount is gated on the result, not the collaborator's presence:
         * a same-repo run stays undefined (never ran), not a fabricated 0.
         */
        ...(crossRepoImpact ? { crossRepoImpactedCount: crossRepoImpact.impactedLinks.length } : {}),
        logs: run.logs,
        adjudicationClass: lastAdjudicatorVerdictClass,
        /* Merged confinement across every enforce() this run made. Omitted when never wired. */
        ...(confinementAcc !== undefined ? { confinement: confinementAcc } : {}),
      });
      await this.deps.runHistory.save(mainlineOutcome);

      /*
       * Off-path: never gates the verdict. app_defect suppresses the fold so the
       * flywheel never learns to weaken a test that caught a real bug.
       */
      if (shouldDistillLearning(cfg.isCode, decision.verdict, mainlineOutcome.adjudication?.class)) {
        await this.deps.learning.fold(mainlineOutcome);
      }

      /*
       * Off-path. Deliberately NOT gated on shouldDistillLearning: app_defect is the
       * curriculum's strongest positive signal. Only the mainline exit folds —
       * invalid/infra-error never executed a suite.
       */
      if (offeredArchetypes.length > 0) {
        await this.deps.curriculum?.fold({
          offered: offeredArchetypes,
          verdict: decision.verdict,
          ...(mainlineOutcome.adjudication?.class !== undefined ? { adjudicationClass: mainlineOutcome.adjudication.class } : {}),
          ...(coverageStatus !== undefined ? { coverageStatus } : {}),
        });
      }

      /*
       * Stricter than fold: no flaky/E-INFRA/E-FLAKY, and errorClass must be a real
       * non-empty class (a green pass must not mint a reflection rule). Fold-on-green
       * is unchanged. Fault-isolated in the adapter.
       */
      if (
        this.deps.reflector &&
        shouldDistillLearning(cfg.isCode, decision.verdict, mainlineOutcome.adjudication?.class) &&
        decision.verdict !== "flaky" &&
        mainlineOutcome.errorClass !== "E-INFRA" &&
        mainlineOutcome.errorClass !== "E-FLAKY" &&
        mainlineOutcome.errorClass != null &&
        mainlineOutcome.errorClass !== ""
      ) {
        /* reflect() is awaited inline so the persisted outcome includes the back-fill before the run closes. */
        const reflectStartedAt = Date.now();
        /* Archetype from classificationDiff; undefined outside diff mode — never fabricated. */
        const archetype = detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []);
        await this.deps.reflector.reflect(this.toReflectionInput(mainlineOutcome, archetype));
        const reflectMs = Date.now() - reflectStartedAt;
        this.deps.observer?.onEvent({
          type: "log.line",
          level: "info",
          text: `[qa] reflect() for run ${mainlineOutcome.runId} took ${reflectMs}ms`,
        });
      }

      /* Same gate as reflect, duplicated so processAudit and reflector stay independently optional. */
      if (
        this.deps.processAudit &&
        shouldDistillLearning(cfg.isCode, decision.verdict, mainlineOutcome.adjudication?.class) &&
        decision.verdict !== "flaky" &&
        mainlineOutcome.errorClass !== "E-INFRA" &&
        mainlineOutcome.errorClass !== "E-FLAKY" &&
        mainlineOutcome.errorClass != null &&
        mainlineOutcome.errorClass !== ""
      ) {
        /* Audit duration on the existing log.line channel. */
        const auditStartedAt = Date.now();
        await this.deps.processAudit.audit(mainlineOutcome);
        const auditMs = Date.now() - auditStartedAt;
        this.deps.observer?.onEvent({
          type: "log.line",
          level: "info",
          text: `[qa] processAudit.audit() for run ${mainlineOutcome.runId} took ${auditMs}ms`,
        });
      }
    }

    this.deps.observer?.onStep("done");
    return {
      decision,
      errorClass,
      ...(mainlineOutcome ? { outcome: mainlineOutcome } : {}),
      /* Same publish outcome on the returned result for callers with no history read-back. */
      ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
      /* A clean context pass never persists, so the returned result must not report retrieved rules either. */
      rulesRetrieved: isContextCleanPass ? [] : retrievedRuleIds,
      gateSignals: {
        /* Clean context pass reports static:false — nothing was genuinely persisted. */
        static: isContextCleanPass ? false : validation.ok,
        coverageRatio,
        valueScore: gateValueScore,
        /* Clean context pass omits reviewerApproved — nothing was genuinely persisted. */
        ...(!isContextCleanPass && reviewerApprovedForOutcome !== undefined ? { reviewerApproved: reviewerApprovedForOutcome } : {}),
        retries,
        preExecAmbiguityCatches,
        deterministicSelectorBlocks,
        catalogGateInWindow,
        catalogGateAdvisory,
        catalogGateFailClosed,
      },
      cases: run.cases,
      logs: run.logs,
    };
  }

  /*
   * Shared errorClass derivation. Callers that never reach review omit
   * reviewerCorrections and get [].
   */
  private deriveErrorClass(verdict: string, coverageRatio: number | null, valueScore: number | null, reviewerCorrections: string[] = []): string | null {
    return resolveErrorClass({
      verdict,
      coverageRatio,
      minCoverageRatio: DEFAULT_MIN_COVERAGE_RATIO,
      reviewerCorrections,
      valueScore,
    });
  }

  /*
   * Narrow ReflectionInput from an already-persisted RunOutcome only — no repo
   * reads. logs/note are unreachable here so a reflection prompt cannot leak them.
   * archetype is computed by the caller (outcome carries no diff).
   */
  private toReflectionInput(outcome: RunOutcome, archetype: string | null): ReflectionInput {
    return {
      runId: outcome.runId,
      app: outcome.app,
      sha: outcome.sha,
      mode: outcome.mode,
      verdict: outcome.verdict,
      /*
       * errorClass is string | null on the outcome. Coalesce to "" defensively; the
       * reflect gate already requires a non-null non-empty class before this is called.
       */
      errorClass: outcome.errorClass ?? "",
      gateSignals: {
        static: outcome.gateSignals.static,
        coverageRatio: outcome.gateSignals.coverageRatio,
        valueScore: outcome.gateSignals.valueScore,
        reviewerCorrections: outcome.gateSignals.reviewerCorrections,
        flaky: outcome.gateSignals.flaky,
        retries: outcome.gateSignals.retries,
      },
      archetype,
    };
  }

  private toRunOutcome(
    input: RunQaInput,
    decision: RunDecision,
    cases: QaCase[],
    retries: number,
    coverageRatio: number | null,
    errorClass: string | null,
    /*
     * reviewerApproved, valueScore, and rulesRetrieved are optional: early exits
     * never reached those phases and must not fabricate them. Pre-exec counters
     * default to 0 (not undefined) when the gate never ran.
     */
    extra?: {
      /* Only callers whose path genuinely passed the static gate thread true; default is false. */
      staticOk?: boolean;
      reviewerApproved?: boolean;
      /* Only the mainline post-review caller threads real corrections; others get []. */
      reviewerCorrections?: string[];
      /* Only the marker-scoped reviewer-unavailable exit threads a rationale. */
      reviewerRationale?: string;
      valueScore?: number | null;
      note?: string;
      rulesRetrieved?: string[];
      preExecAmbiguityCatches?: number;
      deterministicSelectorBlocks?: number;
      catalogGateInWindow?: number;
      catalogGateAdvisory?: number;
      catalogGateFailClosed?: number;
      /* Optional telemetry. Construction uses conditional-spread, not `?? 0`. */
      structuralSignalBytes?: number;
      serviceLinksCount?: number;
      contractDriftCount?: number;
      /* Same "never ran" vs "ran and found zero" distinction as the sibling counts. */
      crossRepoImpactedCount?: number;
      /* Only the mainline post-execute caller has real logs. */
      logs?: string;
      /* Only the mainline post-FixLoop caller has a real adjudication class. */
      adjudicationClass?: string;
      /* Omitted entirely when confinement never ran — never a fabricated {strays:0}. */
      confinement?: { strays: number; dangerous: number; reverted: string[] };
    },
  ) {
    const gateCoverageRatio = coverageRatio;
    const gateValueScore = extra?.valueScore ?? null;
    return {
      runId: input.runId,
      app: input.app,
      sha: input.sha.toString(),
      mode: input.mode,
      target: input.target,
      verdict: decision.verdict,
      errorClass,
      gateSignals: {
        /* Default staticOk is false. Callers pass the real per-path value. */
        static: extra?.staticOk ?? false,
        coverageRatio: gateCoverageRatio,
        valueScore: gateValueScore,
        reviewerCorrections: extra?.reviewerCorrections ?? [],
        /* Conditional-spread: true undefined survives when no reviewer-unavailable rationale exists. */
        ...(extra?.reviewerRationale !== undefined ? { reviewerRationale: extra.reviewerRationale } : {}),
        ...(extra?.reviewerApproved !== undefined ? { reviewerApproved: extra.reviewerApproved } : {}),
        flaky: decision.verdict === "flaky",
        retries,
        preExecAmbiguityCatches: extra?.preExecAmbiguityCatches ?? 0,
        deterministicSelectorBlocks: extra?.deterministicSelectorBlocks ?? 0,
        catalogGateInWindow: extra?.catalogGateInWindow ?? 0,
        catalogGateAdvisory: extra?.catalogGateAdvisory ?? 0,
        catalogGateFailClosed: extra?.catalogGateFailClosed ?? 0,
        /*
         * Conditional-spread, not `?? 0`: "never ran" stays distinguishable from
         * "ran and found zero".
         */
        ...(extra?.structuralSignalBytes !== undefined ? { structuralSignalBytes: extra.structuralSignalBytes } : {}),
        ...(extra?.serviceLinksCount !== undefined ? { serviceLinksCount: extra.serviceLinksCount } : {}),
        ...(extra?.contractDriftCount !== undefined ? { contractDriftCount: extra.contractDriftCount } : {}),
        ...(extra?.crossRepoImpactedCount !== undefined ? { crossRepoImpactedCount: extra.crossRepoImpactedCount } : {}),
        ...(extra?.confinement !== undefined ? { confinement: extra.confinement } : {}),
      },
      rulesRetrieved: extra?.rulesRetrieved ?? [],
      ...(extra?.note !== undefined ? { note: extra.note } : {}),
      at: new Date().toISOString(),
      /* Persist the same cases + logs the returned result carries. Non-execute callers pass []. */
      cases,
      ...(extra?.logs !== undefined ? { logs: extra.logs } : {}),
      /* Conditional-spread — only when FixLoop genuinely produced a verdict class. */
      ...(extra?.adjudicationClass !== undefined ? { adjudication: { class: extra.adjudicationClass } } : {}),
    };
  }

  private skippedResult(
    /* Only the agent-no-op skip passes reviewerApproved. Classify-skip never persists. */
    reviewerApprovedForOutcome?: boolean,
  ): RunQaResult {
    this.deps.observer?.onStep("done");
    return {
      decision: RunDecision.of("skipped", "none"),
      /* Skipped always resolves errorClass:null — skipped runs teach nothing. */
      errorClass: this.deriveErrorClass("skipped", null, null),
      gateSignals: {
        static: false,
        coverageRatio: null,
        valueScore: null,
        ...(reviewerApprovedForOutcome !== undefined ? { reviewerApproved: reviewerApprovedForOutcome } : {}),
        retries: 0,
        preExecAmbiguityCatches: 0,
        deterministicSelectorBlocks: 0,
        catalogGateInWindow: 0,
        catalogGateAdvisory: 0,
        catalogGateFailClosed: 0,
      },
      cases: [],
      /* Neither skip source persists retrieved rule ids. */
      rulesRetrieved: [],
    };
  }

  /*
   * Every infra-error terminal carries a diagnostic note and is logged loudly.
   * mirrorDir is passed only when prepare() already ran; the entry-gate deploy
   * failure omits it (the mirror was never touched).
   */
  private async infraErrorResult(note?: string, mirrorDir?: string): Promise<RunQaResult> {
    if (note !== undefined) {
      console.error("[qa] infra-error terminal:", note);
    }
    this.deps.observer?.onStep("done");
    if (mirrorDir) {
      await this.pruneMirrorIfWired(mirrorDir);
    }
    return {
      decision: RunDecision.of("infra-error", "none"),
      /* Entry-gate infra-error never persists. errorClass is still derived for the returned result. */
      errorClass: this.deriveErrorClass("infra-error", null, null),
      gateSignals: { static: false, coverageRatio: null, valueScore: null, retries: 0, preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 },
      cases: [],
      rulesRetrieved: [],
      ...(note !== undefined ? { note } : {}),
    };
  }

  /*
   * A cancelled run is not a learner failure: same shape as infra-error, never
   * persisted. No note here — the runner writes "cancelled by operator" on the
   * record; a note here would clash. mirrorDir only when prepare() already ran.
   */
  private async abortedResult(mirrorDir?: string): Promise<RunQaResult> {
    return this.infraErrorResult(undefined, mirrorDir);
  }

  /*
   * Fault-isolated gc for every exit that already called prepare(). Entry-gate
   * exits before prepare() never call this. A thrown prune() is logged and never
   * alters the verdict.
   */
  private async pruneMirrorIfWired(mirrorDir: string): Promise<void> {
    if (!this.deps.mirrorGc) return;
    try {
      await this.deps.mirrorGc.prune(mirrorDir);
    } catch (err) {
      console.error(
        `[qa] mirror gc FAILED (fault-isolated — run continues, never blocks publish): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /* Both terminals persist. Only "invalid" also folds; "infra-error" does not. */
  private async terminalResult(
    verdict: "invalid" | "infra-error",
    cfg: RunQaConfig,
    input: RunQaInput,
    ev: { generating: boolean; static: boolean },
    /* Both terminals run after generation, so the generation-sourced reviewerApproved default applies. */
    reviewerApprovedForOutcome?: boolean,
    /*
     * Context-mode invalid does not persist or fold (Issue only), like a clean
     * context pass. Unlike an undocumented bypass of onFailure, this path honors
     * the same decide() sideEffect as every other invalid verdict.
     */
    skipPersist = false,
    /* Static-fix retries consumed before landing on this invalid exit. */
    retries = 0,
    /* Optional diagnostic note. Omitted when the caller has nothing more specific than the verdict. */
    note?: string,
    /* Both call sites fire after the pre-exec gate; counters are real, defaulting to 0. */
    groundingSignals: {
      preExecAmbiguityCatches: number;
      deterministicSelectorBlocks: number;
      catalogGateInWindow: number;
      catalogGateAdvisory: number;
      catalogGateFailClosed: number;
    } = { preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 },
    /* Both call sites fire after retrieve(); ids are real, defaulting to []. */
    rulesRetrieved: string[] = [],
    /* Diff-derived archetype; null when there is no diff — never fabricated. */
    archetype: string | null = null,
    /* Merged confinement from the caller's enforce immediately before this helper. Undefined if never ran. */
    confinement?: { strays: number; dangerous: number; reverted: string[] },
    /* Caller's resolveTested() result. Undefined when there are no specMetas — never fabricated. */
    tested?: { flow?: string; objective?: string }[],
    /* Real per-run mirrorDir after prepare(). Undefined skips prune. */
    mirrorDir?: string,
  ): Promise<RunQaResult> {
    const decision = decide({
      verdict,
      generating: ev.generating,
      needsReview: cfg.needsReview,
      reviewerApproved: true,
      blocksPublish: false,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
    });
    /* invalid → E-STATIC, infra-error → E-INFRA. */
    const errorClass = this.deriveErrorClass(verdict, null, null);
    /*
     * Dispatch the same publish() as the mainline. infra-error resolves to
     * sideEffect "none" via decide() — no Issue.
     */
    let publishOutcome: string | undefined;
    if (decision.sideEffect !== "none") {
      const published = await this.deps.publication.publish({
        verdict,
        cases: [],
        logs: note ?? "",
        reviewerApproved: reviewerApprovedForOutcome,
        coverageBlocks: false,
        ...(input.triggerRepo ? { issueRepo: input.triggerRepo } : {}),
        /* isCode and tested still render into the Issue body when present. This helper never routes to "pr". */
        isCode: cfg.isCode,
        ...(tested?.length ? { tested } : {}),
      });
      publishOutcome = published.outcome;
    }
    /* Prune after this exit's publish() (or immediately when sideEffect is none). Absent mirrorDir is a no-op. */
    if (mirrorDir) {
      await this.pruneMirrorIfWired(mirrorDir);
    }
    /* Append the publish outcome onto the note; never clobber an existing diagnostic. */
    const combinedNote = [note, publishOutcome].filter((part): part is string => Boolean(part)).join("\n\n") || undefined;
    let terminalOutcome: RunOutcome | undefined;
    if (!skipPersist) {
      terminalOutcome = this.toRunOutcome(input, decision, [], retries, null, errorClass, {
        staticOk: ev.static,
        reviewerApproved: reviewerApprovedForOutcome,
        note: combinedNote,
        ...groundingSignals,
        /* Empty retrieved ids omit the override; non-empty reach persist so the terminal fold can attribute. */
        ...(rulesRetrieved.length ? { rulesRetrieved } : {}),
        ...(confinement !== undefined ? { confinement } : {}),
      });
      await this.deps.runHistory.save(terminalOutcome);
      /*
       * Same shouldDistillLearning guard as the mainline. Adjudication is always
       * undefined here today (FixLoop has not run); kept so a future reorder cannot
       * bypass app_defect suppression.
       */
      if (verdict === "invalid" && shouldDistillLearning(cfg.isCode, verdict, terminalOutcome.adjudication?.class)) {
        await this.deps.learning.fold(terminalOutcome);
      }

      /*
       * Same stricter reflect gate as the mainline. This path is already narrowed to
       * invalid (not flaky/infra-error); errorClass is always E-STATIC so a null-class
       * conjunct is unnecessary here.
       */
      if (
        this.deps.reflector &&
        verdict === "invalid" &&
        shouldDistillLearning(cfg.isCode, verdict, terminalOutcome.adjudication?.class) &&
        terminalOutcome.errorClass !== "E-INFRA" &&
        terminalOutcome.errorClass !== "E-FLAKY"
      ) {
        const reflectStartedAt = Date.now();
        await this.deps.reflector.reflect(this.toReflectionInput(terminalOutcome, archetype));
        const reflectMs = Date.now() - reflectStartedAt;
        this.deps.observer?.onEvent({
          type: "log.line",
          level: "info",
          text: `[qa] reflect() for run ${terminalOutcome.runId} took ${reflectMs}ms`,
        });
      }

      /* Same independently-optional processAudit gate as the mainline, duplicated on purpose. */
      if (
        this.deps.processAudit &&
        verdict === "invalid" &&
        shouldDistillLearning(cfg.isCode, verdict, terminalOutcome.adjudication?.class) &&
        terminalOutcome.errorClass !== "E-INFRA" &&
        terminalOutcome.errorClass !== "E-FLAKY"
      ) {
        const auditStartedAt = Date.now();
        await this.deps.processAudit.audit(terminalOutcome);
        const auditMs = Date.now() - auditStartedAt;
        this.deps.observer?.onEvent({
          type: "log.line",
          level: "info",
          text: `[qa] processAudit.audit() for run ${terminalOutcome.runId} took ${auditMs}ms`,
        });
      }
    }
    this.deps.observer?.onStep("done");
    return {
      decision,
      ...(terminalOutcome ? { outcome: terminalOutcome } : {}),
      /*
       * skipPersist (context-mode invalid): report errorClass null — nothing was
       * genuinely persisted.
       */
      errorClass: skipPersist ? null : errorClass,
      gateSignals: {
        /* When skipPersist, static/reviewerApproved/retries also reflect that nothing was persisted. */
        static: skipPersist ? false : ev.static,
        coverageRatio: null,
        valueScore: null,
        ...(!skipPersist && reviewerApprovedForOutcome !== undefined ? { reviewerApproved: reviewerApprovedForOutcome } : {}),
        retries: skipPersist ? 0 : retries,
        preExecAmbiguityCatches: skipPersist ? 0 : groundingSignals.preExecAmbiguityCatches,
        deterministicSelectorBlocks: skipPersist ? 0 : groundingSignals.deterministicSelectorBlocks,
        catalogGateInWindow: skipPersist ? 0 : groundingSignals.catalogGateInWindow,
        catalogGateAdvisory: skipPersist ? 0 : groundingSignals.catalogGateAdvisory,
        catalogGateFailClosed: skipPersist ? 0 : groundingSignals.catalogGateFailClosed,
      },
      cases: [],
      /*
       * Return retrieved ids unless skipPersist. An invalid/infra-error where retrieved
       * rules did not prevent the verdict is legitimate fold evidence.
       */
      rulesRetrieved: skipPersist ? [] : rulesRetrieved,
      ...(!skipPersist && combinedNote !== undefined ? { note: combinedNote } : {}),
    };
  }
}
