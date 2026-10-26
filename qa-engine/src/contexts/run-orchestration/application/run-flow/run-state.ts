/* The data a run carries from one phase to the next. Each section is written by the phase that owns it and read by the later ones; it holds no live object, so it can be recorded as it stands. */

import type { ContractDrift, CrossRepoImpact, ServiceLink } from "@kernel/service-links.ts";
import type { RetrievedRule, SelectedExemplar } from "@kernel/learned-rule.ts";
import type { ArchitectureContext, GroundingOmission, HarnessFacts } from "@kernel/grounding.ts";
import type { ChangeScope, UseCaseCandidate } from "@contexts/change-analysis/application/index.ts";
import type { CommitIntent } from "@kernel/commit-intent.ts";
import type { GenerationEnrichment, GenerationOutput } from "@contexts/generation/application/index.ts";
import type { ExecutionPort, ValidationPort } from "@contexts/test-execution/application/index.ts";
import type { RelevanceBias } from "@contexts/cross-run-learning/application/index.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { ContractFeedback } from "../../domain/contract-feedback.ts";
import type { ReviewPort } from "@contexts/generation/application/index.ts";
import type { SuiteRestorePoint } from "../../domain/suite-restore-point.ts";
import type { RegenerationAcceptance } from "../regeneration-acceptance.ts";
import type { ReviewedSpecs, ReviewTally } from "./phases/review-services.ts";
import type { DegradeReason } from "./failure-policy.ts";
import type { AdjudicatorVerdict } from "../../domain/adjudicate.service.ts";
import type { FixLoopStage } from "../../domain/fix-loop.aggregate.ts";
import type { CoordinationGateSignal } from "@kernel/coordination.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { CandidateCoverage, CandidateValue, CausalLabel, ValueStats } from "@contexts/objective-signal/application/index.ts";
import type { RunDecision } from "../../domain/run-decision.ts";
import type { RunEvidence } from "../../domain/run-decision.service.ts";
import type { EndReason } from "./end-reason.ts";

/* What the classifier said about the change. Only a diff run classifies: every other run generates and has no diff. */
export interface Classification {
  diff?: string;
  intent?: CommitIntent;
  reason?: string;
  contradiction?: boolean;
  /** False for a "regression" change, which runs the existing suite without generating. */
  generating: boolean;
  /** The other entries of a run over several repos, each classified on its own; absent for a single-entry run. `diff`, `intent` and `reason` above stay the anchor's. */
  companions?: readonly CompanionClassification[];
}

/** One non-anchor entry of the run's change, as the classifier read it. */
export interface CompanionClassification {
  repo: string;
  diff: string;
  intent?: CommitIntent;
  action: "skip" | "regression" | "generate";
  reason: string;
}

/* What the setup phase left for the later ones. */
export interface SetupOutcome {
  /** The accepted suite was restored from the suite store: a green run may capture it back. */
  suiteRestored: boolean;
  /** The login the store brought back; a login that fails to sign in is replaced by the stock seed. */
  storeRestoredLogin: boolean;
  /** The auth setup is still the seed: generation may rewrite it, and the authoring handles are not granted. */
  authSeedUnauthored: boolean;
}

/* What the ground phase gathered for the prompts and for the run's evidence. */
export interface Grounding {
  /** The diff's structural shapes; undefined outside diff mode. They bias retrieval and ride on every folded outcome. */
  diffArchetypes: string[] | undefined;
  /** The bias retrieval was asked with: the diff's specific shapes, absent when there are none. */
  retrievalRelevance: RelevanceBias | undefined;
  retrievedRules: RetrievedRule[];
  retrievedRuleIds: string[];
  selectedExemplars: readonly SelectedExemplar[];
  /** The archetypes the prompt carried, which the fold credits. */
  offeredArchetypes: string[];
  contextPack: string | undefined;
  contextPackItemIds: readonly string[] | undefined;
  contextPackOmissions: readonly GroundingOmission[] | undefined;
  existingSpecFiles: string[] | undefined;
  contextMap: ArchitectureContext | undefined;
  harnessFacts: HarnessFacts | undefined;
  /** The added labels whose changed-value line in the pack said more nodes than unchanged lines: what an unobservable no-op is set beside. */
  moreNodes: readonly string[];
  /** The pages the pack read with results under the declared data state: the witness a failure that reads them empty contradicts. */
  confirmedDataRoutes: readonly { path: string; resultCount: number }[] | undefined;
  blastRadiusSignal: string;
  blastRadiusSignalHasSymbols: boolean;
  /** The files the signal's dossier shows verbatim. */
  blastRadiusSignalFiles: readonly string[];
  serviceLinks: readonly ServiceLink[];
  contractDrift: readonly ContractDrift[];
  crossRepoImpact: CrossRepoImpact | null;
  /** The reach of the change over every repo of the run: the entry points its changed symbols reach, by tier. Absent when no scope was asked (no index, or outside diff mode). */
  changeScope: ChangeScope | undefined;
  /** The use cases the change makes testable, in the order they are offered: the scope's reach with the map's page links and what the suite already holds. Empty when no scope was asked. */
  candidates: readonly UseCaseCandidate[];
  /** The enrichment every generation of the run starts from. */
  baseEnrichment: GenerationEnrichment;
}

/* What stands in for a generation when none ran (a regression run): it has no end, which no generation's result can have. */
export type RegressionStandIn = Omit<GenerationOutput, "end"> & { end: null };

/* What the generate phase and the pre-exec grounding left for the later phases. */
export interface GenerationOutcome {
  /** The generation the run goes on with: the first pass, or the corrective regeneration that replaced it. */
  generated: GenerationOutput | RegressionStandIn;
  /** The specs this run has delivered so far, merged after every generation pass: a lead pass refreshes what its verdict declared for each spec, a sidekick pass adds paths only. Every regeneration is handed them; the reducers are its only writers. */
  delivered: readonly DeliveredSpec[];
  /** The pre-exec gate's counters, real once it has run; 0 when its port is unwired. */
  preExecAmbiguityCatches: number;
  catalogGateInWindow: number;
  catalogGateAdvisory: number;
  catalogGateFailClosed: number;
  /** What the pre-exec grounding asked to correct, and the spec files it attributed those corrections to. */
  groundingCorrections: string[];
  groundingAttribution: string[];
  /** The use cases each flow of a coordinated first pass cites, by spec file; empty when the run was not coordinated. */
  flowCandidates: ReadonlyArray<{ specFile: string; candidates: readonly string[] }>;
}

/* What the validate, health and execute phases left for the fix loop and the phases after it; the fix loop replaces `run` and adds to `retries`. */
export interface ExecutionOutcome {
  /** The static gate's last verdict; the phase ends the run unless it is ok. */
  validation: Awaited<ReturnType<ValidationPort["validate"]>>;
  /** The latest generation attempt: the delivered one, or the last static-fix regeneration. */
  lastGenerated: GenerationOutput | RegressionStandIn;
  /** Static-fix rounds so far; the fix loop adds to it, never resets it. */
  retries: number;
  /** The static gate failed on specs the generator saw pass through run_spec: it ends the run instead of rewriting them. Decided once, after the first gate. */
  staticFixRetired: boolean;
  /** The hash of the login script that signed in just before execute; only such a file is kept by the suite store. */
  authVerifiedSha256: string | undefined;
  /** The primary execution; a context run's is a synthetic pass with no cases. Absent until the execute step wrote it: read it with `runOf`. */
  run: Awaited<ReturnType<ExecutionPort["execute"]>> | undefined;
}

/* What the fix loop left for the coverage, review and decide phases; the defaults stand when the loop never engaged. */
export interface FixLoopSession {
  /** The stage the loop is at and the round it is in: the loop itself, which holds its ports and scratch, is a live handle of the run's services. */
  stage: FixLoopStage;
  retry: number;
  /** What the loop's regenerations still carry from before it: grounding corrections (one-shot) and the latest lead generation's specs. */
  pending: { selectorContradictions: string[]; attributedSpecFiles: string[]; latestSpecs: string[] };
  /** The failing count and spec-set digest before the loop, for the phase span. */
  failingBefore: number;
  specShaBefore: string | undefined;
}

export interface FixLoopOutcome {
  /** The loop in progress; undefined before it engages and after it settles. */
  session: FixLoopSession | undefined;
  /** The winning loop execute namespace (`${runId}-rN`); absent when the loop never ran. */
  coverageNamespace: string | undefined;
  /** The full adjudicator verdict for the Issue body; undefined when the loop never reached adjudication. */
  lastAdjudicatorVerdict: AdjudicatorVerdict | undefined;
  /** The loop's final specMetas; undefined when it never regenerated. */
  fixLoopFinalSpecMetas: { flow?: string; objective?: string }[] | undefined;
  /** The loop's triage confirmed DEV did not render the target: the run ends as a precondition failure. */
  devNotRenderedConclusive: boolean;
}

/* What the coverage phase measured; the review phase's acceptances add to the counter and the stale re-measure replaces the measurement or marks it stale. */
export interface CoverageOutcome {
  /** Unknown never blocks; only the port's own reading of the mode and status sets it. */
  blocksPublish: boolean;
  coverageRatio: number | null;
  /** Undefined when the measurement never ran, distinct from a measured "unknown". */
  coverageStatus: "pass" | "fail" | "unknown" | undefined;
  /** Whether this run measured a real per-commit signal (a diff run on one repo): only then can its ratio go stale. */
  coverageMeasured: boolean;
  /** Null when the oracle is unwired, never a fabricated 0. */
  valueScore: number | null;
  /** The score per use case the change makes testable, or why one has none; undefined when the oracle was not aimed at any. A signal, never a gate. */
  valueByCandidate: CandidateValue[] | undefined;
  /** What the re-run counted (baseline, exposed, killed, failed, flow breaks), for calibrating the score; undefined when it measured nothing. */
  valueStats: ValueStats | undefined;
  /** Undefined means the oracle never measured this run; never fabricated as 0. */
  mutantCount: number | undefined;
  killedCount: number | undefined;
  /** The changed lines the first measurement left uncovered, for the enforce-mode regeneration. */
  uncovered: { file: string; lines: number[] }[];
  /** The share of each use case's changed lines the run executed, or why it has none; undefined when no use case was asked for. A signal beside the ratio, never a gate. */
  perCandidate: CandidateCoverage[] | undefined;
  /** Acceptances spent so far; each names its namespace by it. */
  acceptanceCalls: number;
  /** An accepted regeneration rewrote specs after the last measurement: the coverage ratio is then stale. */
  acceptedRegenAfterMeasure: boolean;
  /** The measurement predates the bytes an accepted regeneration wrote, and the mode reuses it rather than re-measuring. */
  coverageStale: boolean;
  /** The same bytes make the value score describe a suite that is no longer on disk. The oracle stays signal-only: stale is recorded, never a gate. */
  valueStale: boolean;
}

/** The round in progress: what a step hands to the next one of the same round. */
export interface ReviewRoundScratch {
  reviewResult: Awaited<ReturnType<ReviewPort["review"]>>;
  decidedBy: "model" | "precheck" | "unchanged";
  /** The spec each verified finding's citation names. */
  blockingSpecs: Map<string, string>;
  snapshot: SuiteRestorePoint;
  deliveredBefore: readonly DeliveredSpec[];
  regen: GenerationOutput | undefined;
  changedSpecFiles: string[];
  changedSupportFiles: string[];
  outcome: Awaited<ReturnType<RegenerationAcceptance["accept"]>> | undefined;
  /** A refused attempt hands the contract's violations to the next one. */
  contractFeedback: readonly ContractFeedback[] | undefined;
}

/** The review's convergence context between rounds: data, so the rounds are steps and not one function's locals. */
export interface ReviewSession {
  round: number;
  finalRunVerdict: Awaited<ReturnType<ExecutionPort["execute"]>>["verdict"];
  reviewCases: QaCase[];
  existingSpecFiles: string[];
  reviewerApproved: boolean;
  finalReviewerCorrections: string[];
  previousRoundCorrections: string[] | undefined;
  previousRoundBlocking: number | undefined;
  previousRoundSpecs: ReviewedSpecs | undefined;
  previousRoundCaseCount: number;
  stats: ReviewTally;
  lastReviewOutcome: string | undefined;
  lastCorrectionClass: string | undefined;
  reviewDomSnapshot: string | undefined;
  lastReviewSpecsKey: string | undefined;
  current: ReviewRoundScratch | undefined;
}

/* What the review phase decided; the defaults stand when the phase never ran. */
export interface ReviewOutcome {
  /** The review in progress; undefined before it opens and after it settles. */
  session: ReviewSession | undefined;
  reviewerApproved: boolean;
  /** Set once a genuine review verdict stands; undefined while none does, so the run falls back to what the generation itself reported. */
  reviewerApprovedForOutcome: boolean | undefined;
  /** Stays [] when the review loop never runs, never fabricated. */
  finalReviewerCorrections: string[];
  /** What the review phase cost and decided; absent when the phase never ran. */
  reviewerSignal: RunOutcome["gateSignals"]["reviewer"];
}

/* What the decide phase concluded from the run's evidence; undefined until it has run. */
export interface DecidedOutcome {
  evidence: RunEvidence;
  decision: RunDecision;
  /** Whether the run's failure is in the change's reach; absent when no case failed. Recorded, published and persisted, never read by the decision. */
  causal?: CausalLabel;
  /** A clean context-mode pass produced an architecture map, not tests: it neither persists nor folds. */
  isContextCleanPass: boolean;
}

/*
 * How many times each loop of the run has gone round: the one place the counters live. A loop is a set of steps that send the run
 * back with `goto` while a pure `nextAction` of the domain says to go on, and the step that goes round adds one through its update.
 */
export interface LoopCounters {
  /** Static-fix regenerations after a failed static gate. */
  staticFix: number;
  /** The one corrective regeneration the pre-execution grounding may ask for. */
  preExecRegen: number;
  /** Fix-loop rounds after a failed execution. */
  fixLoop: number;
  /** The one regeneration an enforced coverage failure triggers. */
  coverageRegen: number;
  /** Review rounds. */
  reviewRound: number;
  /** Attempts within a review round's correction (a refusal of the contract is retried once). */
  reviewAttempt: number;
  /** Corrections that went through the lead, across every origin. */
  leadCorrections: number;
  /** Review turns the lead used in a coordinated pass. */
  leadReviewTurns: number;
}

export const initialLoopCounters = (): LoopCounters => ({ staticFix: 0, preExecRegen: 0, fixLoop: 0, coverageRegen: 0, reviewRound: 0, reviewAttempt: 0, leadCorrections: 0, leadReviewTurns: 0 });

/* A fault the run went on past because what it had proven stands: the reason the policy named and what the outcome says about it. */
export interface Degradation {
  reason: DegradeReason;
  note: string;
}

/* What the run's trace and its crash records say, once known: how generation ended, the limit that stopped the run, which rules were retrieved. */
export interface RunFacts {
  generationEnd: string | undefined;
  limit: { fired: string; role: string } | undefined;
  rulesRetrieved: string[] | undefined;
  /** Why the run ended, once it did. */
  endReason: EndReason | undefined;
  /** Whether a reviewer was due for the run, as the generation decides it. */
  reviewRequired: boolean | undefined;
}

export interface RunState {
  classification: Classification;
  setup: SetupOutcome;
  grounding: Grounding;
  generation: GenerationOutcome;
  execution: ExecutionOutcome;
  fixLoop: FixLoopOutcome;
  coverage: CoverageOutcome;
  review: ReviewOutcome;
  decided: DecidedOutcome | undefined;
  loops: LoopCounters;
  /** The faults the run degraded past, in order; the decided outcome says each in its note. */
  degraded: Degradation[];
  /** What the run's trace and crash records read. */
  run: RunFacts;
  /** What the lead/sidekick mode came to; absent when the run was not coordinated. */
  coordination: CoordinationGateSignal | undefined;
  /** The sha256 of the bytes that executed green, by suite-relative spec path; the bytes themselves are held by the run's services. */
  proof: Record<string, string>;
}

/* The primary execution, once the execute step wrote it; reading it earlier is a defect of the step table. */
export function runOf(state: Readonly<RunState>): NonNullable<ExecutionOutcome["run"]> {
  const { run } = state.execution;
  if (run === undefined) throw new Error("the run's execution was read before the execute step wrote it");
  return run;
}

export function initialRunState(): RunState {
  return {
    classification: { generating: true },
    setup: { suiteRestored: false, storeRestoredLogin: false, authSeedUnauthored: false },
    grounding: {
      diffArchetypes: undefined,
      retrievalRelevance: undefined,
      retrievedRules: [],
      retrievedRuleIds: [],
      selectedExemplars: [],
      offeredArchetypes: [],
      contextPack: undefined,
      contextPackItemIds: undefined,
      contextPackOmissions: undefined,
      existingSpecFiles: undefined,
      contextMap: undefined,
      harnessFacts: undefined,
      moreNodes: [],
      confirmedDataRoutes: undefined,
      blastRadiusSignal: "",
      blastRadiusSignalHasSymbols: false,
      blastRadiusSignalFiles: [],
      serviceLinks: [],
      contractDrift: [],
      crossRepoImpact: null,
      changeScope: undefined,
      candidates: [],
      baseEnrichment: {},
    },
    generation: {
      generated: { specs: [], end: null },
      delivered: [],
      preExecAmbiguityCatches: 0,
      catalogGateInWindow: 0,
      catalogGateAdvisory: 0,
      catalogGateFailClosed: 0,
      groundingCorrections: [],
      groundingAttribution: [],
      flowCandidates: [],
    },
    execution: {
      staticFixRetired: false,
      validation: { ok: true, errors: [] },
      lastGenerated: { specs: [], end: null },
      retries: 0,
      authVerifiedSha256: undefined,
      run: undefined,
    },
    fixLoop: { session: undefined, coverageNamespace: undefined, lastAdjudicatorVerdict: undefined, fixLoopFinalSpecMetas: undefined, devNotRenderedConclusive: false },
    coverage: {
      blocksPublish: false,
      coverageRatio: null,
      coverageStatus: undefined,
      coverageMeasured: false,
      valueScore: null,
      valueByCandidate: undefined,
      valueStats: undefined,
      mutantCount: undefined,
      killedCount: undefined,
      uncovered: [],
      perCandidate: undefined,
      acceptanceCalls: 0,
      acceptedRegenAfterMeasure: false,
      coverageStale: false,
      valueStale: false,
    },
    review: { session: undefined, reviewerApproved: true, reviewerApprovedForOutcome: undefined, finalReviewerCorrections: [], reviewerSignal: undefined },
    decided: undefined,
    loops: initialLoopCounters(),
    degraded: [],
    run: { generationEnd: undefined, limit: undefined, rulesRetrieved: undefined, endReason: undefined, reviewRequired: undefined },
    coordination: undefined,
    proof: {},
  };
}
