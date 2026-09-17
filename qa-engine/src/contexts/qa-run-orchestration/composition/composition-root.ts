/* Composition root: the only qa-engine module allowed to import concrete adapters from sibling contexts (arch-lint VCS-write gate). Wires qa-run-orchestration ports to real bridge adapters. PIPELINE_ENGINE is consulted only so a stale operator value gets a deprecation warning, never a different code path.
buildShadow always uses this engine with shadow-log publication and in-memory history — zero side effects on the watched repo or production history. */

import { join } from "node:path";
import type { Sha } from "@kernel/sha.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import type { RunPipelinePort, ObserverPort, RunHistoryPort, ConfinementPort, MirrorGcPort, CurriculumPort } from "../application/ports/index.ts";
import { RewrittenOrchestratorAdapter, type RewrittenOrchestratorAdapterDeps } from "../infrastructure/rewritten-orchestrator.adapter.ts";
import { selectEngine } from "./pipeline-engine-flag.ts";
import { createCoordinationPort } from "../application/coordination/create-coordination-port.ts";
import { SidekickExecutor } from "../application/coordination/sidekick-executor.ts";
import { getSharedCoordinationTelemetry } from "../application/coordination/shared-telemetry.ts";

import { ChangeAnalysisPortAdapter } from "../infrastructure/bridges/change-analysis-port.adapter.ts";
import { GenerationPortAdapter, type GenerationPortCollaborators } from "../infrastructure/bridges/generation-port.adapter.ts";
import { ReviewPortAdapter, type ReviewPortRuntime } from "../infrastructure/bridges/review-port.adapter.ts";
import { ValidationPortAdapter } from "../infrastructure/bridges/validation-port.adapter.ts";
import { ExecutionPortAdapter } from "../infrastructure/bridges/execution-port.adapter.ts";
import { ObjectiveSignalPortAdapter } from "../infrastructure/bridges/objective-signal-port.adapter.ts";
import { PublicationPortAdapter, type GitHubPrCollaborator, type GitHubIssueCollaborator, type VcsPublishCollaborator } from "../infrastructure/bridges/publication-port.adapter.ts";
import { LearningPortAdapter } from "../infrastructure/bridges/learning-port.adapter.ts";
import { WorkspacePortAdapter, type CheckoutFn } from "../infrastructure/bridges/workspace-port.adapter.ts";
import { DeployGatePortAdapter, NullDeployGateAdapter, type VersionPollFn } from "../infrastructure/bridges/deploy-gate-port.adapter.ts";
import { InMemoryRunHistoryAdapter, FileRunHistoryAdapter } from "../infrastructure/bridges/run-history-port.adapter.ts";
import { SetupPortAdapter, type SetupPortCollaborators } from "../infrastructure/bridges/setup-port.adapter.ts";
import { CleanupPortAdapter, type CleanupPortCollaborators } from "../infrastructure/bridges/cleanup-port.adapter.ts";
import { PreGenerationGroundingPortAdapter, type PreGenerationGroundingCollaborators } from "../infrastructure/bridges/pre-generation-grounding-port.adapter.ts";
import { ReviewDomGroundingPortAdapter, type ReviewDomGroundingCollaborators } from "../infrastructure/bridges/review-dom-grounding-port.adapter.ts";
import { PreExecGroundingPortAdapter, type PreExecGroundingCollaborators } from "../infrastructure/bridges/pre-exec-grounding-port.adapter.ts";
import { StructuralSignalPortAdapter } from "../infrastructure/bridges/structural-signal-port.adapter.ts";
import { LazyProjectCodeGraphAdapter } from "../../../shared-infrastructure/code-graph/lazy-project-code-graph.adapter.ts";
import { ProjectNameResolver, type ProjectNameCliClient } from "../../../shared-infrastructure/code-graph/resolve-project-name.ts";
import type { CodebaseMemoryCliClient } from "../../../shared-infrastructure/code-graph/codebase-memory-code-graph.adapter.ts";
import type { IndexStatusPort } from "@kernel/ports/index-status.port.ts";
import { ServiceLinksPortAdapter } from "../infrastructure/bridges/service-links-port.adapter.ts";
import { MirrorRegistryAdapter } from "@contexts/service-topology/infrastructure/mirror-registry.adapter.ts";
import type { BoundaryProfileProviderPort } from "@contexts/service-topology/application/ports/index.ts";
import { CrossRepoImpactPortAdapter } from "../infrastructure/bridges/cross-repo-impact-port.adapter.ts";
import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

import { GenerateTestsUseCase, type GenerationResult, type GenerateOpts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput, ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/ports/index.ts";
import type { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import type { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import type { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy.ts";
import { DecideCoverageService, type CoveragePolicy, type ChangeCoverage } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageCollectorPort, ValueOraclePort } from "@contexts/objective-signal/application/ports/index.ts";
import { PublishDecisionService } from "@contexts/workspace-and-publication/domain/publish-decision.service.ts";
import { ShadowLogAdapter } from "@contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts";
import { renderIssue, renderPrBody } from "@contexts/workspace-and-publication/domain/render-publication.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/ports/index.ts";
import type { LearningRepositoryPort, ReflectorPort, ProcessAuditPort } from "@contexts/cross-run-learning/application/ports/index.ts";
import { StubLearningRepository } from "@contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts";

export interface CompositionConfig {
  /* Static per-run context (shared across GenerationPort/ReviewPort/ExecutionPort/PublicationPort). */
  repo: string;
  appName: string;
  mirrorDir: string;
  e2eRelDir: string;
  branch: string;
  target: TestTarget;
  mode: RunMode;
  needsReview: boolean;
  shadow: boolean;
  onFailure: string;
  maxRetries: number;
  isCode: boolean;
  coveragePolicyMode: "off" | "signal" | "enforce";
  /* Per-mode agent session budget (ms). Factory maps agentTimeout(mode). Optional: omitted fakes keep the use-case default (0 = derived but not enforced). */
  agentTimeoutMs?: number;
  wallClockBudgetMs?: number;
  iterationBudget?: number;
  guidance?: string;
  diff?: string;
  baseUrl?: string;
  openapi?: string | string[];
  testIdAttribute?: string;

  /* ChangeAnalysisPort collaborator. */
  vcs: VcsReadPort;

  /* GenerationPort collaborator — an ALREADY-CONSTRUCTED use-case (its own leaf IO ports are the generation context's own concern) plus the optional specSources file-read collaborator. */
  generationUseCase: {
    generate(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult>;
  };
  readSpecSource?: GenerationPortCollaborators["readSpecSource"];

  /* ReviewPort collaborator — the SAME 3 generation-owned primitives the bridge composes standalone. */
  reviewRuntime: {
    runtime: Pick<AgentRuntimePort, "openSession">;
    rendering: Pick<PromptRenderingPort, "renderReviewer">;
    verdicts: Pick<VerdictParserPort, "parseReview">;
  };
  reviewTimeoutMs?: number;

  validationStrategies: {
    e2e: Pick<StaticGateAdapter, "validateAll">;
    code: Pick<CodeValidationStrategy, "validate">;
  };

  /* ExecutionPort collaborator — target-selected strategy dispatch. */
  executionStrategies: {
    e2e: Pick<E2eExecutionStrategy, "run">;
    code: Pick<CodeExecutionStrategy, "run">;
  };

  /* SetupPort collaborator — target-selected dispatch. Optional: absent → the use-case setup phase is a no-op. */
  setupCollaborators?: SetupPortCollaborators;

  cleanupCollaborators?: CleanupPortCollaborators;

  groundingCollaborators?: PreGenerationGroundingCollaborators;
  reviewDomGroundingCollaborators?: ReviewDomGroundingCollaborators;
  preExecGroundingCollaborators?: PreExecGroundingCollaborators;
  codebaseMemory?: ProjectNameCliClient & CodebaseMemoryCliClient;
  /* Per-run lastIndexedSha sidecar. OPTIONAL: absent-omit — never default-constructed here (tests/fakes stay byte-identical when omitted). The shell factory supplies IndexStatusAdapter. Indexing itself also needs codeGraph (built from codebaseMemory below); either absent is a no-op. */
  indexStatus?: IndexStatusPort;
  /* Classify-source repo root for CodeGraphPort.syncTo and StructuralSignalPortAdapter. Factory sets this to the SERVICE mirror on a webhook, PRIMARY otherwise. Absent → cfg.mirrorDir. */
  codeGraphRepoDir?: string;
  serviceTopology?: {
    appName: string;
    primaryRepo: string;
    mirrorRoot: string;
    services: readonly { repo: string }[];
    boundaryProfiles: BoundaryProfileProviderPort;
  };
  crossRepoImpact?: {
    mirrorRoot: string;
    codebaseMemory: ProjectNameCliClient & CodebaseMemoryCliClient;
    runner: SandboxedBinaryRunner;
  };
  /* Triggering microservice for a cross-repo run — its repo, its own read-only mirror dir, and its own openapi hint. Prompt-context only (GenerationPortAdapter → OpencodeRunInput.service). No verdict/gate/coverage/publish path reads it. Absent in the same-repo case — never a stub. */
  triggerService?: { repo: string; mirrorDir: string; openapi?: string | string[] };
  /* Every declared service repo for a context-mode run (read-only working copies). Prompt-context only (GenerationPortAdapter → OpencodeRunInput.services). Mutually exclusive with triggerService (context mode is never service-triggered). Absent — never an empty array — when the run is not context-mode or the app has no services. */
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>;
  /* FE↔BE architecture map (context.json). Absent → the pack degrades to blast-radius + DOM only. */
  contextMap?: ArchitectureContext;
  /* Union of changed files across the PR's full commit range — further filters contracts to operations the PR actually touched. Absent -> contracts are filtered by contextMap/brief alone. */
  prChangedFiles?: string[];

  /* ObjectiveSignalPort collaborators — the keystone. assembleChangeCoverage is OPTIONAL (absent, or no per-run diff at measure() call time -> decide() receives null -> "unknown" -> NEVER blocks, the keystone's own architecturally-safe default). */
  objectiveSignal: {
    collector: Pick<CoverageCollectorPort, "collect">;
    oracle: Pick<ValueOraclePort, "measure">;
  };
  coveragePolicy: CoveragePolicy;
  assembleChangeCoverage?: (diff: string, report: Awaited<ReturnType<CoverageCollectorPort["collect"]>>) => ChangeCoverage;
  baselineCases?: string[];

  /* PublicationPort collaborators (production path only — buildShadow always overrides these with the shadow-log path, per the security-boundary note in publication-port.adapter.ts). */
  githubPr: GitHubPrCollaborator;
  githubIssue: GitHubIssueCollaborator;
  /* Git write for the "pr" route only. Optional at the type so issue/shadow compositions need not wire it; an actual "pr" route without it throws (fail-closed) rather than opening a PR against an unpushed branch. */
  vcsWrite?: VcsPublishCollaborator;
  reviewerApprovedForPublish?: boolean;
  coverageBlocksForPublish?: boolean;
  e2eChangedForPublish?: boolean;
  /* Issue/PR-body sanitizer. Injected, never imported (qa-engine stays src/-free). Required: wireBridges throws if absent — no identity default. Shell composition supplies sanitizeText from src/orchestrator/sanitizer.ts. */
  sanitize?: (text: string) => string;
  /* Post-redaction fail-loud check on the "issue" route. Optional at the type; production composition always supplies RedactionPort.containsSecret alongside sanitize. */
  containsSecret?: (text: string) => boolean;

  /* LearningPort collaborator. v1 default: StubLearningRepository (a provable no-op) when absent. */
  learningRepo?: LearningRepositoryPort;

  reflectorPort?: ReflectorPort;

  /* Write confinement. Optional, no stub: absent omits RunQaUseCaseDeps.confinement. The shell factory constructs WriteConfinementAdapter (needs src-only git/fs); this root must not import that adapter. */
  confinement?: ConfinementPort;

  /* Mirror GC. Optional, no stub: absent omits RunQaUseCaseDeps.mirrorGc. The shell factory constructs MirrorGcAdapter (needs src-only git). */
  mirrorGc?: MirrorGcPort;

  /* Process audit. Optional, no stub: absent omits RunQaUseCaseDeps.processAudit. The shell factory constructs ProcessAuditPortAdapter (src-only sinks). */
  processAudit?: ProcessAuditPort;

  curriculumPort?: CurriculumPort;

  /* Resolves a Sha to its working-copy mirrorDir. Cross-repo routing stays opaque inside this fn. */
  checkout: CheckoutFn;

  /* DeployGatePort collaborators — versionUrl absent selects NullDeployGateAdapter (static sites / code target); present selects the real poll-loop gate. */
  versionUrl?: string;
  versionPoll?: VersionPollFn;
  deployGateIntervalMs?: number;
  deployGateTimeoutMs?: number;

  /* RunHistoryPort collaborator — buildProduction prefers a durable FileRunHistoryAdapter when a path is given (falls back to in-memory otherwise); buildShadow ALWAYS forces in-memory regardless of this field (no side effect on the real history store during a shadow run). */
  historyFilePath?: string;

  runHistory?: RunHistoryPort;

  /* Per-run observer (RunRecord + event store live in the shell). Optional: absent → onStep() is a no-op. */
  observer?: ObserverPort;

  /* Multi-agent coordination is ALWAYS wired (single operating mode; see wireBridges below). Infra-only model id for sidekick-escalated sessions (env/YAML). Domain never reads this. */
  sidekickEscalatedModel?: string;
  /* Durable JSONL sink for coordination telemetry: events appended here survive process restarts so routing/cost signals can be analyzed offline. Absent -> memory-only. */
  coordinationTelemetryPath?: string;
  /* Per-delegation wall-clock cap in ms (compose/environment tunable). Absent -> 420_000. */
  sidekickTimeoutMs?: number;
}

const DEFAULT_DEPLOY_GATE_INTERVAL_MS = 2000;
const DEFAULT_DEPLOY_GATE_TIMEOUT_MS = 60000;

/* Bridge adapters from a CompositionConfig. buildShadow reuses this and swaps publication + runHistory. */
function sidekickTimeoutFromEnv(): number {
  const raw = Number(process.env.COORDINATION_SIDEKICK_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 420_000;
}

function wireBridges(cfg: CompositionConfig): Omit<RewrittenOrchestratorAdapterDeps, "publication" | "runHistory"> & {
  publication: RewrittenOrchestratorAdapterDeps["publication"];
  runHistory: RewrittenOrchestratorAdapterDeps["runHistory"];
} {
  const changeAnalysis = new ChangeAnalysisPortAdapter(cfg.vcs);

  const generation = new GenerationPortAdapter(
    cfg.generationUseCase as GenerateTestsUseCase,
    {
      repo: cfg.repo,
      appName: cfg.appName,
      mirrorDir: cfg.mirrorDir,
      e2eRelDir: cfg.e2eRelDir,
      namespace: cfg.branch,
      needsReview: false,
      target: cfg.target,
      mode: cfg.mode,
      diff: cfg.diff ?? "",
      ...(cfg.guidance ? { guidance: cfg.guidance } : {}),
      /* Live DEV URL for the generator (Playwright MCP). Absent → the agent has no URL to ground selectors against. */
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.openapi ? { openapi: cfg.openapi } : {}),
      ...(cfg.triggerService ? { service: cfg.triggerService } : {}),
      ...(cfg.services?.length ? { services: cfg.services } : {}),
    },
    { ...(cfg.readSpecSource ? { readSpecSource: cfg.readSpecSource } : {}) },
  );

  const review = new ReviewPortAdapter(cfg.reviewRuntime as ReviewPortRuntime, {
    diff: cfg.diff ?? "",
    mirrorDir: cfg.mirrorDir,
    e2eRelDir: cfg.e2eRelDir,
    appName: cfg.appName,
    mode: cfg.mode,
    target: cfg.target,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.guidance ? { guidance: cfg.guidance } : {}),
    ...(cfg.reviewTimeoutMs !== undefined ? { timeoutMs: cfg.reviewTimeoutMs } : {}),
  });

  const validation = new ValidationPortAdapter(
    {
      e2e: cfg.validationStrategies.e2e as StaticGateAdapter,
      code: cfg.validationStrategies.code as CodeValidationStrategy,
    },
    { target: cfg.target },
  );

  const execution = new ExecutionPortAdapter(
    { e2e: cfg.executionStrategies.e2e as E2eExecutionStrategy, code: cfg.executionStrategies.code as CodeExecutionStrategy },
    {
      target: cfg.target,
      namespace: cfg.branch,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.testIdAttribute !== undefined ? { testIdAttribute: cfg.testIdAttribute } : {}),
    },
  );

  /* Optional: absent → setup stays undefined and the use-case setup phase is a no-op. */
  const setup = cfg.setupCollaborators ? new SetupPortAdapter(cfg.setupCollaborators, { target: cfg.target }) : undefined;

  const cleanup = !cfg.isCode && cfg.cleanupCollaborators
    ? new CleanupPortAdapter(cfg.cleanupCollaborators, { baseUrl: cfg.baseUrl, testIdAttribute: cfg.testIdAttribute })
    : undefined;

  const preGenerationGrounding = !cfg.isCode
    ? new PreGenerationGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
          contextMap: cfg.contextMap,
          prChangedFiles: cfg.prChangedFiles,
        },
        cfg.groundingCollaborators ?? {},
      )
    : undefined;
  const reviewDomGrounding = !cfg.isCode
    ? new ReviewDomGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
        },
        cfg.reviewDomGroundingCollaborators ?? {},
      )
    : undefined;

  const preExecGrounding = !cfg.isCode
    ? new PreExecGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
        },
        cfg.preExecGroundingCollaborators ?? {},
      )
    : undefined;

  /* StructuralSignalPort: optional, never a stub. One LazyProjectCodeGraphAdapter is shared with RunQaUseCaseDeps.codeGraph — do not double-construct. Unindexed repo → empty advisory + IndexFailed (fail-open: no setLastIndexedSha). */
  const codeGraphPort = cfg.codebaseMemory
    ? new LazyProjectCodeGraphAdapter(cfg.codebaseMemory, new ProjectNameResolver(cfg.codebaseMemory))
    : undefined;
  const structuralSignal = codeGraphPort
    ? new StructuralSignalPortAdapter(
        codeGraphPort,
        /* Classify-source repo root (SERVICE on a webhook, PRIMARY otherwise) — not the e2e subfolder and not always the primary suite mirror (see StructuralSignalPortAdapter). */
        cfg.codeGraphRepoDir ?? cfg.mirrorDir,
      )
    : undefined;

  const serviceLinks = cfg.serviceTopology
    ? new ServiceLinksPortAdapter(
        cfg.serviceTopology.boundaryProfiles,
        new MirrorRegistryAdapter(cfg.serviceTopology.mirrorRoot), /* DI: real port impl, not a static call */
        {
          appName: cfg.serviceTopology.appName,
          primaryRepo: cfg.serviceTopology.primaryRepo,
          services: cfg.serviceTopology.services,
        },
      )
    : undefined;

  const crossRepoImpact = cfg.crossRepoImpact
    ? new CrossRepoImpactPortAdapter({
        mirrors: new MirrorRegistryAdapter(cfg.crossRepoImpact.mirrorRoot),
        makeVcs: (repoDir) => new GitMirrorReadAdapter(repoDir, cfg.crossRepoImpact!.runner),
        codeGraph: new LazyProjectCodeGraphAdapter(cfg.crossRepoImpact.codebaseMemory, new ProjectNameResolver(cfg.crossRepoImpact.codebaseMemory)),
        runner: cfg.crossRepoImpact.runner, /* same runner — no extra spawn surface */
      })
    : undefined;

  const objectiveSignal = new ObjectiveSignalPortAdapter(
    {
      collector: cfg.objectiveSignal.collector as CoverageCollectorPort,
      decide: new DecideCoverageService(),
      oracle: cfg.objectiveSignal.oracle as ValueOraclePort,
    },
    {
      policy: cfg.coveragePolicy,
      repoDir: cfg.mirrorDir,
      /* Same per-run namespace ExecutionPortAdapter uses (`cfg.branch`) so coverage dumps are read from the directory execution wrote. */
      namespace: cfg.branch,
      ...(cfg.assembleChangeCoverage ? { assembleChangeCoverage: cfg.assembleChangeCoverage } : {}),
      ...(cfg.baselineCases ? { baselineCases: cfg.baselineCases } : {}),
    },
  );

  const learning = new LearningPortAdapter(cfg.learningRepo ?? new StubLearningRepository(), cfg.appName);

  const workspace = new WorkspacePortAdapter(cfg.checkout, { specRelDir: cfg.isCode ? "" : cfg.e2eRelDir });

  const deployGate = cfg.versionUrl
    ? new DeployGatePortAdapter(
        cfg.versionPoll ?? (async () => ({ serving: true })),
        {
          versionUrl: cfg.versionUrl,
          intervalMs: cfg.deployGateIntervalMs ?? DEFAULT_DEPLOY_GATE_INTERVAL_MS,
          timeoutMs: cfg.deployGateTimeoutMs ?? DEFAULT_DEPLOY_GATE_TIMEOUT_MS,
        },
      )
    : new NullDeployGateAdapter();

  /* Production publication: real decide + GitHub collaborators. ShadowLogAdapter is wired here too because decide() routes to "shadow" when cfg.shadow is true. cfg.sanitize is required — throw rather than default to identity (same fail-closed guard as PublicationPortAdapter). */
  if (!cfg.sanitize) {
    throw new Error(
      "composition-root.ts: cfg.sanitize is required to wire PublicationPortAdapter — " +
        "the composition (rewritten-engine-factory.ts's buildRewrittenCompositionConfig, or the test fixture) must supply the real sanitizeText.",
    );
  }
  const publication = new PublicationPortAdapter(
    {
      decide: new PublishDecisionService(),
      pr: cfg.githubPr,
      issue: cfg.githubIssue,
      shadowLog: new ShadowLogAdapter(),
      sanitize: cfg.sanitize,
      /* Pure Issue/PR renderers — not app-specific, so every composition (including shadow) gets them unconditionally. */
      render: { issue: renderIssue, prBody: renderPrBody },
      /* Git-write collaborator, spread only when present so shadow/issue compositions omit the key. */
      ...(cfg.vcsWrite ? { vcsWrite: cfg.vcsWrite } : {}),
      ...(cfg.containsSecret ? { containsSecret: cfg.containsSecret } : {}),
    },
    {
      repo: cfg.repo,
      branch: cfg.branch,
      reviewerApproved: cfg.reviewerApprovedForPublish ?? true,
      coverageBlocks: cfg.coverageBlocksForPublish ?? false,
      shadow: cfg.shadow,
      e2eChanged: cfg.e2eChangedForPublish ?? true,
    },
  );

  /* Explicit runHistory wins over historyFilePath; file/in-memory adapters are the fallback when neither is a durable store supplied by the factory. */
  const runHistory = cfg.runHistory ?? (cfg.historyFilePath ? new FileRunHistoryAdapter(cfg.historyFilePath) : new InMemoryRunHistoryAdapter());

  return {
    changeAnalysis,
    generation,
    review,
    validation,
    execution,
    objectiveSignal,
    publication,
    learning,
    workspace,
    deployGate,
    runHistory,
    ...(setup ? { setup } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(preGenerationGrounding ? { preGenerationGrounding } : {}),
    ...(reviewDomGrounding ? { reviewDomGrounding } : {}),
    ...(preExecGrounding ? { preExecGrounding } : {}),
    ...(structuralSignal ? { structuralSignal } : {}),
    ...(cfg.indexStatus ? { indexStatus: cfg.indexStatus } : {}),
    ...(codeGraphPort ? { codeGraph: codeGraphPort } : {}),
    ...(cfg.codeGraphRepoDir ? { codeGraphRepoDir: cfg.codeGraphRepoDir } : {}),
    ...(serviceLinks ? { serviceLinks } : {}),
    ...(crossRepoImpact ? { crossRepoImpact } : {}),
    ...(cfg.observer ? { observer: cfg.observer } : {}),
    ...(cfg.reflectorPort ? { reflector: cfg.reflectorPort } : {}),
    /* Absent confinement is omitted entirely — never a fabricated no-op stub. */
    ...(cfg.confinement ? { confinement: cfg.confinement } : {}),
    /* Absent mirrorGc is omitted entirely — never a fabricated no-op stub. */
    ...(cfg.mirrorGc ? { mirrorGc: cfg.mirrorGc } : {}),
    /* Absent processAudit is omitted entirely — never a fabricated no-op stub. */
    ...(cfg.processAudit ? { processAudit: cfg.processAudit } : {}),
    /* Absent curriculumPort is omitted entirely — never a fabricated no-op stub (select() returns nothing; the fold never fires). */
    ...(cfg.curriculumPort ? { curriculum: cfg.curriculumPort } : {}),
    /* Coordination is always wired (no kill-switch). Governing points are listed independently below; the sidekick shares the reviewer's runtime with its own session lifecycle. */
    ...(() => {
      /* Process-lifetime store so adaptive thresholds see prior runs (not a fresh empty bag per composition). */
      const coordinationTelemetry = cfg.coordinationTelemetryPath
        ? getSharedCoordinationTelemetry(cfg.coordinationTelemetryPath)
        : getSharedCoordinationTelemetry();
      return {
        coordination: createCoordinationPort({
          telemetry: coordinationTelemetry,
        }),
        coordinationTelemetry,
        ...(cfg.baseUrl ? { sidekickDevBaseUrl: cfg.baseUrl } : {}),
        /* Bounded delegation wall-clock: hung/slow sidekick sessions fire fail-open instead of eating the run's full agentTimeout. Env-tunable; 420s default covers sensible Playwright MCP bootstrap + navigation. */
        sidekickTimeoutMs: cfg.sidekickTimeoutMs ?? sidekickTimeoutFromEnv(),
        ...(cfg.sidekickEscalatedModel
          ? { sidekickEscalatedModel: cfg.sidekickEscalatedModel }
          : {}),
        /* Points listed independently — enabling one does not imply the other. */
        coordinationEnabledPoints: ["pre-generate", "fix-loop-regen"] as const,
        sidekick: new SidekickExecutor({ runtime: cfg.reviewRuntime.runtime }),
      };
    })(),
    config: {
      needsReview: cfg.needsReview,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
      maxRetries: cfg.maxRetries,
      isCode: cfg.isCode,
      coveragePolicyMode: cfg.coveragePolicyMode,
      ...(cfg.agentTimeoutMs !== undefined ? { agentTimeoutMs: cfg.agentTimeoutMs } : {}),
      ...(cfg.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: cfg.wallClockBudgetMs } : {}),
      ...(cfg.iterationBudget !== undefined ? { iterationBudget: cfg.iterationBudget } : {}),
    },
  };
}

export interface BuildProductionOptions {}

export function buildProduction(
  env: Record<string, string | undefined>,
  cfg: CompositionConfig,
  _options: BuildProductionOptions = {},
): RunPipelinePort {
  selectEngine(env);
  return new RewrittenOrchestratorAdapter(wireBridges(cfg));
}

export function buildShadow(cfg: CompositionConfig): RunPipelinePort {
  /* Strip historyFilePath and any runHistory override — a shadow run must never reach the durable store. */
  const shadowCfg: CompositionConfig = { ...cfg, shadow: true, historyFilePath: undefined, runHistory: undefined };
  return new RewrittenOrchestratorAdapter(wireBridges(shadowCfg));
}
