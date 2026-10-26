/*
 * Segregated ports for the QA run lifecycle. RunPipelinePort is the driving
 * seam (one RunInput → RunOutcome). Driven ports are the capabilities the run
 * composes, plus ObserverPort and RunHistoryPort. Types here stay
 * kernel-resident; the ports each context serves are declared by that context
 * and re-exported here.
 */

import type { Sha } from "@kernel/sha.ts";
import type { RunMode, RunPurpose, TestTarget, TriggerSource } from "@kernel/run-mode.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunStep } from "@kernel/run-step.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ChangePageBasis, ChangePagesJoin } from "@kernel/change-pages.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunEventBody } from "@kernel/run-event.ts";
import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";
import type { AgentBrowserGateSignal, AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeoLocation, GeolocationFacts } from "@kernel/geolocation.ts";
import type { CommitIntent } from "@kernel/commit-intent.ts";

/** Single input → RunOutcome. Production implementation is RunPipelineAdapter. */
export interface RunInput {
  app: string;
  sha: Sha;
  source: TriggerSource;
  mode: RunMode;
  target: TestTarget;
  guidance?: string;
  runId: string;
  /**
   * Set when a SERVICE-repo webhook triggered this run. Browser coverage cannot
   * map that repo's changed lines, so change-coverage stays "unknown" (unknown
   * never blocks publish). Absent is an ordinary same-repo run.
   */
  triggerRepo?: string;
  /**
   * Prior interrupted run's test-data namespace. Cleanup runs only when this is
   * set (prior run was still running/enqueued, or ended infra-error).
   */
  previousNamespace?: string;
  /**
   * When set, classification spans baseSha..sha (a PR/push range). Absent is
   * single-commit classification (sha^..sha).
   */
  baseSha?: Sha;
  /**
   * Continuation provenance from the /continue API only. Absent is never
   * fabricated. Intra-run regenerations reuse this same input object.
   */
  parentRunId?: string;
  /** Why the run was started, when it is not a change to test (see RUN_PURPOSE). Recorded on the persisted note; never read by a verdict. */
  purpose?: RunPurpose;
  /** The run's own choice about the run_spec loop (an A/B arm), overriding the app's setting. Absent: the app's setting decides. */
  closedLoop?: boolean;
  /** The run's own choice about the authenticated agent browser (an A/B arm), overriding the app's setting. Absent: the app's setting decides. */
  agentBrowser?: boolean;
}
export interface RunPipelinePort {
  /**
   * `signal` is a separate transport argument, not a RunInput field: queue
   * cancellation is orthogonal to which run is requested. A cancelled run must
   * stop rather than resolve late and overwrite a finalized record.
   */
  run(input: RunInput, signal?: AbortSignal): Promise<RunOutcome>;
}
/**
 * Starts the run-level wall-clock deadline that holds every agent turn of the run. Armed once, after
 * classification, because a diff run's budget follows the size of its change. Until it is armed nothing
 * bounds the run; once it is, a turn the deadline refuses or stops ends the run as a persisted
 * infra-error (E-TIME-BUDGET).
 */
export interface RunDeadlinePort {
  arm(scope: { mode: RunMode; diff?: string; changedFiles?: readonly string[] }): void;
  /** What was armed (the named budget and its length), for the run's trace. Absent or undefined: nothing to say. */
  describe?(): { label: string; budgetMs: number } | undefined;
  /** Milliseconds left; undefined while no deadline is armed. Zero or less: spent. A deterministic phase that may still start is checked against it before it does. */
  remainingMs?(): number | undefined;
  /** Milliseconds a purpose may still spend (never more than `remainingMs()`); null while no deadline is armed. The one reading the run's time decisions share. */
  allowance?(purpose: "first-pass" | "regeneration"): number | null;
}
/** What the run knows that a validation may report on. */
export interface ValidationRunInfo {
  /** The specs (relative to the suite directory) this run has delivered so far: written by its generator or a sidekick, as reported by them. */
  deliveredSpecs?: readonly string[];
}
export interface ValidationPort {
  /**
   * `changedFiles` scopes the code-target compile gate. Ignored by the e2e
   * static gate. Present so the same call site can pass it for either target.
   * `infra` is optional: a validation failure may be infrastructure, not a code defect.
   */
  validate(specDir: string, changedFiles?: string[], run?: ValidationRunInfo): Promise<{ ok: boolean; errors: string[]; infra?: boolean }>;
  /**
   * Applies the linter's own fixes to the delivered specs (`run.deliveredSpecs`) and returns
   * the specs it rewrote. Absent, or a target with no linter fixes: nothing is rewritten.
   */
  autofix?(specDir: string, run: ValidationRunInfo): Promise<string[]>;
}
/**
 * Optional execute bag. Also accepts a bare AbortSignal (normalized to
 * `{ signal }`): AbortSignal is a class instance; the bag is a plain object.
 */
export interface ExecutionOpts {
  signal?: AbortSignal;
  faultInject?: boolean;
  /** Scope re-execution to only the specs that failed. */
  specFiles?: string[];
  /** Attempts after a failure; 0 is a single attempt. Absent: the suite's own config decides. */
  retries?: number;
  /** A title filter, already escaped as a literal. */
  grep?: string;
  /** Have the fixtures count the writes the specs send to DEV; the total comes back as `devWrites`. */
  countWrites?: boolean;
  project?: string;
  timeoutMs?: number;
  /**
   * Live per-case progress so ObserverPort can emit test events during execution
   * instead of reconstructing them after the fact.
   */
  onCase?: (c: QaCase) => void;
  onRunning?: (title: string) => void;
  onDiscovered?: (title: string, file?: string) => void;
  /**
   * Dedicated coverage-dump namespace. Enforce-mode one-shot regen must execute
   * and re-measure under `${runId}-coverage-regen` so dumps never collide with
   * the first run. Absent falls back to the composition-time namespace.
   */
  namespace?: string;
}
export interface ExecutionPort {
  /** Bare AbortSignal or richer opts bag; absent is specDir only. */
  execute(specDir: string, opts?: AbortSignal | ExecutionOpts): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string; devWrites?: number }>;
}
/** What a change-coverage measurement counted, and why a measurement that decides nothing did not. */
export interface CoverageMeasurement {
  changedLines: number;
  coveredChanged: number;
  changedFiles: number;
  /** Changed files the executed code was mapped to. */
  mappedFiles: number;
  /** Why the measurement decides nothing: no diff, no assembler, no changed line, or no executed source mapped to a changed file, or the scripts the page ran carried no source map at all (the app serves bundles that cannot be translated back to the repository's files). Absent when it measured. */
  unmeasured?: "no-diff" | "not-assembled" | "no-changed-lines" | "no-changed-file-mapped" | "no-source-maps";
}
export interface ObjectiveSignalPort {
  /**
   * `valueScore` absent means not measured — never a fabricated 0.
   * `mutantCount`/`killedCount` mirror the value-oracle's own ValueOracleResult: absent means the
   * oracle never ran this measure() call (e.g. coverage.mode "off"); `null` means it ran but has no
   * count to report. Neither is ever fabricated as 0 — that would read as a genuine measured zero.
   * `diff` absent (non-diff modes) → assembler never invoked → decide() gets
   * null → "unknown" → never blocks.
   * `baselineCases` are this run's passing case names; absent falls back to the
   * static composition-time list.
   * `uncovered` is populated only when a ChangeCoverage was actually assembled;
   * never fabricated as [].
   * `opts.namespace` overrides the dump namespace for the regen's second
   * measure(); the first measurement is untouched.
   */
  measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; mutantCount?: number | null; killedCount?: number | null; uncovered?: { file: string; lines: number[] }[]; measurement?: CoverageMeasurement }>;
  /**
   * Single source of truth for whether a measured status blocks publish.
   * Only "enforce" + "fail" blocks; "unknown" never blocks regardless of mode.
   */
  blocks(status: "pass" | "fail" | "unknown"): boolean;
}
export interface PublicationPort {
  /**
   * Per-run values override composition-time ctx. Absent falls back to static
   * ctx. When present, a green-but-reviewer-rejected run routes to an Issue,
   * and an enforce-mode coverage failure holds the PR.
   */
  publish(decision: {
    verdict: RunVerdict;
    cases: readonly QaCase[];
    logs: string;
    reviewerApproved?: boolean;
    coverageBlocks?: boolean;
    e2eChanged?: boolean;
    /**
     * Cross-repo Issue routing. Absent falls back to ctx.repo. PR creation
     * always targets ctx.repo (the primary), regardless of this field.
     */
    issueRepo?: string;
    /**
     * FixLoop's last adjudicator verdict. Present only when FixLoop reached
     * adjudicate(); a clean first-try pass has none. Strings, not domain unions:
     * the adapter renders them as text and never branches on them.
     */
    adjudication?: { class: string; confidence: string; reason: string };
    /**
     * Threaded only for a reviewer-unavailable fail-closed exit — never for a
     * genuine rejection (corrections already signal that).
     */
    reviewerNote?: string;
    /**
     * Real per-run mirrorDir + sha for the "pr" route's git-write. Absent on an
     * actual "pr" route with a required vcsWrite collaborator is a composition
     * defect: the adapter throws rather than skip the write (fail-closed).
     */
    mirrorDir?: string;
    sha?: string;
    /** Agent "what was tested" evidence. Absent omits the section; never throws. */
    tested?: { flow?: string; objective?: string }[];
    /** Code vs e2e wording. Absent renders e2e-flavored copy. */
    isCode?: boolean;
    /** Continuation provenance. Absent: no continuation reference rendered. */
    parentRunId?: string;
  }): Promise<{
    outcome: string;
    /**
     * Tracked-file denylist reverts from the "pr" git-write, merged into
     * gateSignals.confinement. Absent on every route that never reaches "pr".
     */
    revertedDenylisted?: string[];
    /**
     * Subset of revertedDenylisted matching the secret tier. Counted toward
     * gateSignals.confinement.dangerous — not every revert is a secret leak.
     */
    revertedDangerous?: string[];
  }>;
}
/** Cross-cutting infra port, kernel-resident so neither context imports it from the other. */
export type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
/** The durable copy of an app's accepted e2e suite (see the port). */
export type { SuiteStorePort, SuiteRoot, SuiteRestoreResult, SuiteCaptureInput, SuiteCaptureResult } from "@kernel/ports/suite-store.port.ts";
export type { SpecSnapshot, SpecSnapshotPort } from "./spec-snapshot.port.ts";
export interface WorkspacePort {
  /**
   * `mirrorDir` is the working-copy root before specRelDir is joined. The "pr"
   * route needs the mirror root, not the target-aware specDir.
   */
  prepare(sha: Sha): Promise<{ specDir: string; mirrorDir: string }>;
}
/** Replaces positional run callbacks with one typed observer. */
export interface ObserverPort {
  onStep(step: RunStep, detail?: string): void;
  onEvent(body: RunEventBody): void;
}
/** Persistence seam for the completed RunOutcome. */
export interface RunHistoryPort {
  save(outcome: RunOutcome): Promise<void>;
}

/**
 * Bootstraps fixtures/deps before generation. e2e-vs-code dispatch is the
 * adapter's concern. A throw must propagate: setup failure is infra-error,
 * never a code verdict.
 */
export interface SetupPort {
  setup(specDir: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Orphan test-data cleanup for a PRIOR interrupted run. Fires only when
 * previousNamespace is set, e2e-only, before this run's generation. Failure is
 * best-effort: never alters this run's verdict. baseUrl/testIdAttribute live
 * on the adapter, not this signature.
 */
export interface CleanupPort {
  cleanup(specDir: string, opts: { namespace: string; signal?: AbortSignal }): Promise<void>;
}

export interface ConfinementResult {
  strays: number;
  dangerous: number;
  reverted: string[];
}
/**
 * Detects and reverts agent writes outside the permitted area (e2e-target:
 * only e2e/ survives; code-target: any path except the denylist) and symlinks
 * whose realpath escapes the mirror root. This is the only context permitted
 * vcs writes. Absent: no enforce, no gateSignals.confinement.
 * A thrown enforce() (including a failed revert) MUST be caught by the caller,
 * logged, and recorded best-effort in gateSignals.confinement — never alter
 * the verdict or block publish. The adapter itself does not swallow git errors.
 */
export interface ConfinementPort {
  enforce(mirrorDir: string, isCode: boolean, signal?: AbortSignal): Promise<ConfinementResult>;
}

/**
 * Compacts orphaned object packs on the mirror. Absent: no prune.
 * A thrown prune() MUST be caught by the caller, logged, and never alter the
 * verdict or block the run.
 */
export interface MirrorGcPort {
  prune(mirrorDir: string): Promise<void>;
}

/*
 * CoordinationPort is application-layer (CycleBudget / WallClockBudget live
 * there), so it is not kernel-resident and is not re-exported here.
 * See ./coordination.port.ts.
 */

/* The tool-grant ports are declared by agent-tools; the flow reads them through its public surface. */
export type { AgentBrowserHandle, AgentBrowserOpenInput, AgentBrowserPort, ClosedLoopHandle, ClosedLoopOpenInput, ClosedLoopPort, ClosedLoopSignals, CodeGraphToolsHandle, CodeGraphToolsOpenInput, CodeGraphToolsPort, FlowFailureFact, FlowGeolocationHandle, FlowLedgerEntry, FlowLoopHandle, FlowLoopOpenInput, GeolocationHandle, GeolocationOpenInput, GeolocationPort } from "@contexts/agent-tools/application/index.ts";
export type { CommitIntent } from "@kernel/commit-intent.ts";
export type { ArchitectureContext, GroundingOmission, HarnessFacts } from "@kernel/grounding.ts";
export type { LearningPort, RelevanceBias, RetrievedRule } from "@contexts/cross-run-learning/application/index.ts";
export { MAX_SELECTED_EXEMPLARS } from "@contexts/cross-run-learning/application/index.ts";
export type { CurriculumFoldInput, CurriculumPort, SelectedExemplar } from "@contexts/cross-run-learning/application/index.ts";
export type { ServiceLinksPort } from "@contexts/service-topology/application/index.ts";
export type { CrossRepoImpactPort } from "@contexts/service-topology/application/index.ts";
export type { ChangePagesPort, ChangePagesRequest } from "@contexts/service-topology/application/index.ts";
export { reviewerApprovalOf } from "@contexts/generation/application/index.ts";
export type { GenerationEnrichment, GenerationOutput, GenerationPort } from "@contexts/generation/application/index.ts";
export { REVIEWER_UNAVAILABLE_MARKER } from "@contexts/generation/application/index.ts";
export type { ReviewEnrichment, ReviewPort, ReviewStats } from "@contexts/generation/application/index.ts";
export type { PreExecGroundingPort } from "@contexts/generation/application/index.ts";
export type { GroundingChange, GroundingResult, PreGenerationGroundingPort } from "@contexts/generation/application/index.ts";
export type { ReviewDomGroundingPort } from "@contexts/generation/application/index.ts";
export type { ContextMapCapturePort } from "@contexts/generation/application/index.ts";
export type { ContractDrift, ServiceLink, ServiceSymbolRef } from "@contexts/service-topology/application/index.ts";
export type { CrossRepoImpact, ImpactedLink, MatchTier } from "@contexts/service-topology/application/index.ts";
export type { ChangeAnalysisPort } from "@contexts/change-analysis/application/index.ts";
export type { StructuralSignalPort, StructuralSignalResult } from "@contexts/change-analysis/application/index.ts";
