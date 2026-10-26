/* The engine root: the one module that imports concrete adapters from every context and wires the run's ports to them. It lives in the shell, so no engine module reaches the VCS write seam. A shadow composition (cfg.shadow) publishes to the shadow log: no PR or Issue is opened on the watched repo. */

import type { AgentProvider } from "@kernel/agent-role";
import { join, relative, sep } from "node:path";
import type { RunMode, TestTarget } from "@kernel/run-mode";
import type { RunPipelinePort } from "../../qa-engine/src/contexts/run-orchestration/application/ports/run-pipeline.port";
import type { ObserverPort } from "../../qa-engine/src/contexts/run-orchestration/application/ports/observer.port";
import type { RunHistoryPort } from "../../qa-engine/src/contexts/run-orchestration/application/ports/run-history.port";
import type { CurriculumPort, LearningPort } from "@contexts/cross-run-learning/application/index";
import type { ContextMapCapturePort } from "@contexts/generation/application/index";
import type { RunDeadlinePort } from "../../qa-engine/src/contexts/run-orchestration/application/ports/run-deadline.port";
import type { SuiteStorePort } from "@kernel/ports/suite-store.port";
import type { ValidationPort } from "@contexts/test-execution/application/index";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/index";
import type { RunDeadlineView } from "@kernel/run-deadline";
import type { TelemetryClock, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import type { CoordinationSettings } from "@kernel/coordination";
import type { ToolAttemptDirectory } from "@contexts/generation/domain/tool-link";
import type { AuthDeclaration, AuthSessionPort } from "@contexts/app-catalog/application/index";
import { RunPipelineAdapter, type RunPipelineAdapterDeps } from "../../qa-engine/src/contexts/run-orchestration/infrastructure/run-pipeline.adapter";
import { SidekickExecutor } from "../../qa-engine/src/contexts/coordination/application/sidekick-executor";
import { LeadSidekicks } from "../../qa-engine/src/contexts/coordination/application/lead-sidekicks";
import { systemTimers } from "../../qa-engine/src/contexts/coordination/application/fan-out-dispatcher";
import { FsDelegationWorkspaceAdapter } from "../../qa-engine/src/contexts/coordination/infrastructure/adapters/delegation-workspace.adapter";
import { specFileForFlow } from "@contexts/generation/infrastructure/prompt-builders/prompts";
import { getSharedCoordinationTelemetry } from "../../qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter";
import { TracedCrossRepoImpactPort, TracedCurriculumPort, TracedLearningPort, TracedServiceLinksPort, TracedStructuralSignalPort, telemetryGroundingTrace } from "../../qa-engine/src/contexts/generation/infrastructure/adapters/context-trace";
import { TracedCoordinationTelemetry } from "../../qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-trace";
import { TracedObjectiveSignalPort } from "../../qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-trace";
import type { SpecSnapshotPort } from "@kernel/ports/spec-snapshot.port";
import { sanitizedPlanSnapshots, type PlanSnapshotPort } from "@kernel/ports/plan-snapshot.port";

import { GenerationPortAdapter, type GenerationPortCollaborators } from "../../qa-engine/src/contexts/generation/infrastructure/adapters/generation-port.adapter";
import { ReviewPortAdapter, type ReviewPortRuntime } from "../../qa-engine/src/contexts/generation/infrastructure/adapters/review-port.adapter";
import type { GitHubPrCollaborator, GitHubIssueCollaborator, VcsPublishCollaborator } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter";
import type { PathConfinementCollaborator } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/confinement-port.adapter";
import type { PathMirrorGcCollaborator } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/mirror-gc-port.adapter";
import type { SetupPortCollaborators } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/setup-port.adapter";
import type { CleanupPortCollaborators } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/cleanup-port.adapter";
import type { CheckoutFn } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/workspace-port.adapter";
import { DeployGatePortAdapter, NullDeployGateAdapter, type VersionPollFn } from "../../qa-engine/src/contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter";
import { InMemoryRunHistoryAdapter, FileRunHistoryAdapter } from "../../qa-engine/src/contexts/run-orchestration/infrastructure/adapters/run-history-port.adapter";
import { PreGenerationGroundingPortAdapter, type PreGenerationGroundingCollaborators } from "../../qa-engine/src/contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter";
import { ReviewDomGroundingPortAdapter, type ReviewDomGroundingCollaborators } from "../../qa-engine/src/contexts/generation/infrastructure/adapters/review-dom-grounding-port.adapter";
import { PreExecGroundingPortAdapter, type PreExecGroundingCollaborators } from "../../qa-engine/src/contexts/generation/infrastructure/adapters/pre-exec-grounding-port.adapter";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port";
import type { CoChangePort } from "@kernel/ports/co-change.port";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port";
import type { BoundaryProfileProviderPort } from "@contexts/service-topology/application/index";
import type { ExecScopePort } from "../../qa-engine/src/shared-kernel/ports/exec-scope.port";
import type { SandboxedBinaryRunner } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner";
import { PatternRedactionAdapter } from "../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import { readConfinedSpecFile } from "../../qa-engine/src/shared-infrastructure/spec-path-confinement";
import { confinedSpecFiles } from "../../qa-engine/src/shared-infrastructure/spec-files.adapter";

import { buildChangeAnalysis } from "../../qa-engine/src/contexts/change-analysis/composition/build-change-analysis";
import { buildServiceTopology } from "../../qa-engine/src/contexts/service-topology/composition/build-service-topology";
import { buildObjectiveSignal } from "../../qa-engine/src/contexts/objective-signal/composition/build-objective-signal";
import { buildWorkspaceAndPublication } from "../../qa-engine/src/contexts/workspace-and-publication/composition/build-workspace-and-publication";
import { buildAgentTools, type AgentBrowserWiring, type ClosedLoopWiring, type CodeGraphToolsWiring, type GeolocationWiring } from "../../qa-engine/src/contexts/agent-tools/composition/build-agent-tools";
import { buildTestExecution } from "../../qa-engine/src/contexts/test-execution/composition/build-test-execution";
import { buildCrossRunLearning } from "../../qa-engine/src/contexts/cross-run-learning/composition/build-cross-run-learning";
import { GenerateTestsUseCase, type GenerationResult, type GenerateOpts } from "@contexts/generation/application/generate-tests.use-case";
import type { OpencodeRunInput, ArchitectureContext, StepLimitFor } from "@contexts/generation/application/index";
import type { ContextProvenance } from "@kernel/telemetry/context-provenance";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/index";
import type { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter";
import type { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy";
import type { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy";
import type { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy";
import type { CoveragePolicy, ChangeCoverage } from "@contexts/objective-signal/domain/decide-coverage.service";
import type { CoverageCollectorPort, ValueOraclePort } from "@contexts/objective-signal/application/index";
import type { VcsReadPort } from "@contexts/change-analysis/application/index";
import type { LearningRepositoryPort, ReflectorPort, ProcessAuditPort } from "@contexts/cross-run-learning/application/index";

/* What the shell hands the root to let a run author its flows with sidekicks. */
export interface DelegationWiring {
  /* The absolute directory the sidekicks' workspaces are made under (on the mirrors volume, so the agents' runtime can open a session in it). */
  workspaceRoot: string;
  /* The runtime the sidekick role is assigned to now (it is switchable): only OpenCode can call run_spec and the authenticated browser. */
  sidekickProvider: () => AgentProvider | undefined;
  /* The runtime the lead (the primary role) plans on now: only OpenCode can hold the planning turn to read-only. */
  plannerProvider: () => AgentProvider | undefined;
  /* The run's deadline, as the agents' turns read it. */
  deadline?: RunDeadlineView;
}

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
  /* The review-loop integrity master switch (failure triage, intent lock, findings filter). Absent: off. */
  integrity?: { reviewLoop: boolean };
  coveragePolicyMode: "off" | "signal" | "enforce";
  /* The change-coverage threshold of the same policy; recorded with the run's coverage decision. */
  coverageMinRatio?: number;
  /* The test-intent lock (off | signal | enforce) plus the opacity ratio it flags. Absent: signal, 0.5. */
  intentLock?: { mode: "off" | "signal" | "enforce"; opacityFlagRatio: number };
  /* Per-mode agent session budget (ms). Factory maps agentTimeout(mode). Optional: omitted fakes keep the use-case default (0 = derived but not enforced). */
  agentTimeoutMs?: number;
  wallClockBudgetMs?: number;
  iterationBudget?: number;
  /* Whether the reviewer runs the generator's own model: the shell's per-run read of the live runtime assignment, asked once when the run is wired. Absent, or throwing, records nothing. */
  reviewerIndependence?: () => "shared-model" | "distinct-model" | undefined;
  /* The run-level wall-clock deadline the shell built (the same object its bounded agent runtime reads). Optional, no stub: absent omits RunQaUseCaseDeps.runDeadline and nothing arms. */
  runDeadline?: RunDeadlinePort;
  /* The telemetry port the shell built. Absent: nothing is traced. It never changes a verdict. */
  telemetry?: TelemetryPort;
  /* Where the text of the specs a run holds at validation is kept for after-the-fact grading (docs/observability-design.md §11.1). Absent: none is kept. Never blocks a run. */
  specSnapshots?: SpecSnapshotPort;
  /* Where a run keeps the plan its lead admitted and how its flows ended (sanitized with `sanitize`); absent, or without `sanitize`: nothing is kept. */
  planSnapshots?: PlanSnapshotPort;
  /* The one wall clock of the run's record: the phase cursor times phases on it and the phase spans start and end on its readings. Absent: the system clock. */
  clock?: TelemetryClock;
  /* Which attempt of an agent turn a run_spec or browser call hangs under (the registry the turn decorator fills). Absent: such a call hangs under the phase that is open. Needs `telemetry`. */
  toolAttempts?: ToolAttemptDirectory;
  guidance?: string;
  diff?: string;
  baseUrl?: string;
  openapi?: string | string[];
  /** Wired for e2e apps that have a DEV url. Absent in code mode. */
  authSession?: AuthSessionPort;
  /** The run_spec loop. Optional, no stub: absent (or a code target) omits RunQaUseCaseDeps.closedLoop and no run grants the tool. */
  closedLoop?: ClosedLoopWiring;
  /** The authenticated agent browser. Optional, no stub: absent (or a code target, or an app with no DEV url) omits RunQaUseCaseDeps.agentBrowser and no run grants the tools. */
  agentBrowser?: AgentBrowserWiring;
  /** The lead's code-graph tools. Optional, no stub: absent (or a code target, or an app with no code graph) omits RunQaUseCaseDeps.codeGraphTools and no run grants them. */
  codeGraphTools?: CodeGraphToolsWiring;
  /** The authoring location. Optional, no stub: absent (or a code target, or an app that declares none) omits RunQaUseCaseDeps.geolocation and no run carries one. */
  geolocation?: GeolocationWiring;
  /** The sandbox scope each run runs agent-influenced code in; absent: none is opened (tests). */
  execScope?: ExecScopePort;
  auth?: AuthDeclaration;
  testIdAttribute?: string;

  /* ChangeAnalysisPort collaborator. */
  vcs: VcsReadPort;

  /* GenerationPort collaborator — an ALREADY-CONSTRUCTED use-case (its own leaf IO ports are the generation context's own concern) plus the optional specSources file-read collaborator. */
  generationUseCase: {
    generate(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult>;
  };
  /* Override of the spec reader behind Lever-2's specSources. The shell passes none: absent, the composition root reads through the confined reader, the one that never follows a path an agent reported out of the spec directory. */
  readSpecSource?: GenerationPortCollaborators["readSpecSource"];
  /* The step limit the agent runtime enforces for a role this run, shared by every prompt of the run (the shell reads it once). It resolves undefined when the runtime enforces none for the role or cannot be read, and never rejects. Optional, no stub: absent, no prompt of the run states a step limit. */
  stepLimitFor?: StepLimitFor;

  /* ReviewPort collaborator — the SAME 3 generation-owned primitives the adapter composes standalone. */
  reviewRuntime: {
    runtime: Pick<AgentRuntimePort, "openSession">;
    rendering: Pick<PromptRenderingPort, "renderReviewer">;
    verdicts: Pick<VerdictParserPort, "parseReview">;
  };
  reviewTimeoutMs?: number;

  validationStrategies: {
    e2e: Pick<StaticGateAdapter, "validateAll"> & Partial<Pick<StaticGateAdapter, "autofix">>;
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
  /* The run's code graph: the index phase builds it, the structural signal and the cross-repo impact read it. One instance per run, because the index a run built lives in it. Absent: no repo is indexed and both signals are empty. */
  codeGraph?: CodeGraphPort;
  /* Git co-change history for the structural signal. */
  coChange?: CoChangePort;
  /* The engine's read-equivalent answers over the same run's index (the same instance as codeGraph in production). */
  codeExplore?: CodeExplorePort;
  /* The change dossier inside the structural block (S14): the engine's read-equivalent source of the change's top symbols. Needs `codeExplore`. */
  structuralDossier?: boolean;
  /* Classify-source repo root for CodeGraphPort.syncTo and StructuralSignalPortAdapter. Factory sets this to the SERVICE mirror on a webhook, PRIMARY otherwise. Absent → cfg.mirrorDir. */
  codeGraphRepoDir?: string;
  /* On a service-triggered run, the primary repo, indexed too. */
  codeGraphPrimary?: { repoDir: string; headSha(): Promise<string | null> };
  serviceTopology?: {
    appName: string;
    primaryRepo: string;
    mirrorRoot: string;
    services: readonly { repo: string }[];
    boundaryProfiles: BoundaryProfileProviderPort;
  };
  /* Cross-repo impact; its graph tier reads cfg.codeGraph, and answers nothing from the graph without it. */
  crossRepoImpact?: {
    mirrorRoot: string;
    runner: SandboxedBinaryRunner;
  };
  /* Triggering microservice for a cross-repo run — its repo, its own read-only mirror dir, and its own openapi hint. Prompt-context only (GenerationPortAdapter → OpencodeRunInput.service). No verdict/gate/coverage/publish path reads it. Absent in the same-repo case — never a stub. */
  triggerService?: { repo: string; mirrorDir: string; openapi?: string | string[] };
  /* Every declared service repo for a context-mode run (read-only working copies). Prompt-context only (GenerationPortAdapter → OpencodeRunInput.services). Mutually exclusive with triggerService (context mode is never service-triggered). Absent — never an empty array — when the run is not context-mode or the app has no services. */
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>;
  /* FE↔BE architecture map (context.json). Absent → the pack degrades to blast-radius + DOM only. */
  contextMap?: ArchitectureContext;
  /* Where the map was effectively read from and how fresh it was. Absent: the map span carries no provenance. */
  contextMapProvenance?: () => ContextProvenance | undefined;
  /* Union of changed files across the PR's full commit range — further filters contracts to operations the PR actually touched. Absent -> contracts are filtered by contextMap/brief alone. */
  prChangedFiles?: string[];

  /* Pre-generation context pack carries no live-DOM capture when false (an A/B arm; default true). Independent of review/pre-exec DOM grounding. */
  domPack?: boolean;
  /* false → the run builds no context pack at all (context mode discards it); the map/brief/harness still load. Default true. */
  contextPack?: boolean;

  /* ObjectiveSignalPort collaborators — the keystone. assembleChangeCoverage is OPTIONAL (absent, or no per-run diff at measure() call time -> decide() receives null -> "unknown" -> NEVER blocks, the keystone's own architecturally-safe default). */
  objectiveSignal: {
    collector: Pick<CoverageCollectorPort, "collect">;
    oracle: Pick<ValueOraclePort, "measure">;
  };
  coveragePolicy: CoveragePolicy;
  assembleChangeCoverage?: (diff: string, report: Awaited<ReturnType<CoverageCollectorPort["collect"]>>) => ChangeCoverage;
  baselineCases?: string[];

  /* PublicationPort collaborators (unused when cfg.shadow is true, which routes publication to the shadow log, per the security-boundary note in publication-port.adapter.ts). */
  githubPr: GitHubPrCollaborator;
  githubIssue: GitHubIssueCollaborator;
  /* Git write for the "pr" route only. Optional at the type so issue/shadow compositions need not wire it; an actual "pr" route without it throws (fail-closed) rather than opening a PR against an unpushed branch. */
  vcsWrite?: VcsPublishCollaborator;
  reviewerApprovedForPublish?: boolean;
  coverageBlocksForPublish?: boolean;
  e2eChangedForPublish?: boolean;
  /* Issue/PR-body sanitizer. Injected, never imported (qa-engine stays src/-free). Required: wireAdapters throws if absent — no identity default. Shell composition supplies sanitizeText from src/orchestrator/sanitizer.ts. */
  sanitize?: (text: string) => string;
  /* Post-redaction fail-loud check on the "issue" route. Optional at the type; production composition always supplies RedactionPort.containsSecret alongside sanitize. */
  containsSecret?: (text: string) => boolean;

  /* LearningPort collaborator. v1 default: StubLearningRepository (a provable no-op) when absent. */
  learningRepo?: LearningRepositoryPort;

  reflectorPort?: ReflectorPort;

  /* Write confinement. Optional, no stub: absent omits RunQaUseCaseDeps.confinement. The shell factory constructs WriteConfinementAdapter (needs src-only git/fs); this root must not import that adapter, and binds it to the run's handle. */
  confinement?: PathConfinementCollaborator;

  /* Mirror GC. Optional, no stub: absent omits RunQaUseCaseDeps.mirrorGc. The shell factory constructs MirrorGcAdapter (needs src-only git). */
  mirrorGc?: PathMirrorGcCollaborator;

  /* Process audit. Optional, no stub: absent omits RunQaUseCaseDeps.processAudit. The shell factory constructs ProcessAuditPortAdapter (src-only sinks). */
  processAudit?: ProcessAuditPort;

  curriculumPort?: CurriculumPort;

  /* Write side of the FE<->BE architecture map (context_maps SQLite store). Optional, no stub:
     absent omits RunQaUseCaseDeps.contextMapCapture (no capture, same as today). The shell factory
     constructs ContextMapCapturePortAdapter backed by history.ts's saveContextMap. */
  contextMapCapture?: ContextMapCapturePort;

  /* The durable copy of the app's accepted e2e suite (the qa-data volume). Optional, no stub: absent omits RunQaUseCaseDeps.suiteStore and every run starts from what the checkout holds. The shell factory constructs SuiteStoreAdapter (it owns the data directory and the git runner). */
  suiteStore?: SuiteStorePort;

  /* Resolves a Sha to its working-copy mirrorDir. Cross-repo routing stays opaque inside this fn. */
  checkout: CheckoutFn;

  /* DeployGatePort collaborators — versionUrl absent selects NullDeployGateAdapter (static sites / code target); present selects the real poll-loop gate. */
  versionUrl?: string;
  versionPoll?: VersionPollFn;
  deployGateIntervalMs?: number;
  deployGateTimeoutMs?: number;

  /* RunHistoryPort collaborator — buildProduction prefers a durable FileRunHistoryAdapter when a path is given (falls back to in-memory otherwise). */
  historyFilePath?: string;

  runHistory?: RunHistoryPort;

  /* Per-run observer (RunRecord + event store live in the shell). Optional: absent → onStep() is a no-op. */
  observer?: ObserverPort;

  /* Multi-agent coordination is ALWAYS wired (see wireAdapters below). Infra-only model id for sidekick-escalated sessions (env/YAML). Domain never reads this. */
  sidekickEscalatedModel?: string;
  /* Durable JSONL sink for coordination telemetry: events appended here survive process restarts so routing/cost signals can be analyzed offline. Absent -> memory-only. */
  coordinationTelemetryPath?: string;
  /* How the app's runs are coordinated (qa.coordination, limits defaulted). Absent: the defaults. */
  coordinationSettings?: CoordinationSettings;
  /* What lead and sidekicks need from the shell. Optional, no stub: absent (or a code target) omits RunQaUseCaseDeps.leadSidekicks and a run is authored by its lead alone. */
  delegation?: DelegationWiring;
}

/* The pattern redaction every coordinated free-form string passes through. */
const patternRedaction = new PatternRedactionAdapter();

const DEFAULT_DEPLOY_GATE_INTERVAL_MS = 2000;
const DEFAULT_DEPLOY_GATE_TIMEOUT_MS = 60000;

/* Where a map may name the staged snapshot of the triggering service: from the working copy and from the e2e dir, each only when the snapshot lies inside it. The shell stages it under the e2e dir; which of the two a context run records is not settled, so both are offered. An empty list says no directory holds the snapshot, and the run is still a cross-repo run. */
function stagedRootsOf(workingCopyDir: string, e2eDir: string, stagedDir: string): string[] {
  const inside = (root: string): boolean => root !== "" && root !== ".." && !root.startsWith("../");
  const roots = [relative(workingCopyDir, stagedDir), relative(e2eDir, stagedDir)].map((root) => root.split(sep).join("/")).filter(inside);
  return [...new Set(roots)];
}

/* The adapters wired from a CompositionConfig. */

export function wireAdapters(cfg: CompositionConfig): Omit<RunPipelineAdapterDeps, "publication" | "runHistory"> & {
  publication: RunPipelineAdapterDeps["publication"];
  runHistory: RunPipelineAdapterDeps["runHistory"];
} {
  const codeGraphPort = cfg.codeGraph;
  const changeAnalysisApi = buildChangeAnalysis({
    vcs: cfg.vcs,
    ...(codeGraphPort && cfg.coChange
      ? {
          structural: {
            codeGraph: codeGraphPort,
            coChange: cfg.coChange,
            /* Classify-source repo root (SERVICE on a webhook, PRIMARY otherwise) — not the e2e subfolder and not always the primary suite mirror (see StructuralSignalPortAdapter). */
            repoDir: cfg.codeGraphRepoDir ?? cfg.mirrorDir,
            ...(cfg.structuralDossier && cfg.codeExplore ? { explore: cfg.codeExplore } : {}),
          },
        }
      : {}),
  });
  const changeAnalysis = changeAnalysisApi.changeAnalysis;

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
    { readSpecSource: cfg.readSpecSource ?? readConfinedSpecFile, stepLimitFor: cfg.stepLimitFor, ...(cfg.runDeadline ? { deadline: cfg.runDeadline } : {}) },
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
  }, { stepLimitFor: cfg.stepLimitFor });

  const testExecution = buildTestExecution({
    target: cfg.target,
    validationStrategies: cfg.validationStrategies,
    executionStrategies: cfg.executionStrategies,
    namespace: cfg.branch,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.testIdAttribute !== undefined ? { testIdAttribute: cfg.testIdAttribute } : {}),
  });
  const execution = testExecution.execution;

  const workspaceAndPublication = buildWorkspaceAndPublication({
    run: { repo: cfg.repo, branch: cfg.branch, target: cfg.target, isCode: cfg.isCode, e2eRelDir: cfg.e2eRelDir, shadow: cfg.shadow, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}), ...(cfg.testIdAttribute !== undefined ? { testIdAttribute: cfg.testIdAttribute } : {}) },
    checkout: cfg.checkout,
    ...(cfg.setupCollaborators ? { setup: cfg.setupCollaborators } : {}),
    ...(cfg.cleanupCollaborators ? { cleanup: cfg.cleanupCollaborators } : {}),
    ...(cfg.confinement ? { confinement: cfg.confinement } : {}),
    ...(cfg.mirrorGc ? { mirrorGc: cfg.mirrorGc } : {}),
    publication: {
      githubPr: cfg.githubPr,
      githubIssue: cfg.githubIssue,
      /* Required: the build throws without it, there is no identity default. */
      sanitize: cfg.sanitize as (text: string) => string,
      ...(cfg.vcsWrite ? { vcsWrite: cfg.vcsWrite } : {}),
      ...(cfg.containsSecret ? { containsSecret: cfg.containsSecret } : {}),
      ...(cfg.reviewerApprovedForPublish !== undefined ? { reviewerApproved: cfg.reviewerApprovedForPublish } : {}),
      ...(cfg.coverageBlocksForPublish !== undefined ? { coverageBlocks: cfg.coverageBlocksForPublish } : {}),
      ...(cfg.e2eChangedForPublish !== undefined ? { e2eChanged: cfg.e2eChangedForPublish } : {}),
    },
    ...(cfg.suiteStore ? { suiteStore: cfg.suiteStore } : {}),
    ...(cfg.specSnapshots ? { specSnapshots: cfg.specSnapshots } : {}),
    ...(cfg.telemetry ? { telemetry: cfg.telemetry } : {}),
  });
  /* The specs a run holds are kept as they stand at each validation (e2e only: a code run's spec directory is the whole repo). */
  const validation: ValidationPort = workspaceAndPublication.snapshotValidation(testExecution.validation);
  const { workspace, setup, cleanup, publication } = workspaceAndPublication;

  /* The tools run through the run's own execution and cleanup ports, so a spec they run is run exactly as the suite's are. */
  const agentTools = buildAgentTools({
    run: { isCode: cfg.isCode, specRelDir: cfg.e2eRelDir, codeGraphRepoDir: cfg.codeGraphRepoDir ?? cfg.mirrorDir, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}), ...(cfg.auth ? { auth: cfg.auth } : {}) },
    execution,
    ...(cleanup ? { cleanup } : {}),
    ...(cfg.authSession ? { authSession: cfg.authSession } : {}),
    ...(cfg.codeExplore ? { codeExplore: cfg.codeExplore } : {}),
    ...(cfg.closedLoop ? { closedLoop: cfg.closedLoop } : {}),
    ...(cfg.agentBrowser ? { agentBrowser: cfg.agentBrowser } : {}),
    ...(cfg.codeGraphTools ? { codeGraphTools: cfg.codeGraphTools } : {}),
    ...(cfg.geolocation ? { geolocation: cfg.geolocation } : {}),
    ...(cfg.telemetry ? { telemetry: cfg.telemetry } : {}),
    ...(cfg.clock ? { clock: cfg.clock } : {}),
    ...(cfg.toolAttempts ? { toolAttempts: cfg.toolAttempts } : {}),
  });

  /* The change's pages over the run's call graph: the index the index phase built (the change's repo, and on a service run the app's own). */
  const topology = buildServiceTopology({
    ...(cfg.serviceTopology ? { links: { ...cfg.serviceTopology } } : {}),
    ...(cfg.crossRepoImpact
      ? {
          impact: {
            mirrorRoot: cfg.crossRepoImpact.mirrorRoot,
            runner: cfg.crossRepoImpact.runner,
            makeVcs: (repoDir) => changeAnalysisApi.mirrorReader(repoDir, cfg.crossRepoImpact!.runner),
            ...(codeGraphPort ? { codeGraph: codeGraphPort } : {}),
          },
        }
      : {}),
    ...(cfg.codeGraph && !cfg.isCode
      ? {
          pages: {
            codeGraph: cfg.codeGraph,
            repoDir: cfg.codeGraphRepoDir ?? cfg.mirrorDir,
            ...(cfg.codeGraphPrimary ? { pagesRepoDir: cfg.codeGraphPrimary.repoDir } : {}),
            budget: changeAnalysisApi.advisoryBudget,
          },
        }
      : {}),
  });
  const changePages = topology.changePages;
  const groundingCollaborators: PreGenerationGroundingCollaborators = { ...(changePages ? { changePages } : {}), ...cfg.groundingCollaborators };
  const preGenerationGrounding = !cfg.isCode
    ? new PreGenerationGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          mirrorDir: cfg.mirrorDir,
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
          contextMap: cfg.contextMap,
          ...(cfg.contextMapProvenance ? { contextMapProvenance: cfg.contextMapProvenance } : {}),
          prChangedFiles: cfg.prChangedFiles,
          domPack: cfg.domPack,
          contextPack: cfg.contextPack,
          ...(cfg.triggerService ? { stagedRoots: stagedRootsOf(cfg.mirrorDir, join(cfg.mirrorDir, cfg.e2eRelDir), cfg.triggerService.mirrorDir) } : {}),
        },
        cfg.telemetry ? { ...groundingCollaborators, trace: telemetryGroundingTrace(cfg.telemetry, cfg.contextMapProvenance) } : groundingCollaborators,
      )
    : undefined;
  const reviewDomGrounding = !cfg.isCode
    ? new ReviewDomGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          mirrorDir: cfg.mirrorDir,
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
          mirrorDir: cfg.mirrorDir,
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
        },
        cfg.preExecGroundingCollaborators ?? {},
      )
    : undefined;

  /* StructuralSignalPort: optional, never a stub. It reads the same CodeGraphPort RunQaUseCaseDeps.codeGraph indexes — do not double-construct. Unindexed repo → empty advisory. */
  const plainStructuralSignal = changeAnalysisApi.structuralSignal;
  const structuralSignal = plainStructuralSignal && cfg.telemetry ? new TracedStructuralSignalPort(plainStructuralSignal, cfg.telemetry) : plainStructuralSignal;

  const serviceLinks = topology.serviceLinks && cfg.telemetry ? new TracedServiceLinksPort(topology.serviceLinks, cfg.telemetry) : topology.serviceLinks;
  const crossRepoImpact = topology.crossRepoImpact && cfg.telemetry ? new TracedCrossRepoImpactPort(topology.crossRepoImpact, cfg.telemetry) : topology.crossRepoImpact;

  const objectiveSignalApi = buildObjectiveSignal({
    collector: cfg.objectiveSignal.collector,
    oracle: cfg.objectiveSignal.oracle,
    policy: cfg.coveragePolicy,
    repoDir: cfg.mirrorDir,
    /* Same per-run namespace ExecutionPortAdapter uses (`cfg.branch`) so coverage dumps are read from the directory execution wrote. */
    namespace: cfg.branch,
    ...(cfg.assembleChangeCoverage ? { assembleChangeCoverage: cfg.assembleChangeCoverage } : {}),
    ...(cfg.baselineCases ? { baselineCases: cfg.baselineCases } : {}),
  });
  const plainObjectiveSignal = objectiveSignalApi.objectiveSignal;
  const objectiveSignal: ObjectiveSignalPort = cfg.telemetry ? new TracedObjectiveSignalPort(plainObjectiveSignal, cfg.telemetry) : plainObjectiveSignal;

  const learningApi = buildCrossRunLearning({
    appName: cfg.appName,
    ...(cfg.learningRepo ? { learningRepo: cfg.learningRepo } : {}),
    ...(cfg.reflectorPort ? { reflector: cfg.reflectorPort } : {}),
    ...(cfg.curriculumPort ? { curriculum: cfg.curriculumPort } : {}),
    ...(cfg.processAudit ? { processAudit: cfg.processAudit } : {}),
  });
  const plainLearning = learningApi.learning;
  const learning: LearningPort = cfg.telemetry ? new TracedLearningPort(plainLearning, cfg.telemetry) : plainLearning;

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
    specFiles: confinedSpecFiles,
    deployGate,
    runHistory,
    /* The intent lock's parser: pure, no I/O, so one instance serves every run. */
    intentContract: objectiveSignalApi.intentContract,
    ...(cfg.execScope ? { execScope: cfg.execScope } : {}),
    ...agentTools,
    ...(setup ? { setup } : {}),
    ...(cfg.authSession && cfg.baseUrl
      ? {
          authSession: cfg.authSession,
          authContext: {
            baseUrl: cfg.baseUrl,
            ...(cfg.auth ? { auth: cfg.auth } : {}),
          },
        }
      : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(preGenerationGrounding ? { preGenerationGrounding } : {}),
    ...(reviewDomGrounding ? { reviewDomGrounding } : {}),
    ...(preExecGrounding ? { preExecGrounding } : {}),
    ...(structuralSignal ? { structuralSignal } : {}),
    ...(codeGraphPort ? { codeGraph: codeGraphPort } : {}),
    ...(cfg.codeGraphRepoDir ? { codeGraphRepoDir: cfg.codeGraphRepoDir } : {}),
    ...(cfg.codeGraphPrimary ? { codeGraphPrimary: cfg.codeGraphPrimary } : {}),
    ...(serviceLinks ? { serviceLinks } : {}),
    ...(crossRepoImpact ? { crossRepoImpact } : {}),
    ...(cfg.observer ? { observer: cfg.observer } : {}),
    ...(learningApi.reflector ? { reflector: learningApi.reflector } : {}),
    /* Absent confinement and mirror gc are omitted entirely: never a fabricated no-op stub. */
    ...(workspaceAndPublication.confinement ? { confinement: workspaceAndPublication.confinement } : {}),
    ...(workspaceAndPublication.mirrorGc ? { mirrorGc: workspaceAndPublication.mirrorGc } : {}),
    /* Absent processAudit is omitted entirely — never a fabricated no-op stub. */
    ...(learningApi.processAudit ? { processAudit: learningApi.processAudit } : {}),
    /* Absent runDeadline is omitted entirely — never a fabricated deadline that bounds nothing. */
    ...(cfg.runDeadline ? { runDeadline: cfg.runDeadline } : {}),
    ...(cfg.telemetry ? { telemetry: cfg.telemetry } : {}),
    ...(cfg.clock ? { phaseClock: cfg.clock } : {}),
    /* Absent curriculumPort is omitted entirely — never a fabricated no-op stub (select() returns nothing; the fold never fires). */
    ...(learningApi.curriculum ? { curriculum: cfg.telemetry ? new TracedCurriculumPort(learningApi.curriculum, cfg.telemetry) : learningApi.curriculum } : {}),
    /* Absent contextMapCapture is omitted entirely — never a fabricated no-op stub. */
    ...(cfg.contextMapCapture ? { contextMapCapture: cfg.contextMapCapture } : {}),
    /* Absent suiteStore is omitted entirely — never a fabricated no-op stub (a stub that restores nothing would hide that no suite persists). */
    ...(workspaceAndPublication.suiteStore ? { suiteStore: workspaceAndPublication.suiteStore } : {}),
    /* Absent coordination settings are omitted entirely: the coordinator uses its defaults. */
    ...(cfg.coordinationSettings ? { coordinationSettings: cfg.coordinationSettings } : {}),
    /* Lead and sidekicks: wired for an e2e run whose shell gave it a place for the sidekicks' workspaces. The sidekicks share the reviewer's runtime, each with a session of its own. A run with no coordinator wired is authored by its lead alone. */
    ...(() => {
      /* Process-lifetime store so the ledger of decisions outlives a run (not a fresh empty bag per composition). */
      const ledger = cfg.coordinationTelemetryPath
        ? getSharedCoordinationTelemetry(cfg.coordinationTelemetryPath)
        : getSharedCoordinationTelemetry();
      const coordinationTelemetry = cfg.telemetry ? new TracedCoordinationTelemetry(ledger, cfg.telemetry) : ledger;
      return {
        coordinationTelemetry,
        ...(cfg.baseUrl ? { sidekickDevBaseUrl: cfg.baseUrl } : {}),
        ...(cfg.delegation && !cfg.isCode
          ? {
              sidekickProvider: cfg.delegation.sidekickProvider,
              plannerProvider: cfg.delegation.plannerProvider,
              leadSidekicks: new LeadSidekicks({
                redaction: patternRedaction,
                sidekick: new SidekickExecutor({ runtime: cfg.reviewRuntime.runtime, redaction: patternRedaction }),
                workspaces: new FsDelegationWorkspaceAdapter({ root: cfg.delegation.workspaceRoot }),
                timers: systemTimers,
                telemetry: coordinationTelemetry,
                ...(cfg.planSnapshots && cfg.sanitize ? { planSnapshots: sanitizedPlanSnapshots(cfg.planSnapshots, cfg.sanitize) } : {}),
                specFileFor: specFileForFlow,
                /* What a sidekick wrote is untrusted: the lead's review reads it through the confined reader, and an unreadable spec is shown as none. */
                readSpec: async (root, specFile) => {
                  try {
                    return readConfinedSpecFile(root, specFile);
                  } catch {
                    return undefined;
                  }
                },
                ...(cfg.sidekickEscalatedModel ? { escalatedModel: cfg.sidekickEscalatedModel } : {}),
                ...(cfg.delegation.deadline ? { deadline: cfg.delegation.deadline } : {}),
              }),
            }
          : {}),
      };
    })(),
    config: {
      needsReview: cfg.needsReview,
      shadow: cfg.shadow,
      reviewLoopIntegrity: cfg.integrity?.reviewLoop ?? true,
      onFailure: cfg.onFailure,
      maxRetries: cfg.maxRetries,
      isCode: cfg.isCode,
      coveragePolicyMode: cfg.coveragePolicyMode,
      ...(cfg.coverageMinRatio !== undefined ? { coverageMinRatio: cfg.coverageMinRatio } : {}),
      ...(cfg.intentLock !== undefined ? { intentLock: cfg.intentLock } : {}),
      ...(cfg.agentTimeoutMs !== undefined ? { agentTimeoutMs: cfg.agentTimeoutMs } : {}),
      ...(cfg.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: cfg.wallClockBudgetMs } : {}),
      ...(cfg.iterationBudget !== undefined ? { iterationBudget: cfg.iterationBudget } : {}),
      ...recordedReviewerIndependence(cfg),
    },
  };
}

/* The reviewer-independence fact of the run being wired; a runtime that cannot answer leaves the run without it, loudly. */
function recordedReviewerIndependence(cfg: CompositionConfig): { reviewerIndependence?: "shared-model" | "distinct-model" } {
  if (!cfg.reviewerIndependence) return {};
  try {
    const value = cfg.reviewerIndependence();
    return value !== undefined ? { reviewerIndependence: value } : {};
  } catch (err) {
    console.warn(`[qa] the reviewer's model assignment could not be read, so the run records no reviewer independence: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function buildProduction(cfg: CompositionConfig): RunPipelinePort {
  return new RunPipelineAdapter(wireAdapters(cfg));
}
