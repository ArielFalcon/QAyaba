/*
 * The shapes a run is started with, runs on and reports: its input, config, ports, trail and result. They live apart from the
 * use case so the run flow's modules can name them without importing the use case that drives them.
 */

import type { AgentProvider } from "@kernel/agent-role.ts";
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunMode, RunPurpose, TestTarget, TriggerSource } from "@kernel/run-mode.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import type { CoordinationSettings } from "@kernel/coordination.ts";
import type { CoordinatedPass, LeadSidekicks } from "@contexts/coordination/application/index.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ExecScopePort } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import type { AuthSessionContext, AuthSessionPort } from "@contexts/app-catalog/application/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { ChangeAnalysisPort, StructuralSignalPort } from "@contexts/change-analysis/application/index.ts";
import type { GenerationPort, ReviewPort, PreExecGroundingPort, PreGenerationGroundingPort, ReviewDomGroundingPort, ContextMapCapturePort } from "@contexts/generation/application/index.ts";
import type { ValidationPort, ExecutionPort } from "@contexts/test-execution/application/index.ts";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/index.ts";
import type { PublicationPort } from "../ports/publication.port.ts";
import type { LearningPort, CurriculumPort } from "@contexts/cross-run-learning/application/index.ts";
import type { WorkspacePort } from "../ports/workspace.port.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
import type { RunHistoryPort } from "../ports/run-history.port.ts";
import type { SetupPort } from "../ports/setup.port.ts";
import type { CleanupPort } from "../ports/cleanup.port.ts";
import type { ObserverPort } from "../ports/observer.port.ts";
import type { ServiceLinksPort, CrossRepoImpactPort } from "@contexts/service-topology/application/index.ts";
import type { ConfinementPort } from "../ports/confinement.port.ts";
import type { ClosedLoopHandle, ClosedLoopPort, AgentBrowserHandle, AgentBrowserPort, CodeGraphToolsHandle, CodeGraphToolsPort, GeolocationHandle, GeolocationPort } from "@contexts/agent-tools/application/index.ts";
import type { MirrorGcPort } from "../ports/mirror-gc.port.ts";
import type { SuiteStorePort } from "@kernel/ports/suite-store.port.ts";
import type { RunDeadlinePort } from "../ports/run-deadline.port.ts";
import type { RunDecision } from "../../domain/run-decision.ts";
import type { RunPhaseCursor, PhaseClock } from "../../domain/run-phase-cursor.ts";
import type { PhaseSpans } from "../run-phase-spans.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { PreconditionKind } from "@contexts/app-catalog/application/index.ts";
import type { CoordinationTelemetryPort } from "@contexts/coordination/application/index.ts";
import type { IntentContractPort } from "../ports/intent-contract.port.ts";
import type { ReflectorPort, ProcessAuditPort } from "@contexts/cross-run-learning/application/index.ts";

/** A login the run could not complete: the kind, a note already scrubbed of credentials, and the attempt's duration. */
export interface PreconditionFailure {
  kind: PreconditionKind;
  note: string;
  ms: number;
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
  /** Whether the reviewer runs the generator's own model; computed by the shell from the runtime assignment and only recorded on the run. */
  reviewerIndependence?: "shared-model" | "distinct-model";
}

export interface RunQaUseCaseDeps {
  /** Absent: the system clock. Times each phase of a run (tests inject a fake). */
  phaseClock?: PhaseClock;
  /** Absent: nothing is traced. Present: each phase of the run is a span under the run's active context (run-phase-spans.ts). Never changes a verdict. */
  telemetry?: TelemetryPort;
  /** Absent: nothing is observed. Present: told the run's state, by reference, after every step the runner passes over, runs or ends on (the record a checkpoint is made from). It must not change the state. */
  stateObserver?: (state: Readonly<object>, step: { readonly id: string; readonly outcome: string }) => void;
  /** Absent: no checkpoint is made. Present: handed the run's checkpoint (a `RunCheckpoint`: state, workspace digest, step id) after every step the runner passes over, runs or ends on. Nothing in production sets it; it neither stores nor resumes anything. */
  onCheckpoint?: (checkpoint: Readonly<object>) => void;
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
   * Absent → index the run's mirror root.
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
  sidekickProvider?: () => AgentProvider | undefined;
  /** The runtime the lead plans on now: only one that can deny the write tools per prompt may hold the planning turn to read-only. Absent: the host cannot say, and the lead authors alone. */
  plannerProvider?: () => AgentProvider | undefined;
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

/* What the run holds that is not data: its phase cursor, the spans the cursor opens and the handles its authoring runs through. */
export interface RunTrail {
  /** The run's phase cursor, created before anything runs. */
  phases: RunPhaseCursor;
  /** The spans of the phases the cursor opens. */
  spans: PhaseSpans;
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
