/*
 * Segregated ports for the QA run lifecycle. RunPipelinePort is the driving
 * seam (one RunInput → RunOutcome). Driven ports are the capabilities the run
 * composes, plus ObserverPort and RunHistoryPort. Types here stay
 * kernel-resident: no cross-context imports; generation and topology shapes
 * are structural mirrors.
 */

import type { Sha } from "@kernel/sha.ts";
import type { RunMode, TestTarget, TriggerSource } from "@kernel/run-mode.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunStep } from "@kernel/run-step.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Objective } from "@kernel/objective.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunEventBody } from "@kernel/run-event.ts";

/**
 * Port-local CommitIntent. Generation's type is structurally assignable;
 * this barrel does not import across contexts.
 */
export interface CommitIntent {
  type: string;
  breaking: boolean;
  /** First line — the agent uses this as intent. */
  message: string;
  /** Commit body after the subject — the richest statement of intent. */
  body?: string;
  /** The agent derives scope/area from these paths. */
  changedFiles: string[];
}

/** Port-local ArchitectureContext. Same no-cross-context-import rule as CommitIntent. */
export interface ArchitectureContext {
  builtAtSha: string;
  routes: Array<{ path: string; name?: string; component?: string; source?: string }>;
  api: Array<{ operationId: string; method: string; path: string; service?: string; spec?: string }>;
  feBe: Array<{ route: string; operationId: string; via?: string }>;
  flows?: Array<{ id: string; routes: string[]; operations?: string[] }>;
}

/** Port-local ExplorationBrief. Extra optional fields on the generation type remain assignable. */
export interface ExplorationBrief {
  builtForSha: string;
  objective: string;
  blastRadius: Array<{ symbol: string; file: string; role: string }>;
  feBe?: Array<{ route: string; operationId: string; via?: string }>;
  contracts?: Array<{ operationId: string; method: string; path: string; fields?: string[]; errors?: string[] }>;
  routes?: Array<{ path: string; component?: string; domLandmarks?: string[]; verified: boolean }>;
  risks?: string[];
  notes?: string;
}

/** Single input → RunOutcome. Production implementation is RewrittenOrchestratorAdapter. */
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
}
export interface RunPipelinePort {
  /**
   * `signal` is a separate transport argument, not a RunInput field: queue
   * cancellation is orthogonal to which run is requested. A cancelled run must
   * stop rather than resolve late and overwrite a finalized record.
   */
  run(input: RunInput, signal?: AbortSignal): Promise<RunOutcome>;
}

export interface ChangeAnalysisPort {
  /**
   * Only "diff" mode calls classify. Returns the real per-run diff so generation
   * is not fed a stale static value. `intent` and `contradiction` are optional:
   * contradiction is set only when the message claimed no behavior change but
   * the diff escalated the action — never fabricated. `opts.baseSha` requests a
   * range classification; absent classifies sha^..sha.
   */
  classify(sha: Sha, opts?: { baseSha?: Sha }): Promise<{ action: "skip" | "regression" | "generate"; reason: string; diff: string; intent?: CommitIntent; contradiction?: boolean }>;
}
/** Optional trailing bag on generate(). Every field is independently absent-safe. */
export interface GenerationEnrichment {
  /** Reviewer rejection corrections — highest priority on a regen prompt. */
  reviewCorrections?: string[];
  /** Fix-loop retry context so a regen sees failing cases instead of a bare re-prompt. */
  fixCases?: readonly QaCase[];
  selectorContradictions?: readonly string[];
  domSnapshot?: string;
  /** Changed lines a green run failed to exercise (enforce-mode coverage regen). */
  coverageGap?: string;
  /** Diff-mode CommitIntent from classify(). */
  intent?: CommitIntent;
  /**
   * Classifier's explanation of its decision (why the action is what it is).
   * Distinct from `intent` (what changed). Absent outside diff mode.
   */
  classificationReason?: string;
  /**
   * True when the message claimed no behavior change but the diff escalated.
   * Hint to trust the diff. Undefined when classify did not escalate.
   */
  contradiction?: boolean;
  /**
   * Run SHA for ManifestEntry.changeRef.sha (required non-empty). Available on
   * every run regardless of mode; callers should thread input.sha on every generate().
   */
  sha?: string;
  /** Per-run id for the generator SSE session descriptor. */
  runId?: string;
  /**
   * Structured rules from LearningPort.retrieve. The adapter renders them;
   * absent/empty leaves the prompt unchanged.
   */
  learnedRules?: readonly RetrievedRule[];
  /**
   * First-write context pack, built once before the initial generate() and reused
   * unchanged on every regeneration in the same run. Absent falls back to live-MCP
   * exploration — never fabricated.
   */
  contextPack?: string;
  /**
   * Structured map from specDir/.qa/context.json. Distinct from contextPack
   * (assembled markdown). Absent when the json is missing/invalid (fail-open).
   */
  contextMap?: ArchitectureContext;
  /**
   * Distilled explorer brief. Distinct from contextPack. Absent when explorer is
   * unwired or fail-open.
   */
  contextBrief?: ExplorationBrief;
  /**
   * On-disk spec paths enumerated before the first generate(), so the agent reuses
   * instead of duplicating.
   */
  existingSpecFiles?: string[];
  /**
   * Advisory structural blast-radius markdown. Reaches the generation prompt only —
   * no verdict, gate, or coverage path reads it. Absent omits the section.
   */
  staticSignal?: string;
  /**
   * Curriculum-ranked authoring templates. Absent lets the prompt builder fall
   * back to its local derivation.
   */
  skillExemplars?: readonly SelectedExemplar[];
  /**
   * Structured FE→BE links. Rendering belongs at the prompt boundary, not here.
   * Absent means no key (not an empty array). Advisory only.
   */
  serviceLinks?: readonly ServiceLink[];
  /**
   * FE↔BE contract drift, independently optional from serviceLinks (a run can
   * have links without drift, or the reverse).
   */
  contractDrift?: readonly ContractDrift[];
  /**
   * Advisory cross-repo impact narrowing. Structured, not pre-rendered. Absent
   * means no key. Advisory only.
   */
  crossRepoImpact?: { impactedLinks: readonly ImpactedLink[] };
}
export interface GenerationPort {
  /**
   * `signal` interrupts in-flight generation on cancel. `diff` is the real
   * per-run commit diff (diff mode only); absent falls back to the adapter's
   * static per-run value. `enrichment` is independently absent-safe.
   * `specSources` is just-generated spec text for selector checks; absent/empty
   * is never fabricated. `specMetas` is the flow/objective projection for
   * publication; absent/empty omits the "tested" section.
   * `parsed` is false only when no verdict JSON could be parsed.
   */
  generate(objectives: readonly Objective[], specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<{ specs: string[]; approved: boolean; note?: string; specSources?: string[]; parsed?: boolean; specMetas?: { flow?: string; objective?: string }[] }>;
}
/**
 * `priorCorrections` lets the next review judge convergence on previously
 * raised blocking issues instead of inventing new nits.
 */
export interface ReviewEnrichment {
  priorCorrections?: readonly string[];
  /** When no manual guidance exists, the reviewer's objective is the commit intent message. */
  intent?: CommitIntent;
  /**
   * Same retrieved rules the generator saw. The adapter renders only active
   * rules; candidates are for the generator to explore, never for the judge to
   * gate on.
   */
  learnedRules?: readonly RetrievedRule[];
  /**
   * Live DEV a11y snapshot of routes under review. Absent: the reviewer defers
   * on unverifiable UI facts.
   */
  domSnapshot?: string;
  /** Per-run id for the reviewer SSE session (separate from the generator's). */
  runId?: string;
}
/**
 * Adapter catch produces `${REVIEWER_UNAVAILABLE_MARKER}: <reason>`; the
 * use-case matches on it. One constant so producer and matcher cannot drift.
 */
export const REVIEWER_UNAVAILABLE_MARKER = "reviewer unavailable";

/**
 * Authoritative publish-gate seam. `blockingCount` distinguishes blocking
 * corrections from advisory ones. `parsed` is false only on a parse miss — not
 * a real rejection — so FixLoop re-prompts once instead of burning a fix round.
 * Fail-closed: a missing parse is never treated as approval.
 */
export interface ReviewPort {
  /**
   * `diff` is the real per-run commit diff; absent falls back to the adapter's
   * static ctx.diff. `enrichment` is independently absent-safe.
   */
  review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): Promise<{
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
  }>;
}
export interface ValidationPort {
  /**
   * `changedFiles` scopes the code-target compile gate. Ignored by the e2e
   * static gate. Present so the same call site can pass it for either target.
   * `infra` is optional: a validation failure may be infrastructure, not a code defect.
   */
  validate(specDir: string, changedFiles?: string[]): Promise<{ ok: boolean; errors: string[]; infra?: boolean }>;
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
  execute(specDir: string, opts?: AbortSignal | ExecutionOpts): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string }>;
}
export interface ObjectiveSignalPort {
  /**
   * `valueScore` absent means not measured — never a fabricated 0.
   * `diff` absent (non-diff modes) → assembler never invoked → decide() gets
   * null → "unknown" → never blocks.
   * `baselineCases` are this run's passing case names; absent falls back to the
   * static composition-time list.
   * `uncovered` is populated only when a ChangeCoverage was actually assembled;
   * never fabricated as [].
   * `opts.namespace` overrides the dump namespace for the regen's second
   * measure(); the first measurement is untouched.
   */
  measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; uncovered?: { file: string; lines: number[] }[] }>;
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
/**
 * Port-boundary projection of a retrieved learning rule. `status` is only
 * "active" | "candidate" because deprecated/superseded rules are never retrieved.
 */
export interface RetrievedRule {
  /**
   * Ledger primary key for outcome-fold attribution. Never rendered into a
   * prompt. `trigger` is the prompt-facing text and must never be used for fold
   * attribution.
   */
  id: string;
  trigger: string;
  action: string;
  errorClass: string;
  status: "active" | "candidate";
  confidence: "low" | "medium" | "high";
}
export interface LearningPort {
  /** Off-path: a failure is logged and swallowed, never gates publish. */
  fold(outcome: RunOutcome): Promise<void>;
  retrieve(sha: Sha): Promise<RetrievedRule[]>;
}
/** Cross-cutting infra port, kernel-resident so neither context imports it from the other. */
export type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
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

/**
 * Post-generate capture of on-disk spec text plus live route trees.
 * Re-reads specs on every call so a re-check after regen sees rewritten specs.
 * RouteTree is duck-typed locally (no cross-context import). Absent: the
 * pre-exec gate is skipped and related gateSignals stay the number 0, not
 * undefined. Adapter must not throw.
 */
export interface PreExecGroundingPort {
  capture(specDir: string, signal?: AbortSignal): Promise<{
    specSources: string[];
    routes: {
      route: string;
      nodes: string[];
      status?: "captured" | "degraded";
      settled?: boolean;
      testIds?: Map<string, number>;
    }[];
  }>;
}

export interface GroundingResult {
  /** Assembled context-pack text. Absent when the pack build failed or produced nothing. */
  contextPack?: string;
  /**
   * On-disk spec paths enumerated before the first generate(). Absent/empty when
   * the e2e dir does not exist yet or enumeration failed (fail-open).
   */
  existingSpecFiles?: string[];
  /** ArchitectureContext from specDir/.qa/context.json. Absent when missing/invalid (fail-open). */
  contextMap?: ArchitectureContext;
  /** Distilled explorer brief. Absent when explorer is unwired, throws, or returns nothing (fail-open). */
  contextBrief?: ExplorationBrief;
}
/**
 * Pre-generate first-write grounding (DOM/route/context pack), run once after
 * setup and before the initial generate(). Distinct from PreExecGroundingPort
 * (post-generate corrective gate) and ReviewDomGroundingPort (review-time
 * snapshot keyed on generated specs). Absent: generation falls back to live-MCP
 * exploration. Adapter must never throw — capture/build failure degrades to an
 * absent field (fail-open).
 */
export interface PreGenerationGroundingPort {
  /**
   * Optional `diff` (diff mode only) for deterministic [CHANGED] markers.
   * Absent is unchanged.
   */
  ground(
    specDir: string,
    signal?: AbortSignal,
    diff?: string,
    opts?: { sha?: string; intent?: CommitIntent },
  ): Promise<GroundingResult>;
}

/**
 * Reviewer's live-DEV DOM snapshot, keyed on just-generated specs' routes.
 * Caller re-invokes per round so a regenerated set is re-captured. Absent:
 * reviewer defers on unverifiable UI facts. Adapter must never throw.
 */
export interface ReviewDomGroundingPort {
  capture(specDir: string, specs: readonly string[], signal?: AbortSignal): Promise<string | undefined>;
}

/**
 * Advisory blast-radius markdown for GenerationEnrichment.staticSignal.
 * Absent: no staticSignal. Throw is fail-open at the caller. Unavailable
 * query degrades to "" — never a fabricated claim.
 */
export interface StructuralSignalPort {
  render(repoDir: string, changed: BlastRadius): Promise<string>;
}

/** Port-local structural mirrors of service-topology types (no cross-context import). */
export interface ServiceSymbolRef {
  repo: string;
  file: string;
  symbol: string;
}
export interface ServiceLink {
  from: ServiceSymbolRef;
  to: ServiceSymbolRef;
  transport: "http" | "event" | "rpc";
  contractRef?: string;
  confidence: number;
  source: string;
}
export interface ContractDrift {
  from: ServiceSymbolRef;
  verb: string;
  path: string;
}

/**
 * Advisory cross-repo links. resolve() is no-arg: links are app-static per SHA.
 * Absent: no serviceLinks. Never throws: any error degrades to { links: [], drift: [] }.
 * Advisory only — never a verdict/gate/coverage input.
 */
export interface ServiceLinksPort {
  resolve(): Promise<{ links: ServiceLink[]; drift: ContractDrift[] }>;
}

/** "contract-file" is deterministic; "impacted-symbol" is a name-match heuristic. */
export type MatchTier = "contract-file" | "impacted-symbol";
export interface ImpactedLink {
  /** This barrel's ServiceLink, not service-topology's. */
  link: ServiceLink;
  tier: MatchTier;
}
export interface CrossRepoImpact {
  impactedLinks: ImpactedLink[];
  /** Deferred; never populated in v1. */
  serviceImpacted?: ServiceSymbolRef[];
}
/**
 * Advisory impacted-link narrowing. Fires only on cross-repo runs
 * (triggerRepo present and a resolved link targets it). Never throws: failure
 * degrades to null and whole-link rendering falls back.
 */
export interface CrossRepoImpactPort {
  resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[]): Promise<CrossRepoImpact | null>;
}

/**
 * Count cap (not byte cap), enforced by the caller so a prompt-section drop
 * cannot silently make `evaluated` counters lie. If the exhaustive subset
 * proof breaks, lower this constant; do not raise the prompt maxBytes.
 */
export const MAX_SELECTED_EXEMPLARS = 3;

export interface SelectedExemplar {
  id: string;
  name: string;
  template: string;
  /** Wide string, not ScenarioArchetype: the narrow union adds nothing a caller can act on here. */
  archetype: string;
  /** Caught a real bug for this app — drives the prompt's PROVEN marker. */
  proven: boolean;
  promotionCount: number;
}

export interface CurriculumFoldInput {
  /** Archetypes actually rendered into this run's generation prompt — never the wider matched set. */
  offered: readonly string[];
  verdict: RunVerdict;
  /** RunOutcome.adjudication?.class (wide string, kernel convention). */
  adjudicationClass?: string;
  /** Absent is unmeasured, which classifyEvidence reads as inconclusive. */
  coverageStatus?: "pass" | "fail" | "unknown";
}

/**
 * Per-app scenario-archetype prior. Optional and off-path: absent is today's
 * run; a curriculum fault never gates a verdict or publish. Selection lives
 * behind the port so "what we offered" cannot drift from "what we folded".
 */
export interface CurriculumPort {
  /**
   * Absent diff (non-diff modes) → []: no patterns, nothing offered, nothing folded.
   * Data-driven, not a mode branch.
   */
  select(diff: string | undefined, changedFiles: readonly string[]): Promise<readonly SelectedExemplar[]>;
  fold(input: CurriculumFoldInput): Promise<void>;
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

