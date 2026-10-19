/*
 * RunQaUseCase drives the QA run lifecycle through segregated ports.
 * A declared no-op with zero specs is skipped, never invalid; zero specs
 * without a decision, or after the step budget ran out, is infra-error.
 * Change-coverage "unknown"
 * never blocks publish. Classify runs only in diff mode; cleanup only when
 * previousNamespace is set. Coordination fails open to GenerationPort.
 * Pre-exec gateSignals use the number 0, not undefined, when unwired.
 */

import { Sha } from "@kernel/sha.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import { relative } from "node:path";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RUN_PURPOSE, type RunMode, type RunPurpose, type TestTarget, type TriggerSource } from "@kernel/run-mode.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import { COORDINATION_MODE, DEFAULT_COORDINATION_SETTINGS, effectiveCoordinationMode, type CoordinationGateSignal, type CoordinationMode, type CoordinationSettings } from "@kernel/coordination.ts";
import type { CoordinateResult, LeadSidekicks } from "./coordination/lead-sidekicks.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { isOk } from "@kernel/result.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { PROBE_REL_DIR } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../shared-infrastructure/run-secret-redaction.ts";
import { isSandboxUnavailable, type SandboxUnavailableError } from "../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { activeExecScope, refusedScope, sandboxRefused, sandboxSignal, withExecScope, type ExecScopePort } from "../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import type { AuthSession, AuthSessionContext, AuthSessionPort } from "./ports/auth-session.port.ts";
import type { IndexStatusPort } from "@kernel/ports/index-status.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";
import type {
  ChangeAnalysisPort,
  GenerationPort,
  GenerationEnrichment,
  GenerationOutput,
  GroundingOmission,
  ReviewPort,
  ReviewStats,
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
  ClosedLoopHandle,
  ClosedLoopPort,
  AgentBrowserHandle,
  AgentBrowserPort,
  GeolocationHandle,
  GeolocationPort,
  MirrorGcPort,
  CurriculumPort,
  ContextMapCapturePort,
  SuiteStorePort,
  ArchitectureContext,
  ExplorationBrief,
  HarnessFacts,
  RelevanceBias,
} from "./ports/index.ts";
import { reviewerApprovalOf, type RunDeadlinePort } from "./ports/index.ts";

/* What stands in for a generation when none ran (a regression run): it has no end, which no generation's result can have. */
type RegressionStandIn = Omit<GenerationOutput, "end"> & { end: null };

const NO_GROUNDING_SIGNALS = { preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 };

/** What a terminal exit knows beyond its verdict; each field is absent unless that exit genuinely has it — never fabricated. */
interface TerminalOptions {
  /** Present only when a reviewer ran; see reviewerApprovalOf. */
  reviewerApproved?: boolean | undefined;
  /**
   * Context-mode invalid does not persist or fold (Issue only), like a clean context pass. Unlike an
   * undocumented bypass of onFailure, this path honors the same decide() sideEffect as every other
   * invalid verdict.
   */
  skipPersist?: boolean;
  /** Static-fix retries consumed before landing on this exit. */
  retries?: number;
  /** Diagnostic note; omitted when the caller has nothing more specific than the verdict. */
  note?: string | undefined;
  /** Counters of the pre-exec gate, real once it has run; default 0. */
  groundingSignals?: typeof NO_GROUNDING_SIGNALS;
  /** Rules retrieved for the run; default []. */
  rulesRetrieved?: string[];
  /** The diff's structural shapes the fold attributes rulesRetrieved against; absent when there is no diff. */
  diffArchetypes?: string[] | undefined;
  /** Diff-derived archetype; null when there is no diff. */
  archetype?: string | null;
  /** Merged confinement from the caller's enforce immediately before the exit; absent if it never ran. */
  confinement?: { strays: number; dangerous: number; reverted: string[] } | undefined;
  /** The caller's resolveTested() result; absent when there are no specMetas. */
  tested?: { flow?: string; objective?: string }[] | undefined;
  /** The run's mirrorDir once prepare() ran; absent skips the prune. */
  mirrorDir?: string | undefined;
  /** The generation end that closed the run, when one did: it names the run's error class. */
  generationEnd?: GenerationEndKind | undefined;
  /** The run ended on a positively evidenced login failure: it names the run's error class. */
  preconditionFailed?: boolean | undefined;
  /** The run ended because its reviewer was unavailable (its session failed or returned nothing): it names the run's error class. */
  reviewerUnavailable?: boolean | undefined;
  /** What the reviewer's runtime reported when it was unavailable, persisted on the run record. */
  reviewerRationale?: string | undefined;
  /** How the run_spec loop was used up to this exit; absent when the run did not grant it. */
  closedLoop?: ClosedLoopGateSignal | undefined;
  /** How the authenticated agent browser was used up to this exit; absent when the run did not grant it. */
  agentBrowser?: AgentBrowserGateSignal | undefined;
}

/** A login the run could not complete: the kind, a note already scrubbed of credentials, and the attempt's duration. */
interface PreconditionFailure {
  kind: PreconditionKind;
  note: string;
  ms: number;
}
import { decide, isAccepted, type RunEvidence } from "../domain/run-decision.service.ts";
import { RunDecision } from "../domain/run-decision.ts";
import { RunPhaseCursor, recordPhaseSnapshot, type PhaseClock } from "../domain/run-phase-cursor.ts";
import { PhaseSpans } from "./run-phase-spans.ts";
import { DEMOTE_REASON } from "@kernel/ports/suite-store.port.ts";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { RedactionScope } from "@kernel/telemetry/telemetry.port.ts";
import { attachTraceFacts, type RunTraceFacts } from "@kernel/run-trace-facts.ts";
import { generationRunsReviewer } from "@contexts/generation/domain/generation-review.ts";
import { FixLoop, type FixLoopExecutionPort, type FixLoopGenerationPort, type FixLoopSelectorCheckPort } from "../domain/fix-loop.aggregate.ts";
import type { AdjudicatorVerdict } from "../domain/adjudicate.service.ts";
import { checkSpecSelectors, contradictionOrigins } from "../domain/helpers/selector-check.ts";
import { attributeContradictions } from "../domain/helpers/contradiction-attribution.ts";
import { mergeDeliveredSpecs } from "../domain/helpers/delivered-specs.ts";
import { precheckSpecsAgainstDom } from "../domain/deterministic-review-precheck.ts";
import { correctionClassOf } from "@contexts/generation/domain/review-output.ts";
import { renderSpecChanges, sameReviewedSpecs, type ReviewSpecText } from "@contexts/generation/domain/review-fingerprint.ts";
import { readConfinedSpecFile, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { ERROR_CLASS, resolveErrorClass } from "../domain/helpers/error-class.ts";
import { AuthPreconditionError, type PreconditionKind } from "../domain/auth-precondition.ts";
import { engineSideCauseOf, terminalForGenerationEnd } from "../domain/helpers/generation-end-terminal.ts";
import { terminalForPrecondition } from "../domain/helpers/precondition-terminal.ts";
import { learningGates, observesOperatingSignal } from "../domain/helpers/learning-gates.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";
import type { CoordinationTelemetryPort } from "./coordination/coordination-telemetry.ts";
import { renderCoverageGap } from "@contexts/objective-signal/domain/render-coverage-gap.ts";
import { checkPreExecGrounding } from "../domain/pre-exec-grounding.service.ts";
import type { ReflectorPort, ReflectionInput, ProcessAuditPort } from "@contexts/cross-run-learning/application/ports/index.ts";
import { detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";
import { MAX_STATIC_FIX_ROUNDS } from "../domain/helpers/derive-cycle-backstop.ts";
import { rethrowIfUntrusted } from "../../../shared-kernel/domain-error.ts";
import { isRunDeadlineError, rethrowIfRunDeadline, type RunDeadlineExceededError } from "../../../shared-kernel/run-deadline.ts";
import { renderRunDeadlineNote } from "../domain/run-time-budget.ts";

/* Same minRatio the coverage policy uses for the E-COVERAGE-GAP band. */
const DEFAULT_MIN_COVERAGE_RATIO = 0.7;

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

/* A probe is a throwaway spec the generator ran through run_spec: it lives under the probe directory and is never a deliverable. */
function isProbeSpec(file: string): boolean {
  return normalizeSpecPath(file).split("/").includes(PROBE_REL_DIR);
}

/* The generation without the probes it listed as deliverables; the same object when it listed none. */
function withoutProbeSpecs<T extends Pick<GenerationOutput, "specs" | "declaredSpecs">>(output: T): T {
  if (!output.specs.some(isProbeSpec) && !(output.declaredSpecs ?? []).some((d) => isProbeSpec(d.file))) return output;
  return {
    ...output,
    specs: output.specs.filter((file) => !isProbeSpec(file)),
    ...(output.declaredSpecs ? { declaredSpecs: output.declaredSpecs.filter((d) => !isProbeSpec(d.file)) } : {}),
  };
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
  /** The change-coverage threshold in force; recorded with the run's coverage decision. */
  coverageMinRatio?: number;
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
  /** Absent: the system clock. Times each phase of a run (tests inject a fake). */
  phaseClock?: PhaseClock;
  /** Absent: nothing is traced. Present: each phase of the run is a span under the run's active context (run-phase-spans.ts). Never changes a verdict. */
  telemetry?: TelemetryPort;
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
  /**
   * Absent: no sandbox scope is opened (a unit test, a run with nothing to execute). Present: the run owns a scope in
   * which every child that executes agent-influenced code is started, and its work directory is removed when the run ends.
   */
  execScope?: ExecScopePort;
  /** Absent: setup is skipped. A throw from setup() is infra-error, never a code verdict. */
  setup?: SetupPort;
  /**
   * Absent: no browser session is prepared (public app, or code mode).
   * A throw is infra-error, same as setup(), except an AuthPreconditionError: a positively
   * evidenced login failure that ends the run as E-PRECONDITION. unauthored does not throw.
   */
  authSession?: AuthSessionPort;
  /** baseUrl plus the YAML auth declaration. Required when authSession is set. */
  authContext?: AuthSessionContext;
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
  /**
   * The run-level wall-clock deadline, armed once after classification. Absent: no deadline is armed
   * and the run is bounded only by its per-turn limits.
   */
  runDeadline?: RunDeadlinePort;
  /** Off-path. Fault-isolated inside the adapter — neither call site needs a try/catch. */
  curriculum?: CurriculumPort;
  /**
   * Write side of the FE<->BE architecture map. Invoked once per clean context-mode pass
   * (isContextCleanPass), before publication, in BOTH shadow and non-shadow runs. Off-path: the
   * adapter is fault-isolated and the call site also guards it, so a capture fault never changes
   * the verdict or skips publication.
   */
  contextMapCapture?: ContextMapCapturePort;
  /**
   * The durable copy of the app's accepted e2e suite. Restored after the checkout and before the project setup (e2e runs that
   * classify as work, never code or context runs); captured right after an accepted decision, before publication, in shadow runs
   * too. Absent: a run starts from whatever the checkout holds. Off-path: a fault is logged and never changes the verdict, and a
   * run whose restore failed captures nothing (the store would be compared with a working copy that never received it).
   */
  suiteStore?: SuiteStorePort;
  /**
   * The right to execute a spec while authoring (the run_spec tool). Opened for e2e runs that generate, after the login and before
   * the first generation, and closed when the run ends, however it ends. Absent, or resolving undefined: the run is what it was
   * without the tool. A fault opening it costs the run only the loop, said aloud. When it is open and every delivered spec holds
   * the bytes whose last call passed, the regenerations that would only repeat that work are retired (static-fix rounds, the
   * pre-execution corrective regeneration, the fix loop's regeneration); the declared no-op, the silence classes and the single
   * change-coverage regeneration are untouched.
   */
  closedLoop?: ClosedLoopPort;
  /**
   * The right of the authoring agents to read DEV through the run's saved session without holding it (the `authbrowser_*`
   * tools). Opened for the same runs the run_spec loop is, after the login and before the first generation, and closed when the
   * run ends, however it ends. Absent, or resolving undefined: the run is what it was without the tools. A fault opening it costs
   * the run only the browser, said aloud. It decides nothing: no verdict, gate or retirement reads it.
   */
  agentBrowser?: AgentBrowserPort;
  /**
   * The device location of the authoring run: the app's declared default and places, the lead's own value and one value per
   * flow (the `set_geolocation` tool). Opened for the same runs the loop and the browser are, after the login and before the
   * first generation, and closed when the run ends, however it ends. Absent: the app declares no location. It is authoring
   * context, never an input to the delivered suite.
   */
  geolocation?: GeolocationPort;
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
  /** Absent: a coordinated run writes nothing to the ledger of decisions. */
  coordinationTelemetry?: CoordinationTelemetryPort;
  /**
   * App DEV base URL for the sidekicks' grounding (artifact-threaded, not env). Reuse over re-exploration.
   */
  sidekickDevBaseUrl?: string;
  /**
   * How this app's runs are coordinated. Absent: the single mode, as every run was before. A run's own
   * choice (RunQaInput.coordinationMode) overrides the mode.
   */
  coordinationSettings?: CoordinationSettings;
  /**
   * Plans a run in the lead/sidekick mode and authors its flows. Absent: the mode asks for nothing and the lead authors alone. A
   * fault in it costs the run only the coordination, said aloud.
   */
  leadSidekicks?: Pick<LeadSidekicks, "coordinate">;
  /** The runtime the sidekick role is assigned to now (it is switchable); absent: the host cannot say, and no sidekick is used. */
  sidekickProvider?: () => "opencode" | "codex" | undefined;
  /** The runtime the lead plans on now: only one that can deny the write tools per prompt may hold the planning turn to read-only. Absent: the host cannot say, and the lead authors alone. */
  plannerProvider?: () => "opencode" | "codex" | undefined;
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
  /** Why the run was started, when it is not a change to test. Only tags the persisted note; no verdict, decision or gate reads it. */
  purpose?: RunPurpose;
  /** The run's own choice about the run_spec loop (an A/B arm), overriding the app's setting. Absent: the app's setting decides. */
  closedLoop?: boolean;
  /** The run's own choice about the authenticated agent browser (an A/B arm), overriding the app's setting. Absent: the app's setting decides. */
  agentBrowser?: boolean;
  /** The run's own choice of coordination mode (an A/B arm), overriding the app's setting. Absent: the app's setting decides. */
  coordinationMode?: CoordinationMode;
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
    /** What the review phase cost and decided; absent when no reviewer phase ran. */
    reviewer?: RunOutcome["gateSignals"]["reviewer"];
    retries: number;
    preExecAmbiguityCatches: number;
    deterministicSelectorBlocks: number;
    /** Always a number (0, not undefined) once the pre-exec gate is in the type. */
    catalogGateInWindow: number;
    catalogGateAdvisory: number;
    catalogGateFailClosed: number;
    /** Milliseconds spent in each phase the run entered. Absent when it entered none. */
    phaseTimings?: Record<string, number>;
    /** The phase of the pipeline the run got furthest into. Absent when it entered none. */
    furthestPhase?: string;
    /** Present only when the run granted the run_spec tool. */
    closedLoop?: ClosedLoopGateSignal;
    /** Present only when the run granted the authenticated agent browser. */
    agentBrowser?: AgentBrowserGateSignal;
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

const SYSTEM_PHASE_CLOCK: PhaseClock = { now: () => Date.now() };

const DEFAULT_CONFIG: RunQaConfig = {
  needsReview: false,
  shadow: false,
  onFailure: "github-issue",
  maxRetries: 2,
  isCode: false,
  coveragePolicyMode: "signal",
};

/** What the run knows when its deadline ends it: the little a terminal outcome carries, filled in as the run learns it. */
const DENIED_HOSTS_SHOWN = 20;

/* A refused name is whatever the child asked for; it is shown only when it looks like a host. */
function printableHost(host: string): string {
  return /^[A-Za-z0-9._:\[\]-]{1,253}$/.test(host) ? host : "(unprintable name)";
}

interface RunTrail {
  /** The run's phase cursor, created before anything runs. */
  phases: RunPhaseCursor;
  /** How generation ended, once it did. */
  generationEnd?: string;
  /** What the engine decided about change-coverage, once it measured. */
  coverageStatus?: "pass" | "fail" | "unknown";
  /** Whether a reviewer was due for the run, as the generation decides it. */
  reviewRequired?: boolean;
  /** The limit that stopped the run, when the run deadline did. */
  limit?: { fired: string; role: string };
  /** The spans of the phases the cursor opens. */
  spans: PhaseSpans;
  mirrorDir?: string;
  rulesRetrieved?: string[];
  /** The run_spec loop, once opened: closed by runInScope however the run ends. */
  closedLoop?: ClosedLoopHandle;
  /** The authenticated agent browser, once opened: closed by runInScope however the run ends. */
  agentBrowser?: AgentBrowserHandle;
  /** The authoring location, once opened: closed by runInScope however the run ends. */
  geolocation?: GeolocationHandle;
}

/* The probes the generator left in the working copy could not be removed. */
class ProbeSweepError extends Error {
  constructor(reason: string) {
    super(`the run_spec probes could not be removed from the working copy (${reason})`);
    this.name = "ProbeSweepError";
  }
}

export class RunQaUseCase {
  private readonly telemetry: TelemetryPort;

  constructor(private readonly deps: RunQaUseCaseDeps) {
    this.telemetry = guardTelemetry(deps.telemetry ?? new NoopTelemetry());
  }

  /* What each run came to in the lead/sidekick mode, read when the run's outcome is built. Keyed by the run's input, which every exit has. */
  private readonly coordinationOf = new WeakMap<RunQaInput, CoordinationGateSignal>();

  async run(input: RunQaInput, signal?: AbortSignal): Promise<RunQaResult> {
    /* The run owns the secrets of its test account: whatever learns one registers it into this scope, and the text that reaches a model has them taken out by value (run-secret-redaction.ts). */
    let sandbox: Awaited<ReturnType<ExecScopePort["open"]>> | undefined;
    try {
      sandbox = await this.deps.execScope?.open({ runId: input.runId });
    } catch (err) {
      /* The scope could not be made because the sandbox is not safe to run in (a process of an earlier run still holds the sandbox uid): the run ends E-SANDBOX without executing anything. */
      if (!isSandboxUnavailable(err)) throw err;
      return await withRunSecretScope(createRunSecretScope(), () => withExecScope(refusedScope(input.runId, err.reason === "scope" ? "uid" : err.reason), () => this.sandboxUnavailableResult(input, err, {})));
    }
    try {
      const secrets = createRunSecretScope();
      return await withRunSecretScope(secrets, () => (sandbox ? sandbox.run(() => this.runInScope(input, secrets, signal)) : this.runInScope(input, secrets, signal)));
    } finally {
      sandbox?.close();
    }
  }

  private async runInScope(input: RunQaInput, secrets: RedactionScope, signal?: AbortSignal): Promise<RunQaResult> {
    const spans = new PhaseSpans({ telemetry: this.telemetry, secrets, app: input.app, mode: input.mode });
    const phases = new RunPhaseCursor(this.deps.phaseClock ?? SYSTEM_PHASE_CLOCK, spans);
    const trail: RunTrail = { phases, spans, reviewRequired: generationRunsReviewer({ needsReview: { ...DEFAULT_CONFIG, ...this.deps.config }.needsReview, mode: input.mode }) };
    /* A child the launcher starts for this run is a child of whichever phase is open. */
    const scope = activeExecScope();
    if (scope) scope.telemetry = { parent: () => spans.context(), phaseStart: () => spans.startedAt(), annotate: (attrs) => spans.annotate(attrs) };
    try {
      return this.withPhases(await this.runHandlingEnds(input, signal, trail), trail);
    } catch (err) {
      /* An error nothing here handles goes to the caller, which records the run: it is told where the run stood and how generation ended, so its root span carries the same facts a returned verdict would. */
      spans.fail(err);
      phases.close();
      recordPhaseSnapshot(err, phases.snapshot());
      try {
        if (typeof err === "object" && err !== null) attachTraceFacts(err, this.traceFactsOf(undefined, trail));
      } catch (traceErr) {
        console.error(`[qa] the crash could not be described for the trace (the run's failure stands): ${traceErr instanceof Error ? traceErr.message : String(traceErr)}`);
      }
      throw err;
    } finally {
      phases.close();
      await this.closeClosedLoop(trail);
      await this.closeAgentBrowser(trail);
      this.closeGeolocation(trail);
      this.sayDeniedHosts();
    }
  }

  /* How the run ended, for its trace: the decision, the end of generation, and the limit that fired (the deadline's own, else the one the generation end names). A run that threw before a result was built has no decision. */
  private traceFactsOf(result: RunQaResult | undefined, trail: RunTrail): RunTraceFacts {
    const end = trail.generationEnd;
    const fromEnd = end === GENERATION_END.EXHAUSTED ? { fired: "step-cap", role: "qa-generator" } : end === GENERATION_END.TIME_BUDGET ? { fired: "tier-budget", role: "qa-generator" } : undefined;
    const limit = trail.limit ?? fromEnd;
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    return {
      ...(result ? { decision: result.decision.sideEffect } : {}),
      ...(trail.reviewRequired !== undefined ? { reviewRequired: trail.reviewRequired } : {}),
      coverage: { ...(trail.coverageStatus ? { status: trail.coverageStatus } : {}), mode: cfg.coveragePolicyMode, ...(cfg.coverageMinRatio !== undefined ? { minRatio: cfg.coverageMinRatio } : {}) },
      ...(end !== undefined ? { generationEnd: end } : {}),
      ...(limit ? { limitFired: limit.fired, limitRole: limit.role } : {}),
    };
  }

  /* What the pre-execution gates found, as events on the phase they ran in: the ambiguity advisory and the catalog gate (its count of fabricated test ids and how many of them were fail-closed). Nothing is said when they found nothing. A fault here never reaches the run. */
  private noteGroundingGates(trail: RunTrail, result: { preExecAmbiguityCatches: number; catalogGateInWindow: number; catalogGateAdvisory: number; catalogGateFailClosed: number }): void {
    try {
      if (result.preExecAmbiguityCatches > 0) trail.spans.event("ambiguity_advisory", { "qayaba.preexec.ambiguity_catches": result.preExecAmbiguityCatches });
      if (result.catalogGateInWindow + result.catalogGateAdvisory + result.catalogGateFailClosed > 0) {
        trail.spans.event("catalog_gate", {
          "qayaba.catalog_gate.fabricated": result.catalogGateFailClosed,
          "qayaba.catalog_gate.in_window": result.catalogGateInWindow,
          "qayaba.catalog_gate.advisory": result.catalogGateAdvisory,
        });
      }
    } catch (err) {
      console.error(`[qa] the pre-execution gates could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* The armed deadline, on the phase it was armed in. */
  private noteDeadlineArmed(trail: RunTrail): void {
    try {
      const armed = this.deps.runDeadline?.describe?.();
      if (!armed) return;
      const attrs = { "qayaba.deadline.label": armed.label, "qayaba.deadline.budget_ms": armed.budgetMs } as const;
      trail.spans.annotate(attrs);
      trail.spans.event("deadline_armed", attrs);
    } catch (err) {
      console.error(`[qa] the armed deadline could not be described for the trace (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* Runs the pipeline; the errors that end a run as an outcome of their own are turned into one here. */
  private async runHandlingEnds(input: RunQaInput, signal: AbortSignal | undefined, trail: RunTrail): Promise<RunQaResult> {
    try {
      return await this.execute(input, signal, trail);
    } catch (err) {
      if (isSandboxUnavailable(err) && err.reason !== "scope") return await this.sandboxUnavailableResult(input, err, trail);
      if (err instanceof ProbeSweepError) return await this.probeSweepResult(input, err, trail);
      if (!isRunDeadlineError(err)) {
        await this.keepSandboxEvidence(input, err, trail, signal);
        throw err;
      }
      return await this.deadlineResult(input, err, trail);
    }
  }

  /*
   * Every way a run can end carries where it got. The record is on the returned result and on a copy of its outcome; what the
   * run persisted was saved earlier and is never touched, so the run history holds no phase data (the run's record does).
   * Observability never changes how a run ended: a fault here returns the result as it was.
   */
  private withPhases(result: RunQaResult, trail: RunTrail): RunQaResult {
    try {
      const phases = trail.phases;
      phases.close();
      const { furthestPhase, phaseTimings } = phases.snapshot();
      /* The one channel for the trace's facts: the result this returns. The shell adapter hands them on to whichever outcome it returns. */
      const traceFacts = this.traceFactsOf(result, trail);
      if (furthestPhase === null) return attachTraceFacts(result, traceFacts);
      return attachTraceFacts(
        {
          ...result,
          ...(result.outcome ? { outcome: { ...result.outcome, gateSignals: { ...result.outcome.gateSignals, phaseTimings, furthestPhase } } } : {}),
          gateSignals: { ...result.gateSignals, phaseTimings, furthestPhase },
        },
        traceFacts,
      );
    } catch (err) {
      console.error(`[qa] the phase record could not be attached (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }

  /**
   * An error nothing here handles (an agent runtime that failed mid-turn) leaves the caller to record the run, and the caller
   * has no scope to read: the hosts the egress filter refused would be lost, and they are what an operator needs to learn
   * which origins to declare. When a child ran, an infra-error outcome carrying only that evidence is persisted before the
   * error goes on. A run that spawned nothing has no evidence and persists nothing; a cancelled run is not an error. The
   * note names the kind of error, never its text, which the caller records after redacting it. A fault here never replaces the error.
   */
  private async keepSandboxEvidence(input: RunQaInput, err: unknown, trail: RunTrail, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || sandboxSignal() === undefined) return;
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    const kind = err instanceof Error && err.name ? err.name : "an error";
    try {
      await this.terminalResult("infra-error", cfg, input, { generating: true, static: false }, {
        note: `The run ended on ${kind} before it reached a verdict; only what the sandbox saw is kept here.`,
        ...(trail.rulesRetrieved ? { rulesRetrieved: trail.rulesRetrieved } : {}),
        ...(trail.mirrorDir ? { mirrorDir: trail.mirrorDir } : {}),
      });
    } catch (persistErr) {
      console.error(`[qa] could not persist the sandbox evidence of a run that ended on an error: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
    }
  }

  /* Says once, at the end of a run, which hosts the egress filter refused: the operator reads from it what to declare in dev.allowedOrigins. */
  private sayDeniedHosts(): void {
    const denied = sandboxSignal()?.denied ?? [];
    if (denied.length === 0) return;
    const shown = denied.slice(0, DENIED_HOSTS_SHOWN).map(printableHost);
    const more = denied.length > shown.length ? ` (and ${denied.length - shown.length} more)` : "";
    const text = `[qa] sandbox: egress denied ${denied.length} host(s): ${shown.join(", ")}${more}`;
    console.warn(text);
    this.deps.observer?.onEvent({ type: "log.line", level: "warn", text });
  }

  /* Revokes the browser's right and stops it. A fault is said and never changes how the run ended. */
  private async closeAgentBrowser(trail: RunTrail): Promise<void> {
    const browser = trail.agentBrowser;
    if (!browser) return;
    trail.agentBrowser = undefined;
    try {
      await browser.close();
    } catch (err) {
      console.error(`[qa] closing the agent browser failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* Forgets the authoring location. A fault is said and never changes how the run ended. */
  private closeGeolocation(trail: RunTrail): void {
    const geolocation = trail.geolocation;
    if (!geolocation) return;
    trail.geolocation = undefined;
    try {
      geolocation.close();
    } catch (err) {
      console.error(`[qa] closing the authoring location failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* Revokes the run_spec right and removes what its calls left. A fault is said and never changes how the run ended. */
  private async closeClosedLoop(trail: RunTrail): Promise<void> {
    const loop = trail.closedLoop;
    if (!loop) return;
    trail.closedLoop = undefined;
    try {
      await loop.close();
    } catch (err) {
      console.error(`[qa] closing the run_spec loop failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The run could not execute agent-influenced code safely (no sandbox uid under QA_EXEC_SANDBOX=required, or the egress
   * filter is down under QA_EGRESS_MODE=enforce). It ends as a persisted infra-error of its own class, E-SANDBOX: nothing
   * is learned from it and no Issue is opened, since it says nothing about the app or the tests, and the operator sees
   * why on the record.
   */
  private async sandboxUnavailableResult(input: RunQaInput, err: SandboxUnavailableError, trail: Omit<RunTrail, "phases" | "spans">): Promise<RunQaResult> {
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    const note = `The run could not execute the tests safely and ended without running them (${ERROR_CLASS.SANDBOX}): ${err.message}`;
    console.error(`[qa] ${note}`);
    this.deps.observer?.onEvent({ type: "agent.error", detail: note });
    return await this.terminalResult("infra-error", cfg, input, { generating: true, static: false }, {
      note,
      ...(trail.rulesRetrieved ? { rulesRetrieved: trail.rulesRetrieved } : {}),
      ...(trail.mirrorDir ? { mirrorDir: trail.mirrorDir } : {}),
    });
  }

  /* The throwaway specs of the closed loop could not be swept: nothing in the working copy can be trusted to be a deliverable, so the run ends as a persisted infra-error before it validates, executes or publishes anything. */
  private async probeSweepResult(input: RunQaInput, err: ProbeSweepError, trail: RunTrail): Promise<RunQaResult> {
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    console.error(`[qa] ${err.message}`);
    this.deps.observer?.onEvent({ type: "agent.error", detail: err.message });
    return await this.terminalResult("infra-error", cfg, input, { generating: true, static: false }, {
      note: err.message,
      ...(trail.rulesRetrieved ? { rulesRetrieved: trail.rulesRetrieved } : {}),
      ...(trail.mirrorDir ? { mirrorDir: trail.mirrorDir } : {}),
    });
  }

  /**
   * The run's time ran out: an agent turn was refused or stopped by the run-level deadline. The run ends as a
   * persisted infra-error under E-TIME-BUDGET with a note that says so, never as an empty result and never as an
   * uncaught integration error. Nothing is published and nothing is learned (how long the agents took says nothing
   * about the app or the tests).
   */
  private async deadlineResult(input: RunQaInput, err: RunDeadlineExceededError, trail: RunTrail): Promise<RunQaResult> {
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    trail.limit = { fired: "run-deadline", role: err.role };
    trail.generationEnd ??= GENERATION_END.TIME_BUDGET;
    const note = renderRunDeadlineNote({ budgetMs: err.budgetMs, label: err.label, role: err.role, stop: err.stop });
    console.error(`[qa] ${note}`);
    this.deps.observer?.onEvent({ type: "agent.error", detail: note });
    this.deps.observer?.onEvent({
      type: "log.line",
      level: "error",
      text: `[qa] the run ended on its time budget (${ERROR_CLASS.TIME_BUDGET}): an engine-side limit on how long the agents may take, not a fault of the app under test`,
    });
    return await this.terminalResult("infra-error", cfg, input, { generating: true, static: false }, {
      generationEnd: GENERATION_END.TIME_BUDGET,
      note,
      ...(trail.rulesRetrieved ? { rulesRetrieved: trail.rulesRetrieved } : {}),
      ...(trail.mirrorDir ? { mirrorDir: trail.mirrorDir } : {}),
    });
  }

  private async execute(input: RunQaInput, signal: AbortSignal | undefined, trail: RunTrail): Promise<RunQaResult> {
    const cfg: RunQaConfig = { ...DEFAULT_CONFIG, ...this.deps.config };
    const startedAt = Date.now();
    const cycleBudget = CycleBudget.derive({
      maxRetries: cfg.maxRetries,
      ...(cfg.iterationBudget !== undefined ? { iterationBudget: cfg.iterationBudget } : {}),
    });
    /*
     * A zero agentTimeoutMs with no YAML override derives to WallClockBudget.unbounded() —
     * exhausted() then never fires, so a caller here needs no separate "is this armed" guard.
     */
    const wallClockBudget = WallClockBudget.derive({
      cycleBudget,
      agentTimeoutMs: cfg.agentTimeoutMs ?? 0,
      ...(cfg.wallClockBudgetMs !== undefined ? { wallClockBudgetMs: cfg.wallClockBudgetMs } : {}),
    });

    /* Already-aborted signal short-circuits before the entry gate. */
    if (signal?.aborted) {
      return this.abortedResult();
    }

    trail.phases.enter("gate");
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

    trail.phases.enter("workspace");
    const workspace = await this.deps.workspace.prepare(input.sha);
    trail.mirrorDir = workspace.mirrorDir;

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
        /* A git dir that is not the orchestrator's is a security refusal, never a fault to isolate. */
        rethrowIfUntrusted(err);
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
      trail.phases.enter("classify");
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

    /* Armed here because a diff run's budget follows the size of its change, known only now; a classify-skip has already returned without spending any agent time. */
    this.deps.runDeadline?.arm({ mode: input.mode, ...(classificationDiff !== undefined ? { diff: classificationDiff } : {}), ...(classificationIntent ? { changedFiles: classificationIntent.changedFiles } : {}) });
    this.noteDeadlineArmed(trail);

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
     * The accepted suite comes back before the project setup: the checkout has just wiped every untracked file of the mirror, and the
     * setup would otherwise seed the stock login and nothing else. A fault here is a cold run, said aloud, not a failed one; the
     * run then captures nothing, since the working copy was never compared with the store.
     */
    trail.phases.enter("setup");
    let suiteRestored = false;
    let storeRestoredLogin = false;
    if (this.deps.suiteStore && !cfg.isCode && input.mode !== "context") {
      try {
        const restored = await this.deps.suiteStore.restore({ mirrorDir: workspace.mirrorDir, specDir: workspace.specDir });
        suiteRestored = true;
        storeRestoredLogin = restored.authRestored;
        this.announceSuite(
          `[qa] suite store: restored ${restored.restored} file(s), overlaid ${restored.overlaid} unpublished change(s) over git, left ${restored.trackedWins} to git${restored.authRestored ? "; the app's login was restored" : ""}`,
          "info",
        );
      } catch (err) {
        rethrowIfUntrusted(err);
        this.announceSuite(`[qa] suite store restore failed (off-path; the run starts cold and keeps nothing): ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
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
    let authSeedUnauthored = false;
    if (!cfg.isCode) {
      let auth = await this.prepareAuth(workspace.specDir, "pre-generate", signal);
      if ("failed" in auth && storeRestoredLogin) {
        /* The login the store brought back no longer signs in (the app changed since): the stock seed takes its place and the login is tried once more, which falls into discovery or the unauthored path. */
        const healed = await this.replaceRestoredLogin(workspace, signal);
        if (healed === "setup-failed") return this.infraErrorResult("setup failed while the app's stored login was replaced by the stock one", workspace.mirrorDir);
        if (healed === "replaced") auth = await this.prepareAuth(workspace.specDir, "pre-generate", signal);
      }
      if ("failed" in auth) return this.infraErrorResult(auth.failed, workspace.mirrorDir);
      if ("precondition" in auth) {
        /* A cancelled run is not a failed login: whatever the killed attempt saw, the abort wins. */
        if (signal?.aborted) return this.abortedResult(workspace.mirrorDir);
        const terminal = terminalForPrecondition(input.mode);
        this.announcePrecondition(auth.precondition, terminal.action === "end");
        if (terminal.action === "end") {
          return await this.terminalResult(terminal.verdict, cfg, input, { generating, static: false }, {
            preconditionFailed: true,
            note: this.preconditionNote(auth.precondition),
            mirrorDir: workspace.mirrorDir,
          });
        }
      } else {
        authSeedUnauthored = auth.unauthored;
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
     * The authoring location: the app's declared default and places, the lead's value and one value per flow. Opened before the
     * browser and the loop so both can consume it; a fault opening it costs the run only the location. Its facts are read again
     * on every generation turn, since the lead may move it while it authors.
     */
    let geolocation: GeolocationHandle | undefined;
    if (this.deps.geolocation && generating && !cfg.isCode && input.mode !== "context" && input.purpose !== RUN_PURPOSE.LOGIN_BOOTSTRAP && !authSeedUnauthored) {
      try {
        geolocation = await this.deps.geolocation.open({
          runId: input.runId,
          app: input.app,
          mode: input.mode,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        rethrowIfRunDeadline(err);
        console.error(`[qa] the authoring location could not be opened (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
      }
      trail.geolocation = geolocation;
    }
    const geolocationEnrichment = (): { geolocation?: GeolocationFacts } => (geolocation ? { geolocation: geolocation.facts() } : {});

    /*
     * The run_spec loop: only for a run that writes e2e tests with a login the suite can use. A fault opening it costs the run only
     * the loop. Its facts reach every generation of the run (the first pass and each regeneration) through baseEnrichment.
     */
    let closedLoop: ClosedLoopHandle | undefined;
    if (
      this.deps.closedLoop &&
      generating &&
      !cfg.isCode &&
      input.mode !== "context" &&
      input.purpose !== RUN_PURPOSE.LOGIN_BOOTSTRAP &&
      !authSeedUnauthored
    ) {
      try {
        closedLoop = await this.deps.closedLoop.open({
          runId: input.runId,
          app: input.app,
          mode: input.mode,
          mirrorDir: workspace.mirrorDir,
          specDir: workspace.specDir,
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          ...(input.closedLoop !== undefined ? { enabled: input.closedLoop } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        rethrowIfRunDeadline(err);
        console.error(`[qa] the run_spec loop could not be opened (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
      }
      trail.closedLoop = closedLoop;
    }

    /* The authenticated agent browser: the same runs, the same moment. A fault opening it costs the run only the browser. */
    let agentBrowser: AgentBrowserHandle | undefined;
    if (
      this.deps.agentBrowser &&
      generating &&
      !cfg.isCode &&
      input.mode !== "context" &&
      input.purpose !== RUN_PURPOSE.LOGIN_BOOTSTRAP &&
      !authSeedUnauthored
    ) {
      try {
        const geo = geolocation;
        agentBrowser = await this.deps.agentBrowser.open({
          runId: input.runId,
          app: input.app,
          mode: input.mode,
          specDir: workspace.specDir,
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          ...(input.agentBrowser !== undefined ? { enabled: input.agentBrowser } : {}),
          ...(signal ? { signal } : {}),
          ...(geo ? { geolocation: { default: geo.default, forSession: (sessionId: string) => geo.forSession(sessionId) } } : {}),
        });
      } catch (err) {
        rethrowIfRunDeadline(err);
        console.error(`[qa] the agent browser could not be opened (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
      }
      trail.agentBrowser = agentBrowser;
    }
    const agentBrowserSignal = (): AgentBrowserGateSignal | undefined => agentBrowser?.signals();

    /*
     * sha is always present so manifest changeRef.sha is never empty.
     * retrieve() is enrichment, not a requirement: failure is caught and generation
     * continues. Prompt renderers use trigger/action; retrievedRuleIds (r.id) are
     * for by-id fold attribution — never conflate the two.
     */
    /*
     * Bias retrieval toward the CURRENT diff's structural shape, using the SAME detector generation's own curriculum/archetype calls already use (detectArchetype
     * below, curriculum.select() above) so the offered archetypes never silently diverge from what
     * biases retrieval. classificationDiff is undefined outside diff mode (only "diff" classifies —
     * see above), so there is no signal to bias with there; never fabricated.
     *
     * Retrieval is NOT biased by the app's most recent persisted errorClass: RunHistoryPort is
     * save-only (no read-back — see rewritten-orchestrator.adapter.ts's own header note), and no
     * port wired into this use-case at this point in the flow can answer "what was this app's
     * last outcome's errorClass", so that signal is left unwired rather than invented.
     */
    /*
     * The diff's structural shapes, read once: they bias retrieval (specific shapes only) and ride
     * on every folded outcome so the fold credits only the retrieved rules attributable to them.
     * Undefined outside diff mode — no diff, no shape, never fabricated.
     */
    const diffArchetypes = classificationDiff
      ? detectStructuralPatterns(classificationDiff, classificationIntent?.changedFiles ?? []).map((p) => p.kind)
      : undefined;
    const retrievalArchetypes = (diffArchetypes ?? []).filter((k) => k !== "generic");
    const retrievalRelevance: RelevanceBias | undefined =
      retrievalArchetypes.length > 0 ? { archetypes: retrievalArchetypes } : undefined;
    trail.phases.enter("ground");
    let retrievedRules: RetrievedRule[] = [];
    try {
      retrievedRules = await this.deps.learning.retrieve(input.sha, retrievalRelevance);
    } catch (err) {
      console.error("[qa] learning retrieval failed (non-fatal, generation continues ungrounded):", err);
    }
    const retrievedRuleIds = retrievedRules.map((r) => r.id);
    trail.rulesRetrieved = retrievedRuleIds;

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
    let groundingContextPackItemIds: readonly string[] | undefined;
    let groundingContextPackOmissions: readonly GroundingOmission[] | undefined;
    let groundingExistingSpecFiles: string[] | undefined;
    let groundingContextMap: ArchitectureContext | undefined;
    let groundingContextBrief: ExplorationBrief | undefined;
    let groundingHarnessFacts: HarnessFacts | undefined;
    if (this.deps.preGenerationGrounding) {
      this.deps.observer?.onStep("generate", PRE_GENERATION_GROUNDING_STEP_DETAIL);
      try {
        const grounding = await this.deps.preGenerationGrounding.ground(
          workspace.specDir,
          signal,
          classificationDiff,
          { sha: input.sha.toString(), ...(classificationIntent ? { intent: classificationIntent } : {}), runId: input.runId },
        );
        groundingContextPack = grounding.contextPack;
        groundingContextPackItemIds = grounding.contextPackItemIds;
        groundingContextPackOmissions = grounding.contextPackOmissions;
        groundingExistingSpecFiles = grounding.existingSpecFiles;
        groundingContextMap = grounding.contextMap;
        groundingContextBrief = grounding.contextBrief;
        groundingHarnessFacts = grounding.harnessFacts;
      } catch (err) {
        rethrowIfRunDeadline(err);
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
    let blastRadiusSignalHasSymbols = false;
    /* A brief that carries a blast radius already has it distilled, so the graph is not queried and a second, advisory copy never reaches the prompt. A brief that distilled none supplies nothing, so the signal stands in. */
    if (this.deps.structuralSignal && !groundingContextBrief?.blastRadius.length) {
      try {
        const rendered = await this.deps.structuralSignal.render(workspace.specDir, runBlastRadius);
        blastRadiusSignal = rendered.text;
        blastRadiusSignalHasSymbols = rendered.hasSymbols;
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
     * resolved link targets triggerRepo. A throw is fail-open, except an untrusted git dir (the mirror was replaced by
     * untrusted code), which fails the run.
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
        rethrowIfUntrusted(err);
        console.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, generation continues without it):", err);
      }
    }

    const baseEnrichment = {
      sha: input.sha.toString(),
      runId: input.runId,
      ...(classificationIntent ? { intent: classificationIntent } : {}),
      ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
      ...(groundingContextPack ? { contextPack: groundingContextPack } : {}),
      ...(groundingContextPackItemIds ? { contextPackItemIds: groundingContextPackItemIds } : {}),
      ...(groundingContextPackOmissions ? { contextPackOmissions: groundingContextPackOmissions } : {}),
      ...(groundingExistingSpecFiles?.length ? { existingSpecFiles: groundingExistingSpecFiles } : {}),
      ...(groundingContextMap ? { contextMap: groundingContextMap } : {}),
      ...(groundingContextBrief ? { contextBrief: groundingContextBrief } : {}),
      ...(groundingHarnessFacts ? { harnessFacts: groundingHarnessFacts } : {}),
      /* The flag travels with its signal and only when true: a co-change-only signal carries none, never a fabricated false. */
      ...(blastRadiusSignal
        ? { staticSignal: blastRadiusSignal, ...(blastRadiusSignalHasSymbols ? { staticSignalHasSymbols: true } : {}) }
        : {}),
      ...(selectedExemplars.length ? { skillExemplars: selectedExemplars } : {}),
      ...(closedLoop ? { closedLoop: closedLoop.limits } : {}),
      ...(agentBrowser ? { agentBrowser: agentBrowser.limits } : {}),
      ...(resolvedServiceLinks.length ? { serviceLinks: resolvedServiceLinks } : {}),
      ...(resolvedContractDrift.length ? { contractDrift: resolvedContractDrift } : {}),
      ...(crossRepoImpact?.impactedLinks.length ? { crossRepoImpact: { impactedLinks: crossRepoImpact.impactedLinks } } : {}),
      /* contradiction is spread only when true — never fabricated as false. */
      ...(classificationReason ? { classificationReason } : {}),
      ...(classificationContradiction ? { contradiction: true } : {}),
    };

    /*
     * The specs this run has delivered so far, merged after every generation pass: a lead pass
     * refreshes what its verdict declared for each spec, a sidekick pass adds paths only (the
     * objective of a delegation is never a spec's). Every regeneration is handed them.
     */
    let delivered: readonly DeliveredSpec[] = [];
    /* What follows every generation by the lead: the probes it left behind are swept before anything looks at the working copy, and none is a deliverable. Without a loop, the generation is returned as it is. */
    const afterGeneration = async <T extends Pick<GenerationOutput, "specs" | "declaredSpecs">>(output: T): Promise<T> => {
      if (!closedLoop) return output;
      try {
        await closedLoop.sweepProbes();
      } catch (err) {
        /* Fail closed: a working copy that may still hold throwaway specs is not validated, executed or published. The run ends as an infra-error (runInScope). */
        throw new ProbeSweepError(err instanceof Error ? err.message : String(err));
      }
      return withoutProbeSpecs(output);
    };
    /* Whether every delivered spec was seen passing in the bytes it has now: the generator has already done the work a regeneration would repeat. A fault in asking is "not closed", which keeps every regeneration. */
    const loopClosedNow = async (): Promise<boolean> => {
      if (!closedLoop || delivered.length === 0) return false;
      try {
        return await closedLoop.isClosed(delivered.map((d) => d.file));
      } catch (err) {
        console.error(`[qa] could not tell whether the run_spec loop is closed (regenerations stay on): ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };
    const closedLoopSignal = async (): Promise<ClosedLoopGateSignal | undefined> => (closedLoop ? { ...closedLoop.signals(), closed: await loopClosedNow() } : undefined);
    /* One regeneration by the lead over what the run has delivered so far; what it delivers joins that. */
    const regenerate = async (regenerationSignal: AbortSignal | undefined, enrichment: GenerationEnrichment): Promise<GenerationOutput> => {
      const regenerated = await afterGeneration(await this.deps.generation.generate([], workspace.specDir, regenerationSignal, classificationDiff, {
        ...baseEnrichment,
        ...geolocationEnrichment(),
        ...enrichment,
        ...(delivered.length > 0 ? { deliveredSpecs: delivered } : {}),
      }));
      delivered = mergeDeliveredSpecs(delivered, regenerated, "lead");
      return regenerated;
    };

    /*
     * The lead/sidekick mode: the lead is asked for a plan and its flows are authored by sidekicks, each in a workspace of its own.
     * What comes back is a generation like any other: the specs of the flows that delivered, a declared no-op, or an end that
     * names why nothing was finished. Undefined: the lead authors the change in one turn, as every run did before this mode.
     * The mode is the app's setting unless the run chose; a code run, a context run and a login still to be written never use it.
     */
    const coordinationSettings = this.deps.coordinationSettings ?? DEFAULT_COORDINATION_SETTINGS;
    const coordinationMode = effectiveCoordinationMode(coordinationSettings, input.coordinationMode);
    const coordinateFirstPass = async (): Promise<GenerationOutput | undefined> => {
      if (coordinationMode !== COORDINATION_MODE.LEAD_SIDEKICKS || !this.deps.leadSidekicks) return undefined;
      if (!generating || cfg.isCode || input.mode === "context" || authSeedUnauthored) return undefined;
      let result: CoordinateResult;
      try {
        result = await this.deps.leadSidekicks.coordinate({
          runId: input.runId,
          app: input.app,
          objective: input.guidance ?? classificationIntent?.message ?? `QA run ${input.runId}`,
          mirrorDir: workspace.mirrorDir,
          specDir: workspace.specDir,
          specRelDir: relative(workspace.mirrorDir, workspace.specDir).replace(/\\/g, "/") || "e2e",
          settings: { ...coordinationSettings, mode: coordinationMode },
          facts: { hasLogin: Boolean(this.deps.authContext?.auth), provider: this.deps.sidekickProvider?.(), plannerProvider: this.deps.plannerProvider?.() },
          ...(closedLoop ? { closedLoop } : {}),
          ...(agentBrowser ? { agentBrowser } : {}),
          ...(geolocation ? { geolocation } : {}),
          ...(this.deps.sidekickDevBaseUrl ? { devBaseUrl: this.deps.sidekickDevBaseUrl } : {}),
          ...(this.deps.generation.plan
            ? { plan: (planning) => this.deps.generation.plan!(workspace.specDir, signal, classificationDiff, { ...baseEnrichment, ...geolocationEnrichment(), planning }) }
            : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        rethrowIfRunDeadline(err);
        console.error(`[qa] coordination failed (the lead authors the change alone): ${err instanceof Error ? err.message : String(err)}`);
        this.coordinationOf.set(input, { mode: COORDINATION_MODE.LEAD_SIDEKICKS, downgrade: "coordination failed", flows: 0, delivered: 0, incomplete: 0, takeover: false });
        return undefined;
      }
      this.coordinationOf.set(input, result.signal);
      if (result.action === "single") return undefined;
      if (result.action === "noop") {
        return { specs: [], end: GENERATION_END.DECLARED_NOOP, reviewed: false, approved: true, parsed: true, note: result.reason };
      }
      const { aggregated } = result;
      if (aggregated.end !== GENERATION_END.DELIVERED) {
        return { specs: [], end: aggregated.end, reviewed: false, approved: true, parsed: true, ...(aggregated.note ? { note: aggregated.note } : {}) };
      }
      const unfinished = aggregated.incompleteFlows.map((f) => `${f.id} (${f.kind})`).join(", ");
      if (unfinished) this.deps.observer?.onEvent({ type: "log.line", level: "warn", text: `coordination: ${aggregated.incompleteFlows.length} flow(s) did not finish: ${unfinished}` });
      return await afterGeneration({ specs: aggregated.specs, end: GENERATION_END.DELIVERED, reviewed: false, approved: true, parsed: true, ...(unfinished ? { note: `flows that did not finish: ${unfinished}` } : {}) });
    };

    /*
     * Separate from generation enrichment: ReviewEnrichment has no sha/contextPack.
     * domSnapshot is captured per review round on the current specs.
     */
    const baseReviewEnrichment = {
      runId: input.runId,
      ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
    };

    /*
     * Skipped when generating is false (regression) — the synthetic empty approved
     * result is not a GenerationPort call.
     * In the lead/sidekick mode the flows' specs stand in for the lead's first pass (coordinateFirstPass).
     */
    trail.phases.enter("generate");
    this.deps.observer?.onStep("generate", generating ? undefined : "regression: running the existing suite, not generating");
    /* A regression run generates nothing: a stand-in with no generation end, never one a generation could return. */
    let generated: GenerationOutput | RegressionStandIn;
    if (!generating) {
      generated = { specs: [], approved: true, reviewed: false, end: null };
    } else {
      /*
       * A stock seed that did not sign in reaches the generator as its own fact in every mode (the
       * prompt builders render the rewrite instruction); the Context Pack stays grounding-only.
       * The coordination does not engage for such a run (coordinateFirstPass): sidekick output from the login wall is
       * not the session the suite will run with.
       */
      const coordinatedFirstPass = await coordinateFirstPass();
      if (signal?.aborted) return this.abortedResult(workspace.mirrorDir);
      generated = coordinatedFirstPass
        ?? (await afterGeneration(await this.deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
          ...baseEnrichment,
          ...geolocationEnrichment(),
          ...(authSeedUnauthored ? { authSeedUnauthored: true } : {}),
        })));
      delivered = mergeDeliveredSpecs(delivered, generated, coordinatedFirstPass ? "sidekick" : "lead");
    }
    /*
     * Confinement after a real generate() only. The regression synthetic stand-in
     * wrote nothing. Sidekick writes are still agent writes.
     */
    if (generating) await enforceConfinement();

    /*
     * How the generation ended decides how the run does. With specs the run continues (a generation
     * that also ran out of steps is only logged). Without specs only a declared no-op is a decision
     * and skips; running out of steps, or a verdict that decides nothing, ends the run as a persisted
     * infra-error the operator can read; an output that never parsed keeps its unpersisted one. A
     * regression run generates nothing, so it has no end and never lands here.
     */
    if (generated.end !== null) {
      trail.generationEnd = generated.end;
      const terminal = terminalForGenerationEnd(generated.end);
      if (terminal.action === "continue") {
        if (generated.turn?.exhausted === true) {
          this.deps.observer?.onEvent({
            type: "log.line",
            level: "warn",
            text: `[qa] the generator ran out of steps (${generated.turn.stepsUsed ?? "?"}/${generated.turn.maxSteps ?? "?"}) but delivered ${generated.specs.length} spec(s); continuing`,
          });
        }
      } else if (terminal.action === "skip") {
        const skipped = this.skippedResult({ note: generated.note, reviewerApproved: reviewerApprovalOf(generated) });
        const skipLoopSignal = await closedLoopSignal();
        const skippedOutcome = this.toRunOutcome(input, skipped.decision, [], 0, null, skipped.errorClass, {
          reviewerApproved: skipped.gateSignals.reviewerApproved,
          ...(skipped.note !== undefined ? { note: skipped.note } : {}),
          ...(confinementAcc !== undefined ? { confinement: confinementAcc } : {}),
          ...(skipLoopSignal ? { closedLoop: skipLoopSignal } : {}),
          ...(agentBrowserSignal() ? { agentBrowser: agentBrowserSignal() } : {}),
        });
        await this.deps.runHistory.save(skippedOutcome);
        await this.pruneMirrorIfWired(workspace.mirrorDir);
        return { ...skipped, outcome: skippedOutcome };
      } else if (terminal.persisted) {
        const endNote = generated.note ?? `generation ended without specs (${generated.end})`;
        console.error(`[qa] generation ended without specs (${generated.end}): ${endNote}`);
        this.deps.observer?.onEvent({ type: "agent.error", detail: endNote });
        this.deps.observer?.onEvent({
          type: "log.line",
          level: "error",
          text: `[qa] generation ended without specs (${terminal.errorClass}): an engine-side ${engineSideCauseOf(generated.end)}, not a fault of the app under test`,
        });
        return await this.terminalResult(terminal.verdict, cfg, input, { generating: true, static: false }, {
          generationEnd: generated.end,
          note: endNote,
          reviewerApproved: reviewerApprovalOf(generated),
          rulesRetrieved: retrievedRuleIds,
          diffArchetypes,
          archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
          confinement: confinementAcc,
          mirrorDir: workspace.mirrorDir,
          closedLoop: await closedLoopSignal(),
          agentBrowser: agentBrowserSignal(),
        });
      } else {
        const emptyNote =
          generated.note ||
          "generation produced no parseable output — the agent runtime returned an empty/errored session " +
            "(provider unavailable, quota exhausted, timeout, or model refusal). Not a code defect and not a " +
            "no-op decision; surfaced as infra-error so it is diagnosable rather than a silent skip.";
        console.error(`[qa] generation runtime failure (empty, unparseable output): ${emptyNote}`);
        return this.infraErrorResult(emptyNote, workspace.mirrorDir);
      }
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

    /* Absent port: counters stay 0, not undefined. Accumulated so they survive every terminal. The ambiguity check is advisory (it is a regex over the spec text, and real execution decides), so nothing is blocked on it and `deterministicSelectorBlocks` stays 0. */
    let preExecAmbiguityCatches = 0;
    const deterministicSelectorBlocks = 0;
    let catalogGateInWindow = 0;
    let catalogGateAdvisory = 0;
    let catalogGateFailClosed = 0;
    /*
     * Reads the on-disk specs. Only the catalog gate's corrections come back to be repaired (a
     * correction names no spec, but the gate says which spec raised each: the files are those of the
     * capture's specs); an ambiguity is counted and warned about, and asks for nothing.
     */
    const runPreExecGrounding = async (): Promise<{ corrections: string[]; attributedSpecFiles: string[] }> => {
      if (!this.deps.preExecGrounding) return { corrections: [], attributedSpecFiles: [] };
      const { specFiles, specSources, routes } = await this.deps.preExecGrounding.capture(workspace.specDir, signal);
      const result = checkPreExecGrounding({ specSources, routes });
      preExecAmbiguityCatches += result.preExecAmbiguityCatches;
      if (result.ambiguities.length > 0) {
        const text = `[qa] pre-exec ambiguity check (advisory, execution decides): ${result.ambiguities.join(" | ")}`;
        console.warn(text);
        this.deps.observer?.onEvent({ type: "log.line", level: "warn", text });
      }
      catalogGateInWindow += result.catalogGateInWindow;
      catalogGateAdvisory += result.catalogGateAdvisory;
      catalogGateFailClosed += result.catalogGateFailClosed;
      this.noteGroundingGates(trail, result);
      return { corrections: result.corrections, attributedSpecFiles: attributeContradictions(result.corrections, result.origins, specFiles) };
    };
    /*
     * One-shot corrective regen before the static gate. Adopt the regen only if it
     * produced specs — an empty result must not discard the original specs.
     */
    const { corrections: groundingCorrections, attributedSpecFiles: groundingAttribution } = await runPreExecGrounding();
    /* A spec the generator saw pass against DEV is not rewritten for what a static look at its selectors suspects. */
    const correctiveRegenRetired = groundingCorrections.length > 0 && (await loopClosedNow());
    if (correctiveRegenRetired) {
      this.deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] pre-exec grounding raised corrections, but every delivered spec was seen passing through run_spec: no corrective regeneration" });
    }
    if (groundingCorrections.length > 0 && !correctiveRegenRetired) {
      this.deps.observer?.onStep("retry", "pre-exec grounding: corrective regen");
      const corrected = await regenerate(signal, {
        selectorContradictions: groundingCorrections,
        ...(groundingAttribution.length > 0 ? { attributedSpecFiles: groundingAttribution } : {}),
      });
      await enforceConfinement();
      if (corrected.specs.length > 0) {
        generated = corrected;
      }
    }
    /* Pre-exec corrections, and the files they were attributed to, still feed later FixLoop regens until the first of them consumes them. */
    let pendingSelectorContradictions: string[] = groundingCorrections;
    let pendingAttributedSpecFiles: string[] = groundingAttribution;

    /*
     * Bounded repair of static-gate errors (MAX_STATIC_FIX_ROUNDS). Skipped when
     * nothing was generated. Repair rounds get validation errors as fixCases; the
     * initial generate() does not. lastGenerated is the latest attempt's approved flag.
     * changedFiles scopes the code-target compile gate; ignored by e2e. Empty outside diff mode.
     */
    const validateChangedFiles = classificationIntent?.changedFiles ?? [];
    trail.phases.enter("validate");
    this.deps.observer?.onStep("validate");
    const deliveredNow = (): { deliveredSpecs: string[] } => ({ deliveredSpecs: delivered.map((d) => d.file) });
    let validation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles, deliveredNow());
    let lastGenerated = generated;
    /*
     * Prefer FixLoop's final specMetas when present; otherwise lastGenerated's.
     * Undefined when neither source has anything — the "tested" section is omitted.
     */
    const resolveTested = (): { flow?: string; objective?: string }[] | undefined =>
      fixLoopFinalSpecMetas?.length ? fixLoopFinalSpecMetas : lastGenerated.specMetas;
    let staticFixRounds = 0;
    /* The same reasoning: a failing gate on a spec the generator saw pass ends the run invalid instead of rewriting the spec. */
    const staticFixRetired = !validation.ok && !validation.infra && generating && lastGenerated.specs.length > 0 && (await loopClosedNow());
    if (staticFixRetired) {
      this.deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] the static gate failed, but every delivered spec was seen passing through run_spec: no static-fix rounds" });
    }
    while (!staticFixRetired && !validation.ok && !validation.infra && generating && lastGenerated.specs.length > 0 && staticFixRounds < MAX_STATIC_FIX_ROUNDS) {
      /* Cancel mid-repair must stop before burning another generate()+validate() round-trip. */
      if (signal?.aborted) {
        return this.abortedResult(workspace.mirrorDir);
      }
      staticFixRounds++;
      retries++;
      this.deps.observer?.onStep("retry", `static-fix round ${staticFixRounds}/${MAX_STATIC_FIX_ROUNDS}`);
      /* Repair regen reuses the same classificationDiff/intent as the initial generate(). */
      const staticGateErrorDetail = validation.errors.join("\n\n").slice(0, STATIC_GATE_ERROR_DETAIL_MAX_CHARS);
      lastGenerated = await regenerate(signal, {
        fixCases: [{ name: "static-gate", status: "fail", detail: staticGateErrorDetail }],
      });
      await enforceConfinement();
      validation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles, deliveredNow());
    }

    /*
     * reviewerApproved default is the reviewer's verdict on the latest generation, and exists only
     * when a reviewer looked at it: a generation nobody reviewed carries a placeholder flag, never
     * an approval. A regression stand-in was never reviewed either.
     */
    const reviewerApprovedFromGeneration = reviewerApprovalOf(lastGenerated);

    if (!validation.ok) {
      /*
       * Context-mode validate() failure does not persist (Issue only).
       * validation.infra is infra-error: the gate itself could not run, not a code defect.
       */
      console.error("[qa] static gate failed:", validation.errors);
      const staticGateNote = validation.errors.slice(0, 2).join("\n\n") || undefined;
      /* Last confinement pass immediately before this exit's publish(). */
      await enforceConfinement();
      return await this.terminalResult(
        validation.infra ? "infra-error" : "invalid",
        cfg,
        input,
        { generating, static: false },
        {
          reviewerApproved: reviewerApprovedFromGeneration,
          skipPersist: !validation.infra && input.mode === "context",
          /* Static-fix retries consumed before the gate gave up. */
          retries,
          note: staticGateNote,
          groundingSignals: { preExecAmbiguityCatches, deterministicSelectorBlocks, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed },
          rulesRetrieved: retrievedRuleIds,
          diffArchetypes,
          archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
          confinement: confinementAcc,
          tested: resolveTested(),
          mirrorDir: workspace.mirrorDir,
          closedLoop: await closedLoopSignal(),
          agentBrowser: agentBrowserSignal(),
        },
      );
    }

    /*
     * Mid-run DEV pre-flight, distinct from the entry gate. Absent DeployGatePort
     * (static sites / code) defaults to always-healthy. The InfraError message is
     * captured as a side effect so FixLoop can keep a boolean-returning contract.
     */
    trail.phases.enter("health");
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
    /*
     * Infra-error between validation and execute (DEV down, login broken): specs were already
     * generated, so the run is persisted like any other terminal but never folds or reflects.
     * This exit persists static:false even though validation already passed — the stored field
     * for this source is false.
     */
    const preExecuteInfraError = async (reason: string, ending: { preconditionFailed?: boolean } = {}): Promise<RunQaResult> => {
      /* Confinement still runs for revert even though this exit does not publish. */
      await enforceConfinement();
      return await this.terminalResult(
        "infra-error",
        cfg,
        input,
        { generating, static: false },
        {
          reviewerApproved: reviewerApprovedFromGeneration,
          retries,
          note: reason,
          ...(ending.preconditionFailed ? { preconditionFailed: true } : {}),
          groundingSignals: { preExecAmbiguityCatches, deterministicSelectorBlocks, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed },
          /* Retrieved ids reach the persisted outcome for diagnosability only. */
          rulesRetrieved: retrievedRuleIds,
          diffArchetypes,
          archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
          confinement: confinementAcc,
          tested: resolveTested(),
          mirrorDir: workspace.mirrorDir,
          closedLoop: await closedLoopSignal(),
          agentBrowser: agentBrowserSignal(),
        },
      );
    };
    if (!(await devHealthy())) {
      const healthReason = lastHealthCheckError ?? "DEV health pre-flight failed before execute";
      console.error("[qa] health pre-flight failed before execute:", healthReason);
      return await preExecuteInfraError(healthReason);
    }
    if (signal?.aborted) {
      return this.abortedResult(workspace.mirrorDir);
    }

    /*
     * Context mode never executes — context.json is not a Playwright spec.
     * A successful context generation is an immediate pass with zero cases.
     */
    /* The hash of the login script that signed in just before execute; only such a file is kept by the suite store. */
    let authVerifiedSha256: string | undefined;
    if (input.mode !== "context" && !cfg.isCode) {
      const auth = await this.prepareAuth(workspace.specDir, "pre-execute", signal);
      if ("failed" in auth) return await preExecuteInfraError(auth.failed);
      if ("precondition" in auth) {
        if (signal?.aborted) return this.abortedResult(workspace.mirrorDir);
        /* Reached only by a run that generates tests (the guard above), which a failed login always ends. */
        this.announcePrecondition(auth.precondition, true);
        return await preExecuteInfraError(this.preconditionNote(auth.precondition), { preconditionFailed: true });
      }
      authVerifiedSha256 = auth.setupSha256;
    }
    if (input.mode !== "context") {
      trail.phases.enter("execute");
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
      trail.phases.enter("fix_loop");
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
       * The specs of the latest lead generation: the FixLoop's next Lever-2 check reads their sources,
       * by index, so the contradictions it finds were raised by these specs.
       */
      let latestSpecs: string[] = lastGenerated.specs;
      const fixLoopGeneration: FixLoopGenerationPort = {
        /* Forward FixLoopGenerateInput so a retry prompt sees what failed. */
        generate: async (fixLoopInput) => {
          /* A spent wall-clock budget starts no further agent turn: the round returns nothing and the loop ends on what it has. */
          if (wallClockBudget.exhausted(Date.now() - startedAt)) {
            return { specs: [], approved: lastGenerated.approved, note: "wall-clock budget exhausted: no further regeneration" };
          }
          /*
           * Merge leftover pre-exec selector contradictions with FixLoop's post-failure
           * check — independent evidence; neither suppresses the other.
           */
          const lever2Contradictions = fixLoopInput.selectorContradictions ?? [];
          const mergedSelectorContradictions = [...pendingSelectorContradictions, ...lever2Contradictions];
          /* The pre-exec ones come with the files they were attributed to when found; Lever-2's are attributed now, to the specs the check says raised them. */
          const attributedSpecFiles = [
            ...new Set([...pendingAttributedSpecFiles, ...attributeContradictions(lever2Contradictions, fixLoopInput.selectorContradictionOrigins, latestSpecs)]),
          ];

          const r = await regenerate(signal, {
            fixCases: fixLoopInput.fixCases,
            ...(mergedSelectorContradictions.length ? { selectorContradictions: mergedSelectorContradictions } : {}),
            ...(attributedSpecFiles.length ? { attributedSpecFiles } : {}),
            ...(fixLoopInput.domSnapshot ? { domSnapshot: fixLoopInput.domSnapshot } : {}),
          });
          await enforceConfinement();
          /* Pre-exec corrections are one-shot — clear after the first FixLoop regen. */
          pendingSelectorContradictions = [];
          pendingAttributedSpecFiles = [];
          /* The next Lever-2 check reads this generation's sources: its contradictions will be raised by these specs. */
          latestSpecs = r.specs;
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
        check: (specSources, trees) => ({ ...checkSpecSelectors(specSources, trees), origins: contradictionOrigins(specSources, trees) }),
      };
      const fixLoop = new FixLoop({
        execution: fixLoopExecution,
        generation: fixLoopGeneration,
        selectorCheck: fixLoopSelectorCheck,
        /* Re-validate before retry execute so a compile error does not hit live DEV. */
        revalidate: (specDir) => this.deps.validation.validate(specDir, undefined, deliveredNow()),
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
      /* The generator saw every delivered spec pass against DEV in these very bytes: a failure now is not one a rewrite is likely to cure, so it is adjudicated for its Issue and not regenerated. */
      const fixLoopRetired = await loopClosedNow();
      if (fixLoopRetired) {
        this.deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] the suite failed, but every delivered spec was seen passing through run_spec: the failure is adjudicated and not regenerated" });
      }
      const fixLoopResult = await fixLoop.run({
        initialRun: { verdict: run.verdict, cases: run.cases },
        isCode: cfg.isCode,
        generating,
        mode: input.mode,
        objectiveSource: [],
        maxRetries: cfg.maxRetries,
        ...(fixLoopRetired ? { regenerate: false } : {}),
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
     * The suite store admits a spec only with the bytes that executed green, so those bytes are fingerprinted here, before the
     * reviewer's correction rounds or the coverage regeneration can rewrite a file that is never executed again. Off-path: a fault
     * leaves no evidence, and a capture without evidence admits no spec.
     */
    let executedGreen: ReadonlyMap<string, string> = new Map();
    if (this.deps.suiteStore && suiteRestored && run.verdict === "pass") {
      try {
        executedGreen = await this.deps.suiteStore.fingerprint(
          { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir },
          run.cases.filter((c) => c.status === "pass" && c.file !== undefined).map((c) => c.file!),
        );
      } catch (fingerprintErr) {
        rethrowIfUntrusted(fingerprintErr);
        this.announceSuite(`[qa] suite store fingerprint failed (off-path; no spec is admitted): ${fingerprintErr instanceof Error ? fingerprintErr.message : String(fingerprintErr)}`, "warn");
      }
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
    /*
     * Absent (undefined) means the oracle never measured this run at all; `null` means it measured
     * but has no count to report. Neither is ever fabricated as 0 — see toRunOutcome's extra bag.
     */
    let mutantCount: number | undefined;
    let killedCount: number | undefined;
    /* A context run executes nothing (its pass is synthetic), so it has no coverage or value to measure. */
    if (run.verdict === "pass" && input.mode !== "context") {
      /*
       * onStep("coverage") only when this pass actually measures (diff mode, not
       * cross-repo). Do not emit the step for a pass that never measured.
       */
      if (input.mode === "diff" && !input.triggerRepo) {
        trail.phases.enter("coverage");
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
      trail.coverageStatus = signal.status;
      valueScore = signal.valueScore ?? null;
      mutantCount = signal.mutantCount ?? undefined;
      killedCount = signal.killedCount ?? undefined;
      /*
       * Ask the port: only enforce+fail blocks. Unknown/pass never block. Do not
       * re-implement the mode check here.
       */
      blocksPublish = this.deps.objectiveSignal.blocks(signal.status);

      /*
       * Enforce-mode one-shot coverage regen: this block runs at most once per run (it is not
       * inside any loop) and is independent of the FixLoop budget. A regen throw propagates.
       * Validate-fail, non-pass rerun, or 0-spec regen keeps the first measurement's
       * blocksPublish (never fabricated).
       */
      if (blocksPublish && input.mode === "diff" && !input.triggerRepo) {
        try {
          const gap = renderCoverageGap(signal.uncovered ?? []);
          /*
           * The method's AbortSignal parameter is shadowed here by the measure() result
           * `signal`. This generate() omits it rather than rename every `signal.*` read.
           */
          const regen = await regenerate(undefined, { coverageGap: gap });
          await enforceConfinement();
          if (regen.specs.length > 0) {
            const regenValidation = await this.deps.validation.validate(workspace.specDir, validateChangedFiles, deliveredNow());
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
                trail.coverageStatus = signal2.status;
                blocksPublish = this.deps.objectiveSignal.blocks(signal2.status);
              }
            }
          }
        } catch (regenErr) {
          /* The run's time is spent: the first measurement stands, as for any regeneration that cannot finish. Any other fault still propagates. */
          if (!isRunDeadlineError(regenErr)) throw regenErr;
          console.warn(`[qa] the run deadline was spent during the coverage regeneration; the first measurement stands (${regenErr.message})`);
        }
      }
    }

    let reviewerApproved = true;
    /* A context run's product is the architecture map, not tests: there is nothing for a test reviewer to judge, and a verdict it cannot give would turn a clean pass into an Issue. */
    const reviewsTests = cfg.needsReview && input.mode !== "context";
    /*
     * Default reviewerApproved to generation's own flag (needsReview only) so
     * fail/flaky/invalid paths still have a value. A genuine review call overwrites it.
     */
    let reviewerApprovedForOutcome: boolean | undefined = reviewerApprovedFromGeneration;
    /* Stays [] when the review loop never runs — never fabricated. */
    let finalReviewerCorrections: string[] = [];
    /* What the review phase cost and decided; absent when the phase never ran. */
    let reviewerSignal: RunOutcome["gateSignals"]["reviewer"];
    /*
     * Also gated on generating: a regression run never invokes the reviewer
     * (nothing new to judge; decide()'s !generating branch already wins).
     */
    if (run.verdict === "pass" && reviewsTests && generating) {
      /*
       * MAX_REVIEW_ROUNDS = 2. parsed:false is a parse miss — fail closed immediately
       * without burning a regen round. Gate is approved && blockingCount === 0;
       * absent blockingCount defaults to corrections.length (fail-closed).
       * Last-round rejection is terminal. A regen that produces zero specs must not
       * inherit the generator's self-approval.
       */
      trail.phases.enter("review");
      const MAX_REVIEW_ROUNDS = 2;
      /*
       * The reviewer judges the specs this run delivered, not the whole executed suite: an existing
       * suite file that does not cover this change is context, never a wrong-objective correction.
       * The suite's paths travel separately, marked context-only in the review prompt.
       */
      const deliveredFiles = new Set(delivered.map((d) => d.file));
      const existingSpecFiles = [...new Set([...(groundingExistingSpecFiles ?? []), ...run.cases.map((c) => c.file ?? c.name)])]
        .filter((file) => !deliveredFiles.has(file));
      let reviewCases = run.cases.filter((c) => deliveredFiles.has(c.file ?? c.name));
      let previousRoundCorrections: string[] | undefined;
      /* The blocking count that produced the previous rejection, so a skipped round reports it unchanged. */
      let previousRoundBlocking: number | undefined;
      /*
       * The specs the previous round judged, and a roll-up of what the review phase cost. The specs
       * are read through the confined reader: a name that leaves the directory, or a file that is
       * gone, contributes nothing and the round fails open to the model.
       */
      const specRoot: SpecRoot = { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir };
      const readReviewedSpecs = (cases: readonly QaCase[]): ReviewSpecText[] => {
        const seen = new Set<string>();
        const specs: ReviewSpecText[] = [];
        for (const c of cases) {
          const file = c.file ?? c.name;
          if (seen.has(file)) continue;
          seen.add(file);
          try {
            specs.push({ file, text: readConfinedSpecFile(specRoot, file) });
          } catch {
            /* Unreadable spec: no pre-check and no duplicate round for it; the model reviewer still sees it from the prompt. */
          }
        }
        return specs;
      };
      let previousRoundSpecs: ReviewSpecText[] | undefined;
      let previousRoundCaseCount = 0;
      const reviewStats = {
        rounds: 0,
        modelRounds: 0,
        preCheckRejects: 0,
        skippedRounds: 0,
        durationMs: 0,
        promptBytes: 0,
        outputTokens: 0,
        costUsd: 0,
        steps: 0,
        blocking: 0,
        metricsKnown: { output: false, cost: false, steps: false },
      };
      const addReviewStats = (stats: ReviewStats | undefined): void => {
        if (!stats) return;
        reviewStats.durationMs += stats.durationMs;
        reviewStats.promptBytes += stats.promptBytes;
        if (stats.outputTokens !== undefined) {
          reviewStats.outputTokens += stats.outputTokens;
          reviewStats.metricsKnown.output = true;
        }
        if (stats.costUsd !== undefined) {
          reviewStats.costUsd += stats.costUsd;
          reviewStats.metricsKnown.cost = true;
        }
        if (stats.steps !== undefined) {
          reviewStats.steps += stats.steps;
          reviewStats.metricsKnown.steps = true;
        }
      };
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

        const reviewedSpecs = readReviewedSpecs(reviewCases);
        const specsReadable = reviewedSpecs.length === reviewCases.length && reviewedSpecs.length > 0;
        /*
         * The previous rejection stands when the new specs are materially the same: a round that
         * only changed comments cannot resolve a blocking correction, and paying a model to say so
         * twice is waste. Only judged when every case is readable, so a spec the reader cannot see
         * never silently skips its review.
         */
        const unchangedSinceRejection =
          previousRoundSpecs !== undefined &&
          specsReadable &&
          previousRoundCaseCount === reviewCases.length &&
          sameReviewedSpecs(previousRoundSpecs, reviewedSpecs);

        let reviewResult: Awaited<ReturnType<ReviewPort["review"]>>;
        let decidedBy: "model" | "precheck" | "unchanged" = "model";
        let roundRationale: string | undefined;

        if (unchangedSinceRejection) {
          reviewerApproved = false;
          reviewStats.skippedRounds++;
          reviewResult = {
            approved: false,
            corrections: previousRoundCorrections ?? [],
            blockingCount: previousRoundBlocking ?? previousRoundCorrections?.length ?? 0,
            rationale: "the specs are materially unchanged since the previous rejection, so that verdict stands",
            parsed: true,
          };
          decidedBy = "unchanged";
          console.error("[qa] reviewer: the specs did not change since the last rejection (comments/whitespace only) — the previous verdict stands without a second model round.");
          this.deps.observer?.onEvent({
            type: "log.line",
            level: "info",
            text: "[qa] reviewer: no material spec change since the last rejection; the previous corrections stand (no second model review)",
          });
        } else {
          /*
           * Deterministic first look at the reviewer's own evidence: an asserted literal or selector
           * the captured page contradicts is a blocking false positive, provable without a model. It
           * fails open on any uncertainty; the model reviewer still runs whenever it finds nothing.
           */
          const precheckFindings = precheckSpecsAgainstDom({ specs: reviewedSpecs, domSnapshot: reviewDomSnapshot });
          if (precheckFindings.length > 0) {
            reviewerApproved = false;
            reviewStats.preCheckRejects++;
            roundRationale = `the captured DEV page contradicts ${precheckFindings.length} assertion(s) in the specs (deterministic check)`;
            reviewResult = {
              approved: false,
              corrections: precheckFindings.map((finding) => finding.correction),
              blockingCount: precheckFindings.length,
              rationale: roundRationale,
              parsed: true,
            };
            decidedBy = "precheck";
            console.error(`[qa] reviewer pre-check: ${precheckFindings.length} clear contradiction(s) between the specs and the captured DOM — rejecting without a model round.`);
            for (const finding of precheckFindings) console.error(`[qa] reviewer pre-check: ${finding.correction}`);
          } else {
            const specChanges = previousRoundSpecs
              ? renderSpecChanges(previousRoundSpecs, reviewedSpecs)
              : "";
            reviewResult = await this.deps.review.review(workspace.specDir, reviewCases, classificationDiff, {
              ...baseReviewEnrichment,
              ...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {}),
              ...(specChanges ? { specChanges } : {}),
              ...(reviewDomSnapshot ? { domSnapshot: reviewDomSnapshot } : {}),
              ...(existingSpecFiles.length ? { existingSpecFiles } : {}),
            });
            reviewStats.modelRounds++;
            addReviewStats(reviewResult.stats);
          }
        }
        reviewStats.rounds++;
        const reviewedBlocking = reviewResult.blockingCount ?? reviewResult.corrections.length;
        if (!reviewResult.unavailable) reviewStats.blocking = reviewedBlocking;
        const reviewOutcome = reviewResult.unavailable ? "unavailable" : reviewResult.parsed === false ? "parse-miss" : reviewResult.approved && reviewedBlocking === 0 ? "approved" : "rejected";
        const correctionClass = reviewedBlocking > 0 ? correctionClassOf(reviewResult.corrections) : "none";
        const reviewTargets = [...new Set(reviewCases.map((c) => c.file ?? c.name))];
        /*
         * The decision evidence, not just its aggregate: an agent reading the trace must see which
         * specs the reviewer judged, which of them already existed, the bounded corrections and the
         * class the failure falls into. The metric carries the closed class; the span carries the
         * high-cardinality paths and text.
         */
        try {
          const reviewSpan = this.telemetry.startSpan("qayaba.review.decision", {
            attrs: {
              "qayaba.app": input.app,
              "qayaba.review.round": round + 1,
              "qayaba.review.outcome": reviewOutcome,
              "qayaba.review.decided_by": decidedBy,
              "qayaba.review.correction_class": correctionClass,
              "qayaba.review.blocking": reviewedBlocking,
              "qayaba.review.targets": reviewTargets,
              ...(existingSpecFiles.length ? { "qayaba.review.existing_specs": [...existingSpecFiles] } : {}),
              ...(reviewResult.corrections.length ? { "qayaba.review.corrections": [...reviewResult.corrections] } : {}),
              ...(reviewResult.rationale ? { "qayaba.review.rationale": reviewResult.rationale } : {}),
            },
          });
          reviewSpan.end();
        } catch (err) {
          console.error(`[telemetry] the reviewer decision span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
        }
        this.telemetry.counter("qayaba.review")(1, {
          "qayaba.app": input.app,
          "qayaba.review.outcome": reviewOutcome,
          "qayaba.review.decided_by": decidedBy,
          "qayaba.review.correction_class": correctionClass,
        });
        if (reviewResult.stats) {
          this.telemetry.histogram("qayaba.review.duration")(reviewResult.stats.durationMs / 1000, {
            "qayaba.app": input.app,
            "qayaba.review.outcome": reviewOutcome,
          });
        }
        /*
         * A reviewer that could not be reached judged nothing: that is not a rejection, so it must not open an
         * Issue on a green run. The run ends as a persisted infra-error under its own class, with no PR and no Issue.
         */
        if (reviewResult.unavailable) {
          return await this.reviewerUnavailableResult(cfg, input, reviewResult.rationale, reviewCases.length, {
            static: validation.ok,
            retries,
            rulesRetrieved: retrievedRuleIds,
            diffArchetypes,
            archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
            confinement: confinementAcc,
            tested: resolveTested(),
            mirrorDir: workspace.mirrorDir,
            closedLoop: await closedLoopSignal(),
          agentBrowser: agentBrowserSignal(),
          });
        }
        /* parsed:false fails closed immediately, without burning a regeneration round. */
        if (reviewResult.parsed === false) {
          reviewerApproved = false;
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
        const blockingCount = reviewedBlocking;
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
        /* Nothing changed since the last rejection: another round would regenerate the same bytes. */
        if (unchangedSinceRejection) break;
        retries++;
        this.deps.observer?.onStep("retry", `reviewer-correction round ${round + 1}/${MAX_REVIEW_ROUNDS}`);
        previousRoundCorrections = reviewResult.corrections;
        previousRoundBlocking = reviewedBlocking;
        previousRoundSpecs = reviewedSpecs;
        previousRoundCaseCount = reviewCases.length;
        const regen = await regenerate(signal, { reviewCorrections: reviewResult.corrections });
        await enforceConfinement();
        if (regen.specs.length === 0) {
          /* A regen that produced no reviewable specs must not inherit the generator's self-approval. */
          reviewerApproved = false;
          break;
        }
        /* This loop does not re-execute regenerated specs against DEV. Execution evidence is round-0-only: the suite store holds the bytes that ran (`executedGreen`), so a regenerated file is never admitted as proven. */
        reviewCases = regen.specs.map((file) => ({ name: file, file, status: run.cases[0]?.status ?? "pass" }));
      }
      /* A genuine review verdict overwrites generation's self-approval default. */
      reviewerApprovedForOutcome = reviewerApproved;
      reviewerSignal = {
        rounds: reviewStats.rounds,
        modelRounds: reviewStats.modelRounds,
        approved: reviewerApproved,
        corrections: finalReviewerCorrections.length,
        blocking: reviewStats.blocking,
        durationMs: reviewStats.durationMs,
        promptBytes: reviewStats.promptBytes,
        outputTokens: reviewStats.metricsKnown.output ? reviewStats.outputTokens : null,
        costUsd: reviewStats.metricsKnown.cost ? reviewStats.costUsd : null,
        steps: reviewStats.metricsKnown.steps ? reviewStats.steps : null,
        preCheckRejects: reviewStats.preCheckRejects,
        skippedRounds: reviewStats.skippedRounds,
        correctionClass: reviewerApproved ? "none" : correctionClassOf(finalReviewerCorrections),
      };
    }

    /* Publish never emits its own step; "decide" covers the decide+publish pair. */
    trail.phases.enter("decide");
    this.deps.observer?.onStep("decide");
    const evidence: RunEvidence = {
      verdict: run.verdict,
      generating,
      needsReview: reviewsTests,
      reviewerApproved,
      blocksPublish,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
    };
    const decision = decide(evidence);

    /* A coordinated run says how it ended: the verdict with the quality sampled at the same instant, and how many flows were handed back. */
    const coordinationSignal = this.coordinationOf.get(input);
    if (coordinationSignal && this.deps.coordinationTelemetry) {
      /* Read from the same honest source as the persisted outcome: absent when no reviewer looked at this run. */
      const reviewOutcome =
        !reviewsTests ? "skipped" as const
        : reviewerApprovedForOutcome === true ? "approved" as const
        : reviewerApprovedForOutcome === false ? "rejected" as const
        : "n/a" as const;
      this.deps.coordinationTelemetry.record({
        runId: input.runId,
        app: input.app,
        kind: "outcome",
        action: coordinationSignal.plan === "fanout" ? "delegate" : "direct",
        reason: `pipeline verdict=${decision.verdict}; flows ${coordinationSignal.delivered}/${coordinationSignal.flows} delivered${coordinationSignal.takeover ? "; the lead took over" : ""}`,
        finalOutcome: decision.verdict,
        reviewOutcome,
        /* Quality sampled at the same instant the outcome is stamped. */
        ...(coverageRatio !== undefined ? { coverageRatio } : {}),
        ...(valueScore !== null ? { valueScore } : {}),
        escalations: coordinationSignal.incomplete + (coordinationSignal.takeover ? 1 : 0),
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
    /*
     * A clean context-mode pass neither persists nor folds: it produced an architecture map, not
     * tests. A context run whose map failed validation already ended through terminalResult,
     * without persisting or folding either.
     */
    trail.phases.enter("publish");
    const isContextCleanPass = input.mode === "context" && decision.verdict === "pass";
    /*
     * A clean context-mode pass wrote the FE<->BE architecture map to the mirror's
     * e2e/.qa/context.json. That file does not survive the mirror's next `git checkout -f` +
     * `git clean -fd`, so the orchestrator captures it into the durable store BEFORE publication —
     * in both shadow and non-shadow runs, whatever publish() then does with a context.json PR
     * (including throwing). Off-path: a capture fault is logged and never changes the verdict.
     */
    if (isContextCleanPass && this.deps.contextMapCapture) {
      try {
        await this.deps.contextMapCapture.capture(workspace.specDir, input.app, input.sha.toString());
      } catch (captureErr) {
        console.warn(
          `[qa] context-map capture failed (off-path; verdict unchanged): ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`,
        );
      }
    }
    /*
     * An accepted run proved its suite, whatever happens to the pull request (and in shadow mode none is opened): the suite is kept
     * before publication, so the next run's checkout cannot wipe it. Off-path: a fault is logged and never changes the verdict.
     */
    if (this.deps.suiteStore && suiteRestored && isAccepted(evidence)) {
      try {
        const kept = await this.deps.suiteStore.capture({
          mirrorDir: workspace.mirrorDir,
          specDir: workspace.specDir,
          runId: input.runId,
          sha: input.sha.toString(),
          executedGreen,
          ...(authVerifiedSha256 !== undefined ? { authVerifiedSha256 } : {}),
        });
        this.announceSuite(`[qa] suite store: kept ${kept.entries} file(s) (${kept.admitted} new or changed, ${kept.dropped} dropped${kept.skipped.length > 0 ? `, ${kept.skipped.length} left out` : ""})`, "info");
      } catch (captureErr) {
        rethrowIfUntrusted(captureErr);
        this.announceSuite(`[qa] suite store capture failed (off-path; verdict unchanged): ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`, "warn");
      }
    }
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

    /* Derive errorClass/valueScore once for both the persisted outcome and the returned result. */
    const gateValueScore = valueScore;
    const loopSignal = await closedLoopSignal();
    /* Thread the review loop's real final-round corrections into errorClass derivation. */
    const errorClass = this.deriveErrorClass(decision.verdict, coverageRatio, gateValueScore, finalReviewerCorrections);
    let mainlineOutcome: RunOutcome | undefined;
    if (!isContextCleanPass) {
      mainlineOutcome = this.toRunOutcome(input, decision, run.cases, retries, coverageRatio, errorClass, {
        staticOk: validation.ok,
        reviewerApproved: reviewerApprovedForOutcome,
        valueScore: gateValueScore,
        /* Real oracle counts when threaded; absent (never a fabricated 0) when the oracle never measured. */
        mutantCount,
        killedCount,
        reviewerCorrections: finalReviewerCorrections,
        ...(reviewerSignal !== undefined ? { reviewer: reviewerSignal } : {}),
        /* Publish outcome string — never fabricated when publish() was not called. */
        ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
        /* Rule ids on the mainline persist only. Other exits omit them. */
        ...(retrievedRuleIds.length ? { rulesRetrieved: retrievedRuleIds } : {}),
        ...(diffArchetypes ? { diffArchetypes } : {}),
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
        ...(loopSignal ? { closedLoop: loopSignal } : {}),
        ...(agentBrowserSignal() ? { agentBrowser: agentBrowserSignal() } : {}),
      });
      await this.deps.runHistory.save(mainlineOutcome);
      trail.phases.enter("learn");

      /*
       * What this outcome may teach is decided in one place (learningGates). Off-path: never gates
       * the verdict. app_defect suppresses the fold so the flywheel never learns to weaken a test
       * that caught a real bug.
       */
      const learning = learningGates({
        stage: "mainline",
        mode: input.mode,
        verdict: decision.verdict,
        errorClass: mainlineOutcome.errorClass,
        isCode: cfg.isCode,
        adjudicationClass: mainlineOutcome.adjudication?.class,
      });
      if (learning.fold) {
        await this.deps.learning.fold(mainlineOutcome);
      }

      /*
       * Off-path. Deliberately NOT gated on the learning gates: app_defect is the
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
       * Stricter than fold: no flaky verdict, and errorClass must be a real class that teaches
       * (a green pass must not mint a reflection rule). Fold-on-green is unchanged.
       * Fault-isolated in the adapter.
       */
      if (this.deps.reflector && learning.reflect) {
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

      /* Same gate as reflect, so processAudit and reflector stay independently optional. */
      if (this.deps.processAudit && learning.reflect) {
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
        ...(!isContextCleanPass && reviewerSignal !== undefined ? { reviewer: reviewerSignal } : {}),
        retries,
        preExecAmbiguityCatches,
        deterministicSelectorBlocks,
        catalogGateInWindow,
        catalogGateAdvisory,
        catalogGateFailClosed,
        ...(loopSignal ? { closedLoop: loopSignal } : {}),
        ...(agentBrowserSignal() ? { agentBrowser: agentBrowserSignal() } : {}),
      },
      cases: run.cases,
      logs: run.logs,
    };
  }

  /*
   * Shared errorClass derivation. Callers that never reach review omit
   * reviewerCorrections and get [].
   */
  private deriveErrorClass(
    verdict: string,
    coverageRatio: number | null,
    valueScore: number | null,
    reviewerCorrections: string[] = [],
    ends: { generationEnd?: GenerationEndKind | undefined; preconditionFailed?: boolean | undefined; reviewerUnavailable?: boolean | undefined } = {},
  ): string | null {
    /* Whatever path took the run to its infra-error, a launcher that refused to start agent code in it is the reason. */
    const sandboxUnavailable = verdict === "infra-error" && sandboxRefused();
    return resolveErrorClass({
      verdict,
      coverageRatio,
      minCoverageRatio: DEFAULT_MIN_COVERAGE_RATIO,
      reviewerCorrections,
      valueScore,
      ...(ends.generationEnd ? { generationEnd: ends.generationEnd } : {}),
      ...(ends.preconditionFailed ? { preconditionFailed: true } : {}),
      ...(ends.reviewerUnavailable ? { reviewerUnavailable: true } : {}),
      ...(sandboxUnavailable ? { sandboxUnavailable: true } : {}),
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
      /* What the review phase cost and decided; absent when no reviewer phase ran. */
      reviewer?: RunOutcome["gateSignals"]["reviewer"];
      valueScore?: number | null;
      /* Same "never ran" (absent) vs "ran and found zero" distinction as the sibling counts below. */
      mutantCount?: number;
      killedCount?: number;
      note?: string;
      rulesRetrieved?: string[];
      diffArchetypes?: string[];
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
      /* Absent when the run did not grant the run_spec tool. */
      closedLoop?: ClosedLoopGateSignal;
      /* Absent when the run did not grant the authenticated agent browser. */
      agentBrowser?: AgentBrowserGateSignal;
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
        /* Conditional-spread, not `?? 0`: absent means the oracle never measured this run. */
        ...(extra?.mutantCount !== undefined ? { mutantCount: extra.mutantCount } : {}),
        ...(extra?.killedCount !== undefined ? { killedCount: extra.killedCount } : {}),
        reviewerCorrections: extra?.reviewerCorrections ?? [],
        /* Conditional-spread: true undefined survives when no reviewer-unavailable rationale exists. */
        ...(extra?.reviewerRationale !== undefined ? { reviewerRationale: extra.reviewerRationale } : {}),
        ...(extra?.reviewerApproved !== undefined ? { reviewerApproved: extra.reviewerApproved } : {}),
        ...(extra?.reviewer !== undefined ? { reviewer: extra.reviewer } : {}),
        flaky: decision.verdict === "flaky",
        retries,
        preExecAmbiguityCatches: extra?.preExecAmbiguityCatches ?? 0,
        deterministicSelectorBlocks: extra?.deterministicSelectorBlocks ?? 0,
        catalogGateInWindow: extra?.catalogGateInWindow ?? 0,
        catalogGateAdvisory: extra?.catalogGateAdvisory ?? 0,
        catalogGateFailClosed: extra?.catalogGateFailClosed ?? 0,
        /* What the sandbox did for this run; absent when no child was started or refused. */
        ...(sandboxSignal() ? { sandbox: sandboxSignal()! } : {}),
        /*
         * Conditional-spread, not `?? 0`: "never ran" stays distinguishable from
         * "ran and found zero".
         */
        ...(extra?.structuralSignalBytes !== undefined ? { structuralSignalBytes: extra.structuralSignalBytes } : {}),
        ...(extra?.serviceLinksCount !== undefined ? { serviceLinksCount: extra.serviceLinksCount } : {}),
        ...(extra?.contractDriftCount !== undefined ? { contractDriftCount: extra.contractDriftCount } : {}),
        ...(extra?.crossRepoImpactedCount !== undefined ? { crossRepoImpactedCount: extra.crossRepoImpactedCount } : {}),
        ...(extra?.confinement !== undefined ? { confinement: extra.confinement } : {}),
        ...(extra?.closedLoop !== undefined ? { closedLoop: extra.closedLoop } : {}),
        ...(extra?.agentBrowser !== undefined ? { agentBrowser: extra.agentBrowser } : {}),
        ...(this.coordinationOf.has(input) ? { coordination: this.coordinationOf.get(input)! } : {}),
      },
      rulesRetrieved: extra?.rulesRetrieved ?? [],
      ...(extra?.diffArchetypes !== undefined ? { diffArchetypes: extra.diffArchetypes } : {}),
      ...(input.purpose !== undefined || extra?.note !== undefined ? { note: [input.purpose !== undefined ? `[${input.purpose}]` : undefined, extra?.note].filter((part) => part !== undefined).join(" ") } : {}),
      at: new Date().toISOString(),
      /* Persist the same cases + logs the returned result carries. Non-execute callers pass []. */
      cases,
      ...(extra?.logs !== undefined ? { logs: extra.logs } : {}),
      /* Conditional-spread — only when FixLoop genuinely produced a verdict class. */
      ...(extra?.adjudicationClass !== undefined ? { adjudication: { class: extra.adjudicationClass } } : {}),
    };
  }

  private skippedResult(
    /* Only the declared-no-op skip passes these: its note is the agent's reason, and reviewerApproved is present only when a reviewer ran. Classify-skip never persists. */
    { note, reviewerApproved: reviewerApprovedForOutcome }: { note?: string | undefined; reviewerApproved?: boolean | undefined } = {},
  ): RunQaResult {
    this.deps.observer?.onStep("done");
    return {
      decision: RunDecision.of("skipped", "none"),
      ...(note ? { note } : {}),
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
   * No-op when the port is unwired. unauthored is a setup note, not a failure. A failed prepare is
   * logged and returned as the infra-error note for the caller's terminal.
   */
  private async prepareAuth(specDir: string, phase: "pre-generate" | "pre-execute", signal?: AbortSignal): Promise<{ unauthored: boolean; setupSha256?: string } | { failed: string } | { precondition: PreconditionFailure }> {
    const sessionPort = this.deps.authSession;
    const ctx = this.deps.authContext;
    if (!sessionPort || !ctx) return { unauthored: false };
    let session: AuthSession;
    try {
      session = await sessionPort.prepare({
        specDir,
        baseUrl: ctx.baseUrl,
        ...(ctx.auth ? { auth: ctx.auth } : {}),
        phase,
      }, signal);
    } catch (err) {
      if (err instanceof AuthPreconditionError) {
        /* Its own fields only: a login failure never prints the error object, which could carry anything a page or a network said. */
        console.error(`[qa] auth precondition failed${phase === "pre-execute" ? " before execute" : ""}: kind=${err.kind} note=${err.note} ms=${err.ms}`);
        return { precondition: { kind: err.kind, note: err.note, ms: err.ms } };
      }
      console.error(`[qa] auth session failed${phase === "pre-execute" ? " before execute" : ""}:`, err);
      return { failed: `auth session failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (session.unauthored) {
      this.deps.observer?.onStep("setup", "auth setup is still the seed; generation may rewrite e2e/auth.setup.ts");
    }
    return { unauthored: session.unauthored, ...(session.setupSha256 !== undefined ? { setupSha256: session.setupSha256 } : {}) };
  }

  /*
   * The login restored from the suite store failed to sign in. It is marked as no longer working, taken out of the working copy and
   * the project setup run again, which seeds the stock login. "unchanged" when the store could not be told (the original failure
   * stands), "setup-failed" when the setup that follows threw, "replaced" when the caller should try the login once more.
   */
  private async replaceRestoredLogin(workspace: { specDir: string; mirrorDir: string }, signal?: AbortSignal): Promise<"replaced" | "unchanged" | "setup-failed"> {
    try {
      await this.deps.suiteStore!.demoteAuth(workspace, DEMOTE_REASON.LOGIN_DID_NOT_SIGN_IN);
    } catch (err) {
      rethrowIfUntrusted(err);
      this.announceSuite(`[qa] suite store could not demote the failed login (the failure stands): ${err instanceof Error ? err.message : String(err)}`, "warn");
      return "unchanged";
    }
    this.announceSuite("[qa] the login restored from the suite store failed to sign in; the stock seed replaces it and the login is tried once more", "warn");
    if (!this.deps.setup) return "replaced";
    try {
      await this.deps.setup.setup(workspace.specDir, signal);
    } catch (err) {
      console.error("[qa] setup phase failed while replacing the restored login:", err);
      return "setup-failed";
    }
    return "replaced";
  }

  /* One line about the suite store, on the console and on the run's own log. */
  private announceSuite(text: string, level: "info" | "warn"): void {
    (level === "warn" ? console.warn : console.log)(text);
    this.deps.observer?.onEvent({ type: "log.line", level, text });
  }

  /* What a failed precondition ends the run with: its kind and scrubbed note, never any evidence. */
  private preconditionNote(failure: PreconditionFailure): string {
    return `the app's login could not be completed before testing (${failure.kind}): ${failure.note}`;
  }

  /* A failed login is always loud: an error when it ends the run, a warning when a context run carries on without a session. */
  private announcePrecondition(failure: PreconditionFailure, ends: boolean): void {
    this.deps.observer?.onEvent({
      type: "log.line",
      level: ends ? "error" : "warn",
      text: ends
        ? `[qa] the run ended before generation (${failure.kind}) after ${failure.ms}ms: the app's login could not be completed, not a fault in the code under test`
        : `[qa] the app's login could not be completed (${failure.kind}) after ${failure.ms}ms; this context run continues without a session`,
    });
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
      rethrowIfUntrusted(err); /* a git dir that is not the orchestrator's is a security refusal, never a fault to isolate */
      console.error(
        `[qa] mirror gc FAILED (fault-isolated — run continues, never blocks publish): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /*
   * The run's reviewer could not be reached, after the suite ran green: the tests were never judged, which is neither an
   * approval nor a rejection. Ends the run as a persisted infra-error (its own class, nothing learned, no PR and no
   * Issue), logged loudly, with the reviewer's reason on the record. Fail-closed: nothing the reviewer was to judge is published.
   */
  private async reviewerUnavailableResult(
    cfg: RunQaConfig,
    input: RunQaInput,
    reason: string | undefined,
    passedCases: number,
    exit: Omit<TerminalOptions, "note" | "reviewerUnavailable" | "reviewerRationale"> & { static: boolean },
  ): Promise<RunQaResult> {
    const note = `The reviewer was unavailable (${reason ?? "no reason reported"}), so the suite (${passedCases} case(s), green) was never judged. Nothing was published: no PR, and no Issue, since this is not a rejection.`;
    console.error(`[qa] ${note}`);
    this.deps.observer?.onEvent({ type: "agent.error", detail: note });
    this.deps.observer?.onEvent({
      type: "log.line",
      level: "error",
      text: `[qa] the run ended with its reviewer unavailable (${ERROR_CLASS.REVIEWER_UNAVAILABLE}): an integration fault, not a rejection of the tests`,
    });
    const { static: staticOk, ...terminalExit } = exit;
    return await this.terminalResult("infra-error", cfg, input, { generating: true, static: staticOk }, {
      ...terminalExit,
      note,
      reviewerUnavailable: true,
      ...(reason !== undefined ? { reviewerRationale: reason } : {}),
    });
  }

  /* Both terminals persist. Only "invalid" also folds; "infra-error" does not. */
  private async terminalResult(
    verdict: "invalid" | "infra-error",
    cfg: RunQaConfig,
    input: RunQaInput,
    ev: { generating: boolean; static: boolean },
    opts: TerminalOptions = {},
  ): Promise<RunQaResult> {
    const {
      reviewerApproved: reviewerApprovedForOutcome,
      skipPersist = false,
      retries = 0,
      note,
      groundingSignals = NO_GROUNDING_SIGNALS,
      rulesRetrieved = [],
      diffArchetypes,
      archetype = null,
      confinement,
      tested,
      mirrorDir,
      generationEnd,
      preconditionFailed,
      reviewerUnavailable,
      reviewerRationale,
      closedLoop: loopSignal,
      agentBrowser: browserSignal,
    } = opts;
    const decision = decide({
      verdict,
      generating: ev.generating,
      needsReview: cfg.needsReview,
      reviewerApproved: true,
      blocksPublish: false,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
    });
    /* invalid → E-STATIC, infra-error → E-INFRA, unless a generation end or a failed precondition that ended the run names its own class. */
    const errorClass = this.deriveErrorClass(verdict, null, null, [], { generationEnd, preconditionFailed, reviewerUnavailable });
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
        ...(reviewerRationale !== undefined ? { reviewerRationale } : {}),
        ...groundingSignals,
        /* Empty retrieved ids omit the override; non-empty reach persist so the terminal fold can attribute. */
        ...(rulesRetrieved.length ? { rulesRetrieved } : {}),
        ...(diffArchetypes ? { diffArchetypes } : {}),
        ...(confinement !== undefined ? { confinement } : {}),
        ...(loopSignal ? { closedLoop: loopSignal } : {}),
        ...(browserSignal ? { agentBrowser: browserSignal } : {}),
        ...(this.coordinationOf.has(input) ? { coordination: this.coordinationOf.get(input)! } : {}),
      });
      await this.deps.runHistory.save(terminalOutcome);
      /*
       * The same learning gates as the mainline, at the terminal stage: a terminal outcome teaches
       * only through a class that teaches (a rejected static gate, an agent that ran out of steps),
       * never through an outage or a generation that decided nothing. Adjudication is always
       * undefined here today (FixLoop has not run); kept so a future reorder cannot bypass
       * app_defect suppression.
       */
      const learning = learningGates({
        stage: "terminal",
        mode: input.mode,
        verdict,
        errorClass: terminalOutcome.errorClass,
        isCode: cfg.isCode,
        adjudicationClass: terminalOutcome.adjudication?.class,
      });
      if (learning.fold) {
        await this.deps.learning.fold(terminalOutcome);
      }

      if (this.deps.reflector && learning.reflect) {
        const reflectStartedAt = Date.now();
        await this.deps.reflector.reflect(this.toReflectionInput(terminalOutcome, archetype));
        const reflectMs = Date.now() - reflectStartedAt;
        this.deps.observer?.onEvent({
          type: "log.line",
          level: "info",
          text: `[qa] reflect() for run ${terminalOutcome.runId} took ${reflectMs}ms`,
        });
      }

      /* Same independently-optional processAudit gate as the mainline, including the operating-signal-only audit. */
      if (this.deps.processAudit && (learning.reflect || observesOperatingSignal({ mode: input.mode, errorClass: terminalOutcome.errorClass }))) {
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
        ...(!skipPersist && loopSignal ? { closedLoop: loopSignal } : {}),
        ...(!skipPersist && browserSignal ? { agentBrowser: browserSignal } : {}),
        ...(!skipPersist && this.coordinationOf.has(input) ? { coordination: this.coordinationOf.get(input)! } : {}),
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
