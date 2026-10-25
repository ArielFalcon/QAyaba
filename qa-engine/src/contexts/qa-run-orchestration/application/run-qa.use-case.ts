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
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { type RunMode, type RunPurpose, type TestTarget, type TriggerSource } from "@kernel/run-mode.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import { type NoopKind } from "@kernel/noop-kind.ts";
import { type CoordinationGateSignal, type CoordinationSettings } from "@kernel/coordination.ts";
import type { CoordinatedPass, LeadSidekicks } from "./coordination/lead-sidekicks.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../shared-infrastructure/run-secret-redaction.ts";
import { isSandboxUnavailable, type SandboxUnavailableError } from "../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { activeExecScope, refusedScope, sandboxRefused, sandboxSignal, withExecScope, type ExecScopePort } from "../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import type { AuthSession, AuthSessionContext, AuthSessionPort } from "./ports/auth-session.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";
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
  CodeGraphToolsHandle,
  CodeGraphToolsPort,
  GeolocationHandle,
  GeolocationPort,
  MirrorGcPort,
  CurriculumPort,
  ContextMapCapturePort,
  SuiteStorePort,
} from "./ports/index.ts";
import type { RunDeadlinePort } from "./ports/index.ts";

const NO_GROUNDING_SIGNALS = { preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 };

/** What a terminal exit knows beyond its verdict; each field is absent unless that exit genuinely has it — never fabricated. */
export interface TerminalOptions {
  /** Present only when a reviewer ran; see `reviewerApprovalOf` in the ports. */
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
import { decide } from "../domain/run-decision.service.ts";
import { RunDecision } from "../domain/run-decision.ts";
import { RunPhaseCursor, recordPhaseSnapshot, type PhaseClock, type RunPhase } from "../domain/run-phase-cursor.ts";
import { PhaseSpans } from "./run-phase-spans.ts";
import { runFlow } from "./run-flow/run-flow.ts";
import { initialRunState } from "./run-flow/run-state.ts";
import { createRunServices } from "./run-flow/run-services.ts";
import type { RunContext, RunEnds, WorkspaceRunContext } from "./run-flow/run-context.ts";
import { BEFORE_WORKSPACE, IN_WORKSPACE } from "./run-flow/run-steps.ts";
import { ProbeSweepError } from "./run-flow/phases/generation-services.ts";
import { DEMOTE_REASON } from "@kernel/ports/suite-store.port.ts";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { RedactionScope } from "@kernel/telemetry/telemetry.port.ts";
import { attachTraceFacts, type RunTraceFacts } from "@kernel/run-trace-facts.ts";
import { generationRunsReviewer } from "@contexts/generation/domain/generation-review.ts";
import { ERROR_CLASS, resolveErrorClass } from "../domain/helpers/error-class.ts";
import { AuthPreconditionError, type PreconditionKind } from "../domain/auth-precondition.ts";
import { learningGates, observesOperatingSignal } from "../domain/helpers/learning-gates.ts";
import { CycleBudget } from "../domain/cycle-budget.ts";
import { WallClockBudget } from "../domain/wall-clock-budget.ts";
import type { CoordinationTelemetryPort } from "./coordination/coordination-telemetry.ts";
import type { DisputedFinding } from "../domain/review-rebuttals.service.ts";
import type { IntentContractPort } from "./ports/intent-contract.port.ts";
import type { ReflectorPort, ReflectionInput, ProcessAuditPort } from "@contexts/cross-run-learning/application/ports/index.ts";
import { rethrowIfUntrusted } from "../../../shared-kernel/domain-error.ts";
import { isRunDeadlineError, type RunDeadlineExceededError } from "../../../shared-kernel/run-deadline.ts";
import { renderRunDeadlineNote } from "../domain/run-time-budget.ts";

/* Same minRatio the coverage policy uses for the E-COVERAGE-GAP band. */
const DEFAULT_MIN_COVERAGE_RATIO = 0.7;

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
   * The lead's read-only code-graph tools: search the run's own project, trace a symbol's callers and callees, read a symbol's
   * source. Opened for the same runs the browser is, after the graph was synced, and closed when the run ends, however it ends.
   * Absent, or resolving undefined (the app is not in the graph): the lead reads the code with its file tools alone. A fault
   * opening it costs the run only the tools, said aloud. It decides nothing.
   */
  codeGraphTools?: CodeGraphToolsPort;
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
  /** The code graph the index phase builds and the graph signals read. Absent: no repo is indexed and every graph signal is empty. Fail-open: an index that fails never ends the run. */
  codeGraph?: CodeGraphPort;
  /**
   * Classify-source repo root (SERVICE mirror on a webhook, PRIMARY otherwise).
   * Absent → index workspace.mirrorDir.
   */
  codeGraphRepoDir?: string;
  /** On a service-triggered run, the primary repo, indexed too at the commit it is checked out at. */
  codeGraphPrimary?: { repoDir: string; headSha(): Promise<string | null> };
  /** Absent: a coordinated run writes nothing to the ledger of decisions. */
  coordinationTelemetry?: CoordinationTelemetryPort;
  /**
   * App DEV base URL for the sidekicks' grounding (artifact-threaded, not env). Reuse over re-exploration.
   */
  sidekickDevBaseUrl?: string;
  /**
   * The limits of this app's lead/sidekick coordination. Absent: the defaults.
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
  /** The lead's code-graph tools, once granted: revoked by runInScope however the run ends. */
  codeGraphTools?: CodeGraphToolsHandle;
  /** The authoring location, once opened: closed by runInScope however the run ends. */
  geolocation?: GeolocationHandle;
  /** The coordinated pass kept open for the reviewer's corrections: released by runInScope however the run ends. */
  coordinatedPass?: CoordinatedPass;
}

/*
 * What a persisted outcome may carry beyond the decision. reviewerApproved, valueScore and rulesRetrieved are optional: early exits
 * never reached those phases and must not fabricate them. Pre-exec counters default to 0 (not undefined) when the gate never ran.
 */
export interface OutcomeExtras {
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
  branchCoverage?: RunOutcome["gateSignals"]["branchCoverage"];
  bundleMutation?: RunOutcome["gateSignals"]["bundleMutation"];
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
      await this.closeCoordinatedPass(trail);
      await this.closeClosedLoop(trail);
      await this.closeAgentBrowser(trail);
      this.closeCodeGraphTools(trail);
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

  /* What the lead routed of the reviewer's corrections, recorded with the run's coordination. */
  private recordCorrections(input: RunQaInput, trail: RunTrail): void {
    const corrections = trail.coordinatedPass?.tally();
    const coordination = this.coordinationOf.get(input);
    if (coordination && corrections && corrections.turns > 0) this.coordinationOf.set(input, { ...coordination, corrections });
  }

  /* Releases the coordinated pass: the lead's session and every flow's session, workspace, loop and location. A fault is said and never changes how the run ended. */
  private async closeCoordinatedPass(trail: RunTrail): Promise<void> {
    const pass = trail.coordinatedPass;
    if (!pass) return;
    trail.coordinatedPass = undefined;
    await pass.release().catch((err: unknown) => console.error(`[qa] releasing the coordinated pass failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`));
  }

  /* Revokes the lead's code-graph tools and says what the run made of them. A fault is said and never changes how the run ended. */
  private closeCodeGraphTools(trail: RunTrail): void {
    const tools = trail.codeGraphTools;
    if (!tools) return;
    trail.codeGraphTools = undefined;
    try {
      const used = tools.signals();
      tools.close();
      console.log(`[qa] code-graph tools: ${used.calls} call(s), ${used.refused} refused, ${used.failed} the graph could not answer`);
    } catch (err) {
      console.error(`[qa] closing the code-graph tools failed (the run's result stands): ${err instanceof Error ? err.message : String(err)}`);
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
      recordCorrections: () => this.recordCorrections(input, trail),
      closeCoordinatedPass: () => this.closeCoordinatedPass(trail),
      noteGroundingGates: (result) => this.noteGroundingGates(trail, result),
      pruneMirror: (mirrorDir) => this.pruneMirrorIfWired(mirrorDir),
      noteDeadlineArmed: () => this.noteDeadlineArmed(trail),
      prepareAuth: (specDir, phase, abortSignal) => this.prepareAuth(specDir, phase, abortSignal),
      replaceRestoredLogin: (workspace, abortSignal) => this.replaceRestoredLogin(workspace, abortSignal),
      announceSuite: (text, level) => this.announceSuite(text, level),
      announcePrecondition: (failure, ends) => this.announcePrecondition(failure, ends),
      preconditionNote: (failure) => this.preconditionNote(failure),
      terminal: (verdict, ev, opts) => this.terminalResult(verdict, cfg, input, ev, opts),
      coordination: () => this.coordinationOf.get(input),
      deriveErrorClass: (verdict, coverageRatio, valueScore, reviewerCorrections, endings) => this.deriveErrorClass(verdict, coverageRatio, valueScore, reviewerCorrections, endings),
      toRunOutcome: (decision, cases, retries, coverageRatio, errorClass, extra) => this.toRunOutcome(input, decision, cases, retries, coverageRatio, errorClass, extra),
      toReflectionInput: (outcome, archetype) => this.toReflectionInput(outcome, archetype),
      reviewerUnavailable: (reason, passedCases, exit) => this.reviewerUnavailableResult(cfg, input, reason, passedCases, exit),
      reviewDisputed: (disputed, passedCases, exit) => this.reviewDisputedResult(cfg, input, disputed, passedCases, exit),
    };
    const baseCtx: RunContext = { input, signal, trail, deps: this.deps, telemetry: this.telemetry, cfg, startedAt, cycleBudget, wallClockBudget, ends };
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

    /* The table's last step ends the run, so a walk that finishes without an end is a defect in the table. */
    throw new Error("the run's steps ended without a result");
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
    extra?: OutcomeExtras,
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
        ...(extra?.branchCoverage ? { branchCoverage: extra.branchCoverage } : {}),
        ...(extra?.bundleMutation ? { bundleMutation: extra.bundleMutation } : {}),
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
        ...(extra?.value !== undefined ? { value: extra.value } : {}),
        ...(extra?.integrity !== undefined ? { integrity: extra.integrity } : {}),
        ...(extra?.intent !== undefined ? { intent: extra.intent } : {}),
        ...(extra?.noop !== undefined ? { noop: extra.noop } : {}),
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
