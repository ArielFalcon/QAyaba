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
import { createHash } from "node:crypto";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { type RunMode, type RunPurpose, type TestTarget, type TriggerSource } from "@kernel/run-mode.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import { type NoopKind } from "@kernel/noop-kind.ts";
import { type CoordinationGateSignal, type CoordinationMode, type CoordinationSettings } from "@kernel/coordination.ts";
import type { LeadSidekicks } from "./coordination/lead-sidekicks.ts";
import type { QaCase } from "@kernel/qa-case.ts";
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
  PreExecGroundingPort,
  PreGenerationGroundingPort,
  ReviewDomGroundingPort,
  StructuralSignalPort,
  ServiceLinksPort,
  CrossRepoImpactPort,
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
} from "./ports/index.ts";
import { reviewerApprovalOf, type RunDeadlinePort } from "./ports/index.ts";

const NO_GROUNDING_SIGNALS = { preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 };

/** What a terminal exit knows beyond its verdict; each field is absent unless that exit genuinely has it — never fabricated. */
export interface TerminalOptions {
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
  /** The run ended on a judgment the reviewer and the generator could not settle: it names the run's error class. */
  reviewDisputed?: boolean | undefined;
  /** What the reviewer's runtime reported when it was unavailable, persisted on the run record. */
  reviewerRationale?: string | undefined;
  /** How the run_spec loop was used up to this exit; absent when the run did not grant it. */
  closedLoop?: ClosedLoopGateSignal | undefined;
  /** How the authenticated agent browser was used up to this exit; absent when the run did not grant it. */
  agentBrowser?: AgentBrowserGateSignal | undefined;
}

/** A login the run could not complete: the kind, a note already scrubbed of credentials, and the attempt's duration. */
export interface PreconditionFailure {
  kind: PreconditionKind;
  note: string;
  ms: number;
}
import { decide, isAccepted, type RunEvidence } from "../domain/run-decision.service.ts";
import { RunDecision } from "../domain/run-decision.ts";
import { RunPhaseCursor, recordPhaseSnapshot, type PhaseClock, type RunPhase } from "../domain/run-phase-cursor.ts";
import { PhaseSpans } from "./run-phase-spans.ts";
import { runFlow } from "./run-flow/run-flow.ts";
import { initialRunState } from "./run-flow/run-state.ts";
import { createRunServices } from "./run-flow/run-services.ts";
import type { RunContext, RunEnds, WorkspaceRunContext } from "./run-flow/run-context.ts";
import { checkDevHealth, executeAccepted as executeAcceptedOf, liveExecutionOptions, validateAccepted as validateAcceptedOf } from "./run-flow/phases/execute.steps.ts";
import { BEFORE_WORKSPACE, IN_WORKSPACE } from "./run-flow/run-steps.ts";
import { ProbeSweepError, closedLoopSignal as closedLoopSignalOf, loopClosedNow as loopClosedNowOf, regenerate as regenerateOf } from "./run-flow/phases/generation-services.ts";
import { DEMOTE_REASON } from "@kernel/ports/suite-store.port.ts";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { RedactionScope } from "@kernel/telemetry/telemetry.port.ts";
import { attachTraceFacts, type RunTraceFacts } from "@kernel/run-trace-facts.ts";
import { generationRunsReviewer } from "@contexts/generation/domain/generation-review.ts";
import { FixLoop, type FixLoopAcceptancePort, type FixLoopExecutionPort, type FixLoopGenerationPort, type FixLoopSelectorCheckPort } from "../domain/fix-loop.aggregate.ts";
import type { AdjudicatorVerdict } from "../domain/adjudicate.service.ts";
import { checkSpecSelectors, contradictionOrigins } from "../domain/helpers/selector-check.ts";
import { attributeContradictions } from "../domain/helpers/contradiction-attribution.ts";
import { precheckSpecsAgainstDom } from "../domain/deterministic-review-precheck.ts";
import { correctionClassOf } from "@contexts/generation/domain/review-output.ts";
import { renderSpecChanges, sameReviewedSpecs, type ReviewSpecText } from "@contexts/generation/domain/review-fingerprint.ts";
import { readConfinedSpecFile, listSpecFiles, readOwnedSpecFile, MAX_SPEC_SOURCE_BYTES, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { RegenerationAcceptance } from "./regeneration-acceptance.ts";
import type { SpecSnapshot } from "./ports/spec-snapshot.port.ts";
import { ERROR_CLASS, resolveErrorClass } from "../domain/helpers/error-class.ts";
import { AuthPreconditionError, type PreconditionKind } from "../domain/auth-precondition.ts";
import { learningGates, observesOperatingSignal } from "../domain/helpers/learning-gates.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";
import type { CoordinationTelemetryPort } from "./coordination/coordination-telemetry.ts";
import { renderCoverageGap } from "@contexts/objective-signal/domain/render-coverage-gap.ts";
import { filterReviewFindings } from "../domain/review-finding-filter.service.ts";
import { verifyRebuttals, findingKey, refKey, type DisputedFinding, type RebuttalEvidence, type ReviewRebuttal } from "../domain/review-rebuttals.service.ts";
import type { ContractFeedback } from "../domain/contract-feedback.ts";
import { diffContracts } from "@contexts/objective-signal/domain/test-intent-contract.ts";
import type { IntentContractPort } from "./ports/intent-contract.port.ts";
import type { ReflectorPort, ReflectionInput, ProcessAuditPort } from "@contexts/cross-run-learning/application/ports/index.ts";
import { detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";
import { rethrowIfUntrusted } from "../../../shared-kernel/domain-error.ts";
import { isRunDeadlineError, type RunDeadlineExceededError } from "../../../shared-kernel/run-deadline.ts";
import { renderRunDeadlineNote } from "../domain/run-time-budget.ts";

/* Same minRatio the coverage policy uses for the E-COVERAGE-GAP band. */
const DEFAULT_MIN_COVERAGE_RATIO = 0.7;

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

/* One digest for a whole spec set, so the fix loop can say whether it changed the files. Sorted, sha256 over `file + "\0" + bytes`; undefined when the set is empty or any file cannot be read. */
function specSetDigest(specRoot: SpecRoot, files: readonly string[]): string | undefined {
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const file of unique) {
    try {
      const bytes = readConfinedSpecFile(specRoot, file);
      hash.update(file).update("\0").update(bytes);
    } catch {
      return undefined;
    }
  }
  return hash.digest("hex");
}

/** Subset of host AppConfig the composition root passes in. The full shape is a shell concern. */
export interface RunQaConfig {
  needsReview: boolean;
  shadow: boolean;
  onFailure: string;
  maxRetries: number;
  isCode: boolean;
  /**
   * The master switch of the review-loop integrity work: failure triage (C), the intent lock (A) and
   * the findings filter (D). Off (default) keeps the pre-change behavior; the acceptance correctness
   * fixes are always on. When off, the intent-lock policy is not read.
   */
  reviewLoopIntegrity: boolean;
  /**
   * "signal" (default) measures and records but never blocks publish. Only
   * "enforce" holds the PR on a "fail" status. "unknown" never blocks in any mode.
   */
  coveragePolicyMode: "off" | "signal" | "enforce";
  /** The change-coverage threshold in force; recorded with the run's coverage decision. */
  coverageMinRatio?: number;
  /**
   * The test-intent lock: whether the contract a primary pass establishes binds later regenerations.
   * "signal" (default) records the deltas that would have been rejected; "enforce" rejects them and
   * restores the pre-turn bytes. The opacity ratio flags a contract, never blocks one.
   */
  intentLock?: { mode: "off" | "signal" | "enforce"; opacityFlagRatio: number };
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
  /** Extracts a spec's clause contract for the intent lock. Absent: the lock has nothing to judge and never rejects. */
  intentContract?: IntentContractPort;
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
    /** Present only when the recorded coverage predates the bytes an accepted regeneration wrote (signal mode). */
    coverage?: { stale: boolean };
    /** Present only when the recorded value score describes bytes an accepted regeneration rewrote. Never a gate. */
    value?: { stale: boolean };
    /** Present only when a regeneration went through acceptance. */
    integrity?: { acceptances: number; rejected: number; proofReused: number; capHit: boolean };
    /** Present only when the test-intent lock derived a contract this run. */
    intent?: { mode: string; violations: number; wouldReject: number; clauses: number; opaque: number; opacityHigh: boolean };
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

/*
 * The fallback a run gets when a composition passes no config at all. The review-loop master switch's
 * product default (on, opt-out) is resolved where `qa.reviewLoopIntegrity` lives — the app config, read by
 * buildRewrittenCompositionConfig and the composition root, both of which default it to true. This
 * fallback keeps the pre-switch flow for a caller that states nothing, so a missing config never grants
 * a slice silently; every composition that runs a real app states it.
 */
const DEFAULT_CONFIG: RunQaConfig = {
  needsReview: false,
  shadow: false,
  onFailure: "github-issue",
  maxRetries: 2,
  isCode: false,
  reviewLoopIntegrity: false,
  coveragePolicyMode: "signal",
  intentLock: { mode: "signal", opacityFlagRatio: 0.5 },
};

/** What the run knows when its deadline ends it: the little a terminal outcome carries, filled in as the run learns it. */
const DENIED_HOSTS_SHOWN = 20;

/* A refused name is whatever the child asked for; it is shown only when it looks like a host. */
function printableHost(host: string): string {
  return /^[A-Za-z0-9._:\[\]-]{1,253}$/.test(host) ? host : "(unprintable name)";
}

export interface RunTrail {
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
      await this.releaseGeneratorSession();
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

  /* Ends the generator session the run kept for its regenerations. A fault is said and never changes how the run ended. */
  private async releaseGeneratorSession(): Promise<void> {
    try {
      await this.deps.generation.release?.();
    } catch (err) {
      console.error(`[qa] releasing the generator session failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
    }
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
    const ends: RunEnds = {
      aborted: (mirrorDir) => this.abortedResult(mirrorDir),
      infraError: (note, mirrorDir) => this.infraErrorResult(note, mirrorDir),
      skipped: (opts) => this.skippedResult(opts),
      persistSkipped: async (skipped, extra) => {
        const skippedOutcome = this.toRunOutcome(input, skipped.decision, [], 0, null, skipped.errorClass, {
          reviewerApproved: skipped.gateSignals.reviewerApproved,
          ...(extra.noop ? { noop: extra.noop } : {}),
          ...(skipped.note !== undefined ? { note: skipped.note } : {}),
          ...(extra.confinement !== undefined ? { confinement: extra.confinement } : {}),
          ...(extra.closedLoop ? { closedLoop: extra.closedLoop } : {}),
          ...(extra.agentBrowser ? { agentBrowser: extra.agentBrowser } : {}),
        });
        await this.deps.runHistory.save(skippedOutcome);
        await this.pruneMirrorIfWired(trail.mirrorDir!);
        return { ...skipped, outcome: skippedOutcome };
      },
      recordCoordination: (coordinationSignal) => void this.coordinationOf.set(input, coordinationSignal),
      noteGroundingGates: (result) => this.noteGroundingGates(trail, result),
      pruneMirror: (mirrorDir) => this.pruneMirrorIfWired(mirrorDir),
      noteDeadlineArmed: () => this.noteDeadlineArmed(trail),
      prepareAuth: (specDir, phase, abortSignal) => this.prepareAuth(specDir, phase, abortSignal),
      replaceRestoredLogin: (workspace, abortSignal) => this.replaceRestoredLogin(workspace, abortSignal),
      announceSuite: (text, level) => this.announceSuite(text, level),
      announcePrecondition: (failure, ends) => this.announcePrecondition(failure, ends),
      preconditionNote: (failure) => this.preconditionNote(failure),
      terminal: (verdict, ev, opts) => this.terminalResult(verdict, cfg, input, ev, opts),
    };
    const baseCtx: RunContext = { input, signal, trail, deps: this.deps, cfg, startedAt, cycleBudget, wallClockBudget, ends };
    const enter = (phase: RunPhase): void => trail.phases.enter(phase);
    const state = initialRunState();

    const opening = await runFlow(BEFORE_WORKSPACE, state, baseCtx, enter);
    if ("end" in opening) return opening.end;

    trail.phases.enter("workspace");
    const workspace = await this.deps.workspace.prepare(input.sha);
    trail.mirrorDir = workspace.mirrorDir;
    const services = createRunServices(this.deps, cfg, workspace, signal);
    const ctx: WorkspaceRunContext = { ...baseCtx, workspace, services, generation: { delivered: [] } };
    const flow = await runFlow(IN_WORKSPACE, state, ctx, enter);
    if ("end" in flow) return flow.end;

    /* The steps not yet in the table read the run's state and services by their former names. */
    const { specRoot, proofLedger, integrityCounters, snapshotPort, intentLock, intentState, primeIntentBaseline, contractCheck, acceptance, runDeadlinePort, suiteChangedFiles, snapshotSuite, acceptanceScope } = services;
    const enforceConfinement = services.confinement.enforce;
    const { diff: classificationDiff, intent: classificationIntent, reason: classificationReason, contradiction: classificationContradiction, generating } = state.classification;
    let acceptanceCalls = 0;
    /* Whether an accepted regeneration rewrote specs after the last coverage measurement: the coverage ratio is then stale. */
    let acceptedRegenAfterMeasure = false;

    const { suiteRestored } = state.setup;
    const { closedLoop, agentBrowser } = trail;
    const agentBrowserSignal = (): AgentBrowserGateSignal | undefined => agentBrowser?.signals();
    const {
      diffArchetypes, retrievedRules, retrievedRuleIds, offeredArchetypes, existingSpecFiles: groundingExistingSpecFiles,
      blastRadiusSignal, serviceLinks: resolvedServiceLinks, contractDrift: resolvedContractDrift, crossRepoImpact,
    } = state.grounding;
    /* The same BlastRadius the ground phase queried the structural signal with; measure() scopes the code-target oracle to it. */
    const runBlastRadius = BlastRadius.of(input.sha, classificationIntent?.changedFiles ?? []);

    /* The generation and the pre-exec grounding the generate phase left, and the generation closures the later phases still call. */
    let generated = state.generation.generated;
    const { preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed } = state.generation;
    const generation = ctx.generation;
    const loopClosedNow = (): Promise<boolean> => loopClosedNowOf(ctx);
    const closedLoopSignal = (): Promise<ClosedLoopGateSignal | undefined> => closedLoopSignalOf(ctx);
    const regenerate = (regenerationSignal: AbortSignal | undefined, enrichment: GenerationEnrichment): Promise<GenerationOutput> => regenerateOf(state, ctx, regenerationSignal, enrichment);

    /*
     * Separate from generation enrichment: ReviewEnrichment has no sha/contextPack.
     * domSnapshot is captured per review round on the current specs.
     */
    const baseReviewEnrichment = {
      runId: input.runId,
      ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
    };

    /* Shared retries counter for the static-fix loop AND the FixLoop — accumulate, never reset. */
    let retries = state.execution.retries;
    /* Winning FixLoop execute namespace (`${runId}-rN`). Absent when the loop never ran. */
    let coverageNamespace: string | undefined;
    /* Undefined when FixLoop never engaged — never fabricated. */
    let lastAdjudicatorVerdictClass: string | undefined;
    /* Full adjudicator verdict for the Issue body. Undefined when FixLoop never engaged. */
    let lastAdjudicatorVerdict: AdjudicatorVerdict | undefined;
    /* FixLoop's final specMetas. Undefined when it never regenerated. resolveTested() decides precedence. */
    let fixLoopFinalSpecMetas: { flow?: string; objective?: string }[] | undefined;
    const deterministicSelectorBlocks = 0;
    /* Pre-exec corrections, and the files they were attributed to, still feed later FixLoop regens until the first of them consumes them. */
    let pendingSelectorContradictions: string[] = state.generation.groundingCorrections;
    let pendingAttributedSpecFiles: string[] = state.generation.groundingAttribution;

    /* What the validate, health and execute phases left, and the execution closures the later phases still call. */
    const { validation, lastGenerated, authVerifiedSha256 } = state.execution;
    let run = state.execution.run;
    let devNotRenderedConclusive = false;
    const devHealthy = async (): Promise<boolean> => (await checkDevHealth(ctx)).healthy;
    const reviewerApprovedFromGeneration = reviewerApprovalOf(lastGenerated);
    /*
     * Prefer FixLoop's final specMetas when present; otherwise lastGenerated's.
     * Undefined when neither source has anything — the "tested" section is omitted.
     */
    const resolveTested = (): { flow?: string; objective?: string }[] | undefined =>
      fixLoopFinalSpecMetas?.length ? fixLoopFinalSpecMetas : lastGenerated.specMetas;
    const liveExecutionOpts = liveExecutionOptions(ctx);
    const executeAccepted = executeAcceptedOf(ctx);
    const validateAccepted = validateAcceptedOf(ctx);

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
            ...(fixLoopInput.retries !== undefined ? { retries: fixLoopInput.retries } : {}),
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
            ...(r.testCorrect ? { testCorrect: r.testCorrect } : {}),
          };
        },
      };
      const fixLoopSelectorCheck: FixLoopSelectorCheckPort = {
        check: (specSources, trees) => ({ ...checkSpecSelectors(specSources, trees), origins: contradictionOrigins(specSources, trees) }),
      };
      /*
       * The run's acceptance of a fix-loop round: the snapshot the turn may change, the validation and
       * execution of the changed specs (a failing round is adopted so the loop repairs from it), and
       * the bytes of the round that produced the best run. Always wired: the byte restore is a
       * correctness fix, never behind the review-loop switch.
       */
      const fixLoopAcceptance: FixLoopAcceptancePort = {
        begin: () => snapshotSuite(),
        accept: async ({ round, specs, namespace }) => {
          const snapshot = round as SpecSnapshot;
          /* A round that changed anything the specs import is accepted over the whole suite, never over its specs alone. */
          const changedSpecFiles = acceptanceScope(await suiteChangedFiles(snapshot, specs));
          if (changedSpecFiles.length === 0) {
            /* The turn changed no bytes: nothing to accept, and the round's current bytes are its token. */
            return { kind: "accepted", changedSpecFiles, accepted: snapshot };
          }
          const outcome = await acceptance.accept({
            specDir: workspace.specDir,
            changedSpecFiles,
            namespace,
            snapshot,
            adoptFailures: true,
            ...(closedLoop ? { closedLoop } : {}),
            deadline: runDeadlinePort,
            validate: validateAccepted,
            execute: executeAccepted,
          });
          if (outcome.kind === "accepted") {
            integrityCounters.acceptances += 1;
            if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
            /* The bytes this round leaves behind are the token a later, worse round is measured against. */
            const accepted = await snapshotSuite();
            return {
              kind: "accepted",
              changedSpecFiles,
              ...(outcome.execution ? { execution: { verdict: outcome.execution.verdict, cases: [...outcome.execution.cases] } } : {}),
              accepted,
            };
          }
          if (outcome.kind === "cap") {
            integrityCounters.capHit = true;
            return { kind: "cap" };
          }
          integrityCounters.rejected += 1;
          return {
            kind: "rejected",
            reason: outcome.reason,
            ...(outcome.execution
              ? { execution: { verdict: outcome.execution.verdict, cases: [...outcome.execution.cases] } }
              : {}),
          };
        },
        restore: async (token) => {
          const snapshot = token as SpecSnapshot;
          /* Every file created after the best round goes, and its own bytes go back: the suite is exactly the best round's. */
          const created = listSpecFiles(workspace.specDir).filter((file) => !snapshot.files.has(file));
          await snapshotPort.restore(workspace.specDir, snapshot, created);
        },
      };
      const fixLoop = new FixLoop({
        execution: fixLoopExecution,
        generation: fixLoopGeneration,
        selectorCheck: fixLoopSelectorCheck,
        acceptance: fixLoopAcceptance,
      });
      /*
       * coverageLikelyMeasured omits the cross-repo conjunct on purpose: a false
       * positive only disables filtered-retry (widens the safety net). Threading true
       * prevents filtered-retry from undercounting change-coverage's denominator.
       */
      const coverageWillMeasure = generating && input.mode === "diff" && cfg.coveragePolicyMode !== "off";
      /*
       * The objective a failure is judged against: the change's own files on a diff run, the guidance
       * a manual run was asked to cover. Feeds the adjudicator's objective_gap rule; empty when the
       * run has neither (manual without guidance).
       */
      const objectiveSource = input.mode === "manual"
        ? (input.guidance ? [input.guidance] : [])
        : (classificationIntent?.changedFiles ?? []);
      /* Round 0 Lever-2 seed. Absent when the adapter has no readSpecSource — never fabricated. */
      const initialSpecSources = lastGenerated.specSources;
      /* Failure-point DOM from the initial failing cases, before any FixLoop re-execute. */
      const failureDomSnapshot = buildFailureDomSnapshot(run.cases);
      /* The generator saw every delivered spec pass against DEV in these very bytes: a failure now is not one a rewrite is likely to cure, so it is adjudicated for its Issue and not regenerated. */
      const fixLoopRetired = await loopClosedNow();
      if (fixLoopRetired) {
        this.deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] the suite failed, but every delivered spec was seen passing through run_spec: the failure is adjudicated and not regenerated" });
      }
      /* The failing set and the spec-set digest before the loop, so the phase span can carry what the loop changed. */
      const fixLoopSpecRoot: SpecRoot = { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir };
      const failingBefore = run.cases.filter((c) => c.status === "fail").length;
      const specShaBefore = specSetDigest(fixLoopSpecRoot, run.cases.map((c) => c.file).filter((f): f is string => !!f));
      const fixLoopResult = await fixLoop.run({
        initialRun: { verdict: run.verdict, cases: run.cases },
        isCode: cfg.isCode,
        generating,
        mode: input.mode,
        objectiveSource,
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
        ...(cfg.reviewLoopIntegrity
          ? {
              integrity: {
                hasGreenProof: async (file: string) => {
                  if (proofLedger.has(file)) return true;
                  if (!closedLoop) return false;
                  try {
                    return await closedLoop.isClosed([file]);
                  } catch (err) {
                    console.error(`[qa] could not read the green proof of ${file} (triage treats it as unproven): ${err instanceof Error ? err.message : String(err)}`);
                    return false;
                  }
                },
                spendExecution: () => acceptance.spendExecution(),
                remainingMs: () => runDeadlinePort.remainingMs?.(),
              },
            }
          : {}),
      });
      run = { verdict: fixLoopResult.run.verdict, cases: fixLoopResult.run.cases, logs: run.logs };
      /* Accumulate onto shared retries (`+=`); a reassignment would drop static-fix rounds. */
      retries += fixLoopResult.retries;
      coverageNamespace = fixLoopResult.coverageNamespace;
      /* Undefined when the loop never reached adjudicate() — never fabricated. */
      lastAdjudicatorVerdictClass = fixLoopResult.lastAdjudicatorVerdict?.class;
      lastAdjudicatorVerdict = fixLoopResult.lastAdjudicatorVerdict;
      fixLoopFinalSpecMetas = fixLoopResult.lastSpecMetas;
      /* The fix_loop phase span carries what the loop came to, so a false positive (a failed run the loop changed nothing in) is queryable. */
      const failingAfter = run.cases.filter((c) => c.status === "fail").length;
      const specShaAfter = specSetDigest(fixLoopSpecRoot, run.cases.map((c) => c.file).filter((f): f is string => !!f));
      try {
        trail.spans.annotate({
          "qayaba.phase.outcome": run.verdict,
          "qayaba.fix_loop.rounds": fixLoopResult.retries,
          "qayaba.fix_loop.failing_before": failingBefore,
          "qayaba.fix_loop.failing_after": failingAfter,
          "qayaba.fix_loop.absent_selectors": fixLoopResult.absentSelectors,
          ...(specShaBefore !== undefined && specShaAfter !== undefined
            ? {
                "qayaba.fix_loop.spec_sha_before": specShaBefore,
                "qayaba.fix_loop.spec_sha_after": specShaAfter,
                "qayaba.fix_loop.specs_changed": specShaBefore !== specShaAfter,
              }
            : {}),
        });
      } catch (err) {
        console.error(`[qa] the fix-loop phase outcome could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
      }
      devNotRenderedConclusive = fixLoopResult.preconditionFailed;
      if (fixLoopResult.rejectedClaims > 0) {
        this.deps.observer?.onEvent({ type: "log.line", level: "info", text: `[qa] ${fixLoopResult.rejectedClaims} test-correct claim(s) rejected as unverified; the loop kept repairing` });
      }
    }

    /*
     * The suite store admits a spec only with the bytes that executed green, so those bytes are fingerprinted here and read into
     * the proof ledger, before the reviewer's correction rounds or the coverage regeneration can rewrite a file that is never
     * executed again. Off-path: a fault leaves no evidence, and a capture without evidence admits no spec.
     */
    if (this.deps.suiteStore && suiteRestored && run.verdict === "pass") {
      try {
        /* The green run executed the whole suite: every delivered spec on disk at this instant has run in these bytes. The store
         * leaves out a spec it cannot read confined, which seeds no proof (the final guard then refuses to publish it). */
        const fingerprints = await this.deps.suiteStore.fingerprint(
          { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir },
          generation.delivered.map((d) => d.file),
        );
        /* The ledger holds the green bytes themselves when they can be read, so a later restore has them. */
        for (const [file, sha256] of fingerprints) {
          const read = readOwnedSpecFile(specRoot, file, MAX_SPEC_SOURCE_BYTES);
          proofLedger.set(file, "bytes" in read ? { sha256, bytes: read.bytes } : { sha256 });
        }
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
    /* Whether this run measured a real per-commit coverage signal (a diff run on one repo): only then can its ratio go stale. */
    let coverageMeasured = false;
    /* The measurement predates the bytes an accepted regeneration wrote, and the mode reuses it rather than re-measuring. */
    let coverageStale = false;
    /* The same regenerated bytes make the value score describe a suite that is no longer on disk. The oracle stays signal-only: stale is recorded, never a gate. */
    let valueStale = false;
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
      coverageMeasured = input.mode === "diff" && !input.triggerRepo;
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
       * Enforce-mode one-shot coverage regen: this block runs at most once per run (it is not inside
       * any loop) and is independent of the FixLoop budget. A regen throw propagates. The regen's
       * changed specs go through acceptance: they execute green (or reuse a proof) before they stand.
       * A rejected or capped regen keeps the first measurement and restores the prior bytes. The
       * whole-suite re-measure that decides coverage is the single final re-measure before decide.
       */
      if (blocksPublish && input.mode === "diff" && !input.triggerRepo) {
        try {
          const gap = renderCoverageGap(signal.uncovered ?? []);
          const snapshot = await snapshotSuite();
          const deliveredBefore = generation.delivered;
          const regen = await regenerate(undefined, { coverageGap: gap });
          await enforceConfinement();
          const changedFiles = await suiteChangedFiles(snapshot, regen.specs);
          const changedSpecFiles = acceptanceScope(changedFiles);
          if (regen.specs.length === 0) {
            /* A coverage turn that delivers no specs is not a change to accept: whatever it wrote is put back. */
            if (changedFiles.length > 0) {
              await snapshotPort.restore(workspace.specDir, snapshot, changedFiles.filter((file) => !snapshot.files.has(file)));
            }
            generation.delivered = deliveredBefore;
          } else if (changedSpecFiles.length > 0) {
            const outcome = await acceptance.accept({
              specDir: workspace.specDir,
              changedSpecFiles,
              namespace: `${input.runId}-acc${acceptanceCalls++}`,
              snapshot,
              ...(closedLoop ? { closedLoop } : {}),
              deadline: runDeadlinePort,
              validate: validateAccepted,
              execute: executeAccepted,
            });
            if (outcome.kind === "accepted") {
              integrityCounters.acceptances += 1;
              if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
              acceptedRegenAfterMeasure = true;
              if (outcome.execution?.cases.length) {
                const changedSet = new Set(changedSpecFiles);
                run = { ...run, cases: [...run.cases.filter((c) => !changedSet.has(c.file ?? c.name)), ...outcome.execution.cases] };
              }
            } else {
              /* Rejected or capped: the turn's specs are not the run's. */
              generation.delivered = deliveredBefore;
              if (outcome.kind === "rejected") integrityCounters.rejected += 1;
              else integrityCounters.capHit = true;
              /* The first measurement and the prior bytes stand. */
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
      const deliveredFiles = new Set(generation.delivered.map((d) => d.file));
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
      /*
       * What the current bytes prove, the only facts a rebuttal can rest on: the cases that ran green (a case name,
       * or a spec file whose every case passed), and the contract clauses the bytes still hold. A basis the run
       * cannot check stays unverified, so the finding it answers keeps standing.
       */
      const rebuttalEvidence = async (rebuttals: readonly ReviewRebuttal[]): Promise<RebuttalEvidence> => {
        const failedFiles = new Set(run.cases.filter((c) => c.status !== "pass" && c.file).map((c) => c.file!));
        const greenCaseRefs = new Set<string>();
        for (const c of run.cases) {
          if (c.status !== "pass") continue;
          greenCaseRefs.add(refKey(c.name));
          if (c.file && !failedFiles.has(c.file)) greenCaseRefs.add(refKey(c.file));
        }
        const intactClauses = new Set<string>();
        const extractor = this.deps.intentContract;
        if (extractor) {
          for (const rebuttal of rebuttals) {
            if (rebuttal.basis !== "contract") continue;
            const key = refKey(rebuttal.ref);
            const hash = key.lastIndexOf("#");
            const file = hash > 0 ? key.slice(0, hash) : "";
            const clause = hash > 0 ? key.slice(hash + 1) : "";
            if (!file || !clause) continue;
            try {
              const extraction = extractor.extract(file, readConfinedSpecFile(specRoot, file));
              const baseline = intentState.baselines.get(file) ?? [];
              const violated = diffContracts(baseline, extraction.specs, intentState.tokens).some((delta) => delta.clauseId === clause);
              if (!violated && extraction.specs.some((spec) => spec.clauses.some((c) => c.id === clause))) intactClauses.add(key);
            } catch {
              /* An unreadable spec or clause proves nothing: the rebuttal stays unverified. */
            }
          }
        }
        return { greenCaseRefs, intactClauses };
      };
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
        rebuttals: 0,
        rebuttalWithdrawn: 0,
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
      /* The review phase span carries what the review came to, so a false-positive rejection is queryable. Only set once a round has judged. */
      let lastReviewOutcome: string | undefined;
      let lastCorrectionClass: string | undefined;
      const annotateReviewPhase = (outcome: string): void => {
        try {
          trail.spans.annotate({
            "qayaba.phase.outcome": outcome,
            "qayaba.review.rounds": reviewStats.rounds,
            "qayaba.review.model_rounds": reviewStats.modelRounds,
            "qayaba.review.blocking": reviewStats.blocking,
            "qayaba.review.correction_class": lastCorrectionClass ?? "none",
          });
        } catch (err) {
          console.error(`[qa] the review phase outcome could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
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
              /* The run's own execution of the specs under review: the reviewer weighs a 5xx or a redirect against the test instead of guessing. */
              ...(reviewCases.length > 0 ? { executionEvidence: { verdict: run.verdict, cases: reviewCases } } : {}),
            });
            reviewStats.modelRounds++;
            addReviewStats(reviewResult.stats);
          }
        }
        reviewStats.rounds++;
        /*
         * The findings filter (D): only a finding that cites a contract clause, an execution or a DOM
         * fact this run can verify may block. Everything else is advisory telemetry, never sent to the
         * generator. The pre-check is the orchestrator's own deterministic evidence, so it is not a
         * reviewer finding and is never filtered. Gated by the master switch.
         */
        let filteredReviewFindings = 0;
        let advisoryReviewFindings = 0;
        if (cfg.reviewLoopIntegrity && decidedBy === "model" && reviewResult.corrections.length > 0) {
          const findings = reviewResult.corrections.map((text, index) => ({
            text,
            severity: reviewResult.severities?.[index] ?? ("blocking" as const),
            ...(reviewResult.citations?.[index] ? { citation: reviewResult.citations[index]! } : {}),
          }));
          const filtered = filterReviewFindings(findings, {
            inScopeSpecs: new Set(reviewCases.map((c) => c.file ?? c.name)),
            executedSpecs: new Set(run.cases.map((c) => c.file).filter((file): file is string => !!file)),
          });
          filteredReviewFindings = filtered.dropped.length;
          advisoryReviewFindings = filtered.advisory.length;
          if (filtered.dropped.length > 0 || filtered.advisory.length > 0) {
            try {
              this.telemetry.counter("qayaba.review.filtered")(filtered.dropped.length, { "qayaba.app": input.app });
              this.telemetry.counter("qayaba.review.advisory")(filtered.advisory.length, { "qayaba.app": input.app });
            } catch (err) {
              console.error(`[telemetry] the filtered-findings counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          reviewResult = {
            ...reviewResult,
            /* Only a verified finding can keep the reviewer's rejection standing. */
            approved: filtered.blocking.length === 0,
            corrections: filtered.blocking,
            severities: filtered.blocking.map(() => "blocking" as const),
            citations: filtered.blocking.map(() => undefined),
            blockingCount: filtered.blocking.length,
          };
        }
        const reviewedBlocking = reviewResult.blockingCount ?? reviewResult.corrections.length;
        if (!reviewResult.unavailable) reviewStats.blocking = reviewedBlocking;
        const reviewOutcome = reviewResult.unavailable ? "unavailable" : reviewResult.parsed === false ? "parse-miss" : reviewResult.approved && reviewedBlocking === 0 ? "approved" : "rejected";
        const correctionClass = reviewedBlocking > 0 ? correctionClassOf(reviewResult.corrections) : "none";
        lastReviewOutcome = reviewOutcome;
        lastCorrectionClass = correctionClass;
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
              /* What the filter set aside: a dropped finding can never block, an advisory one is recorded only. */
              ...(filteredReviewFindings > 0 ? { "qayaba.review.filtered": filteredReviewFindings } : {}),
              ...(advisoryReviewFindings > 0 ? { "qayaba.review.advisory": advisoryReviewFindings } : {}),
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
          annotateReviewPhase("unavailable");
          return await this.reviewerUnavailableResult(cfg, input, reviewResult.rationale, reviewCases.length, {
            static: validation.ok,
            retries,
            rulesRetrieved: retrievedRuleIds,
            diffArchetypes,
            archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
            confinement: services.confinement.totals,
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
        const snapshot = await snapshotSuite();
        const deliveredBefore = generation.delivered;
        let regen: GenerationOutput;
        let changedSpecFiles: string[] = [];
        let changedSupportFiles: string[] = [];
        let outcome: Awaited<ReturnType<RegenerationAcceptance["accept"]>> | undefined;
        /*
         * One correction round, with the turn's bytes accepted or given back. A round the contract refuses is sent back
         * once with the violations as facts (A-2b): the generator learns the bound the run holds it to inside the run,
         * and the retry spends no DEV time because the contract is checked before validation and execution. The bound is
         * per round, so the review loop's own round budget still caps the whole phase.
         */
        let contractFeedback: readonly ContractFeedback[] | undefined;
        for (let attempt = 0; ; attempt++) {
          /* A refused attempt's files were restored, so its delivery must not survive into the next one. */
          generation.delivered = deliveredBefore;
          regen = await regenerate(signal, {
            reviewCorrections: reviewResult.corrections,
            ...(contractFeedback ? { contractFeedback } : {}),
          });
          await enforceConfinement();
          const changed = await suiteChangedFiles(snapshot, regen.specs);
          changedSpecFiles = acceptanceScope(changed);
          changedSupportFiles = changed.filter((file) => !file.endsWith(".spec.ts"));
          if (regen.specs.length === 0) break;
          outcome = await acceptance.accept({
            specDir: workspace.specDir,
            changedSpecFiles,
            namespace: `${input.runId}-acc${acceptanceCalls++}`,
            snapshot,
            ...(closedLoop ? { closedLoop } : {}),
            deadline: runDeadlinePort,
            validate: validateAccepted,
            execute: executeAccepted,
          });
          if (outcome.kind !== "rejected" || !outcome.violations?.length || attempt >= 1) break;
          /* The refused attempt is one rejected regeneration, even though the round goes on to answer it. */
          integrityCounters.rejected += 1;
          contractFeedback = outcome.violations;
        }
        /*
         * A rebuttal answers a reviewer finding; the deterministic pre-check is the orchestrator's own evidence and is
         * never rebuttable, so only a model round's findings are open to one. A verified rebuttal withdraws its finding;
         * one the run cannot check leaves the finding standing and is remembered as what the generator refused.
         */
        const rebuttals = cfg.reviewLoopIntegrity && decidedBy === "model" ? (regen.rebuttals ?? []) : [];
        const settled = rebuttals.length > 0
          ? verifyRebuttals(rebuttals, reviewResult.corrections, await rebuttalEvidence(rebuttals))
          : { withdrawn: [], disputed: [] };
        const withdrawn = new Set(settled.withdrawn.map(findingKey));
        const outstanding = reviewResult.corrections.filter((finding) => !withdrawn.has(findingKey(finding)));
        if (rebuttals.length > 0) {
          reviewStats.rebuttals += rebuttals.length;
          reviewStats.rebuttalWithdrawn += settled.withdrawn.length;
          /* Observe-only: a rebuttal is recorded with what the orchestrator made of it, and never changes a verdict by itself. */
          try {
            this.telemetry.counter("qayaba.review.rebuttal")(settled.withdrawn.length, { "qayaba.app": input.app, "qayaba.review.rebuttal.outcome": "withdrawn" });
            this.telemetry.counter("qayaba.review.rebuttal")(settled.disputed.length, { "qayaba.app": input.app, "qayaba.review.rebuttal.outcome": "disputed" });
          } catch (err) {
            console.error(`[telemetry] the rebuttal counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (regen.specs.length === 0) {
          /* A regen that produced no reviewable specs must not inherit the generator's self-approval; whatever its turn wrote is put back. */
          const restored = [...new Set([...changedSpecFiles, ...changedSupportFiles])];
          if (restored.length > 0) {
            await snapshotPort.restore(workspace.specDir, snapshot, restored.filter((file) => !snapshot.files.has(file)));
          }
          generation.delivered = deliveredBefore;
          /* Every blocking finding withdrawn with evidence, and no new bytes: the reviewed bytes stand approved. */
          if (reviewResult.corrections.length > 0 && outstanding.length === 0) {
            reviewerApproved = true;
            finalReviewerCorrections = [];
            break;
          }
          /*
           * A verified finding survives while the generator's answer to it is a claim nobody can check. Correcting it
           * was possible and the turn delivered nothing, so opening an Issue would accuse a test the reviewer never
           * justified, and publishing would ignore the finding: the engine reports that it could not settle it.
           */
          if (settled.disputed.length > 0) {
            return await this.reviewDisputedResult(cfg, input, settled.disputed, reviewCases.filter((c) => c.status === "pass").length, {
              static: validation.ok,
              retries,
              rulesRetrieved: retrievedRuleIds,
              diffArchetypes,
              archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
              confinement: services.confinement.totals,
              tested: resolveTested(),
              mirrorDir: workspace.mirrorDir,
              closedLoop: await closedLoopSignal(),
              agentBrowser: agentBrowserSignal(),
            });
          }
          reviewerApproved = false;
          break;
        }
        /* The surviving findings are the next round's convergence context: a withdrawn one is not raised again. */
        if (withdrawn.size > 0) {
          previousRoundCorrections = outstanding;
          previousRoundBlocking = outstanding.length;
        }
        /*
         * The regenerated specs stand only once they execute green (or reuse a proof): they went through the same
         * acceptance as the coverage regen. Never let unaccepted bytes stand.
         */
        if (outcome?.kind === "accepted") {
          integrityCounters.acceptances += 1;
          if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
          acceptedRegenAfterMeasure = true;
          const changedSet = new Set(changedSpecFiles);
          const realCases = outcome.execution?.cases ?? [];
          if (realCases.length > 0) {
            /* Replace the changed files' cases with the acceptance execution's real cases; unchanged files keep theirs. */
            run = { ...run, cases: [...run.cases.filter((c) => !changedSet.has(c.file ?? c.name)), ...realCases] };
            reviewCases = [...realCases, ...reviewCases.filter((c) => !changedSet.has(c.file ?? c.name))];
          }
          /* Proof reuse executed nothing: the existing cases already describe the bytes on disk. */
        } else {
          generation.delivered = deliveredBefore;
          reviewerApproved = false;
          finalReviewerCorrections = reviewResult.corrections;
          if (outcome?.kind === "cap") integrityCounters.capHit = true;
          else integrityCounters.rejected += 1;
          break;
        }
      }
      /* A genuine review verdict overwrites generation's self-approval default. */
      reviewerApprovedForOutcome = reviewerApproved;
      if (lastReviewOutcome !== undefined) annotateReviewPhase(lastReviewOutcome);
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
        ...(reviewStats.rebuttals > 0 ? { rebuttals: { received: reviewStats.rebuttals, withdrawn: reviewStats.rebuttalWithdrawn } } : {}),
      };
    }

    /*
     * The coverage this run measured is stale when an accepted regeneration followed it. Under enforce, one whole-suite measured
     * execution before decide refreshes it (the coverage regeneration's own run counts when it is the last accepted one, so this
     * never runs twice); under signal the prior measurement is reused and marked stale. A measured execution that ends red is the
     * run's verdict: a red suite is never published.
     */
    if (run.verdict === "pass" && coverageMeasured && acceptedRegenAfterMeasure) {
      if (cfg.coveragePolicyMode === "enforce") {
        const finalNamespace = `${input.runId}-coverage-final`;
        const measuredRun = await this.deps.execution.execute(workspace.specDir, { ...liveExecutionOpts, namespace: finalNamespace });
        run = { verdict: measuredRun.verdict, cases: measuredRun.cases, logs: run.logs };
        if (measuredRun.verdict === "pass") {
          const baselineCases = measuredRun.cases.filter((c) => c.status === "pass").map((c) => c.name);
          const finalSignal = await this.deps.objectiveSignal.measure(
            runBlastRadius,
            workspace.specDir,
            classificationDiff,
            baselineCases,
            { namespace: finalNamespace },
          );
          coverageRatio = finalSignal.ratio;
          coverageStatus = finalSignal.status;
          trail.coverageStatus = finalSignal.status;
          blocksPublish = this.deps.objectiveSignal.blocks(finalSignal.status);
          /* The oracle measured again on the delivered bytes: its score describes what is on disk now. */
          valueScore = finalSignal.valueScore ?? valueScore;
          mutantCount = finalSignal.mutantCount ?? mutantCount;
          killedCount = finalSignal.killedCount ?? killedCount;
          valueStale = false;
          acceptedRegenAfterMeasure = false;
        }
      } else if (cfg.coveragePolicyMode === "signal") {
        coverageStale = true;
        /* A measured value score is reused for the record and marked stale; it never blocks. */
        if (valueScore !== null) {
          valueStale = true;
          try {
            this.telemetry.counter("qayaba.value.stale")(1, { "qayaba.app": input.app });
          } catch (err) {
            console.error(`[telemetry] the stale-value counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          this.telemetry.counter("qayaba.coverage.stale")(1, { "qayaba.app": input.app });
        } catch (err) {
          console.error(`[telemetry] the stale-coverage counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    /*
     * The bytes on disk are the proof. Before the run decides, fingerprint the delivered specs once more and put back the proven
     * bytes of any file that changed after its acceptance; a file with no proof, or a restore that does not verify, ends the run
     * as a loud infra-error. No proof means no publication (fails closed).
     */
    if (run.verdict === "pass" && generating && input.mode !== "context" && !cfg.isCode) {
      const deliveredFiles = [...new Set(generation.delivered.map((d) => d.file))].filter((file) => file.endsWith(".spec.ts"));
      if (deliveredFiles.length > 0) {
        let current: ReadonlyMap<string, string> = new Map();
        if (this.deps.suiteStore) {
          try {
            current = await this.deps.suiteStore.fingerprint(specRoot, deliveredFiles);
          } catch (err) {
            return await this.infraErrorResult(
              `the final proof guard could not fingerprint the delivered specs: ${err instanceof Error ? err.message : String(err)}`,
              workspace.mirrorDir,
            );
          }
        }
        for (const file of deliveredFiles) {
          const proof = proofLedger.get(file);
          if (proof && current.get(file) === proof.sha256) continue;
          if (!proof) {
            return await this.infraErrorResult(
              `the final proof guard found no proof for ${file}: the run cannot publish bytes that never executed green`,
              workspace.mirrorDir,
            );
          }
          if (proof.bytes === undefined) {
            return await this.infraErrorResult(
              `the final proof guard found ${file} changed after it executed green, but holds no proven bytes to restore`,
              workspace.mirrorDir,
            );
          }
          try {
            await snapshotPort.restore(workspace.specDir, { files: new Map([[file, proof.bytes]]) }, []);
          } catch (err) {
            return await this.infraErrorResult(
              `the final proof guard could not restore ${file}: ${err instanceof Error ? err.message : String(err)}`,
              workspace.mirrorDir,
            );
          }
          if (!this.deps.suiteStore) {
            return await this.infraErrorResult(
              `the final proof guard cannot verify the restored ${file}: no suite store is composed`,
              workspace.mirrorDir,
            );
          }
          let restored: ReadonlyMap<string, string>;
          try {
            restored = await this.deps.suiteStore.fingerprint(specRoot, [file]);
          } catch (err) {
            return await this.infraErrorResult(
              `the final proof guard could not verify the restored ${file}: ${err instanceof Error ? err.message : String(err)}`,
              workspace.mirrorDir,
            );
          }
          if (restored.get(file) !== proof.sha256) {
            return await this.infraErrorResult(
              `the final proof guard restored ${file} but its bytes still differ from the proven ones`,
              workspace.mirrorDir,
            );
          }
        }
      }
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
          /* The ledger's own hashes: every file admitted is one whose green bytes this run holds. */
          executedGreen: new Map([...proofLedger].map(([file, proof]) => [file, proof.sha256])),
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
        services.confinement.add({
          strays: published.revertedDenylisted.length,
          dangerous: published.revertedDangerous?.length ?? 0,
          reverted: [...published.revertedDenylisted],
        });
      }
    }

    /* Once, after confinement and publish, so gc never races this run's git write. */
    await this.pruneMirrorIfWired(workspace.mirrorDir);

    /* Derive errorClass/valueScore once for both the persisted outcome and the returned result. */
    const gateValueScore = valueScore;
    const loopSignal = await closedLoopSignal();
    /* Thread the review loop's real final-round corrections into errorClass derivation. */
    const errorClass = this.deriveErrorClass(decision.verdict, coverageRatio, gateValueScore, finalReviewerCorrections, {
      ...(devNotRenderedConclusive ? { preconditionFailed: true } : {}),
    });
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
        ...(services.confinement.totals !== undefined ? { confinement: services.confinement.totals } : {}),
        ...(loopSignal ? { closedLoop: loopSignal } : {}),
        ...(agentBrowserSignal() ? { agentBrowser: agentBrowserSignal() } : {}),
        ...(coverageStale ? { coverage: { stale: true } } : {}),
        ...(valueStale ? { value: { stale: true } } : {}),
        ...(integrityCounters.acceptances > 0 || integrityCounters.rejected > 0 || integrityCounters.capHit
          ? { integrity: { ...integrityCounters } }
          : {}),
        ...(intentState.clauses > 0 || intentState.violations > 0
          ? {
              intent: {
                mode: intentLock.mode,
                violations: intentState.violations,
                wouldReject: intentState.wouldReject,
                clauses: intentState.clauses,
                opaque: intentState.opaque,
                opacityHigh: intentState.opacityHigh,
              },
            }
          : {}),
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
        ...(coverageStale ? { coverage: { stale: true } } : {}),
        ...(valueStale ? { value: { stale: true } } : {}),
        ...(integrityCounters.acceptances > 0 || integrityCounters.rejected > 0 || integrityCounters.capHit
          ? { integrity: { ...integrityCounters } }
          : {}),
        ...(intentState.clauses > 0 || intentState.violations > 0
          ? {
              intent: {
                mode: intentLock.mode,
                violations: intentState.violations,
                wouldReject: intentState.wouldReject,
                clauses: intentState.clauses,
                opaque: intentState.opaque,
                opacityHigh: intentState.opacityHigh,
              },
            }
          : {}),
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
    ends: { generationEnd?: GenerationEndKind | undefined; preconditionFailed?: boolean | undefined; reviewerUnavailable?: boolean | undefined; reviewDisputed?: boolean | undefined } = {},
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
      ...(ends.reviewDisputed ? { reviewDisputed: true } : {}),
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
      /* The recorded coverage predates the bytes an accepted regeneration wrote (signal mode reuses it). */
      coverage?: { stale: boolean };
      /* The recorded value score has the same staleness; the oracle stays signal-only. */
      value?: { stale: boolean };
      /* What the run's regeneration acceptance did; absent when no regeneration came through it. */
      integrity?: { acceptances: number; rejected: number; proofReused: number; capHit: boolean };
      /* The test-intent lock's derived clauses and deltas; absent when the lock is off or nothing was derived. */
      intent?: { mode: string; violations: number; wouldReject: number; clauses: number; opaque: number; opacityHigh: boolean };
      /* The kind a declared no-op named; absent for every run that is not one. */
      noop?: { kind: NoopKind };
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
        ...(extra?.coverage !== undefined ? { coverage: extra.coverage } : {}),
        ...(extra?.integrity !== undefined ? { integrity: extra.integrity } : {}),
        ...(extra?.noop !== undefined ? { noop: extra.noop } : {}),        ...(this.coordinationOf.has(input) ? { coordination: this.coordinationOf.get(input)! } : {}),
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

  /*
   * The reviewer and the generator reached opposite conclusions about a finding the orchestrator verified, and the
   * generator's refusal rests on nothing the orchestrator can check. The engine cannot settle that judgment, so it says
   * so instead of publishing or opening an Issue on it: persisted infra-error under its own class, nothing learned,
   * no PR and no Issue, with the finding and the rebuttal on the record.
   */
  private async reviewDisputedResult(
    cfg: RunQaConfig,
    input: RunQaInput,
    disputed: readonly DisputedFinding[],
    passedCases: number,
    exit: Omit<TerminalOptions, "note" | "reviewDisputed"> & { static: boolean },
  ): Promise<RunQaResult> {
    const findings = disputed.map((entry) => `"${entry.finding}" (rebutted: ${entry.rebuttal.reason})`).join("; ");
    const note = `The reviewer and the generator could not settle ${disputed.length} finding(s), so the suite (${passedCases} case(s), green) was never approved: ${findings}. The rebuttal rests on evidence the orchestrator could not verify, and the generator delivered nothing else. Nothing was published: no PR, and no Issue, since the engine could not decide.`;
    console.error(`[qa] ${note}`);
    this.deps.observer?.onEvent({ type: "agent.error", detail: note });
    this.deps.observer?.onEvent({
      type: "log.line",
      level: "error",
      text: `[qa] the run ended on an unresolved review dispute (${ERROR_CLASS.REVIEW_DISPUTED}): the finding stands, the rebuttal is unverified, and neither a PR nor an Issue would be honest`,
    });
    const { static: staticOk, ...terminalExit } = exit;
    return await this.terminalResult("infra-error", cfg, input, { generating: true, static: staticOk }, {
      ...terminalExit,
      note,
      reviewDisputed: true,
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
      reviewDisputed,
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
    const errorClass = this.deriveErrorClass(verdict, null, null, [], { generationEnd, preconditionFailed, reviewerUnavailable, reviewDisputed });
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
