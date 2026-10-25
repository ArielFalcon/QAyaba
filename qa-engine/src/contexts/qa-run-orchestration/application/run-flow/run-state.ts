/* The data a run carries from one phase to the next. Each section is written by the phase that owns it and read by the later ones; it holds no live object, so it can be recorded as it stands. */

import type {
  ArchitectureContext,
  CommitIntent,
  ContractDrift,
  GenerationEnrichment,
  GenerationOutput,
  ExecutionPort,
  ValidationPort,
  CrossRepoImpact,
  GroundingOmission,
  HarnessFacts,
  RelevanceBias,
  RetrievedRule,
  SelectedExemplar,
  ServiceLink,
  UntakenArm,
} from "../ports/index.ts";
import type { AdjudicatorVerdict } from "../../domain/adjudicate.service.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { GraphPage } from "@kernel/change-pages.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { RunDecision } from "../../domain/run-decision.ts";
import type { RunEvidence } from "../../domain/run-decision.service.ts";

/* What the classifier said about the change. Only a diff run classifies: every other run generates and has no diff. */
export interface Classification {
  diff?: string;
  intent?: CommitIntent;
  reason?: string;
  contradiction?: boolean;
  /** False for a "regression" change, which runs the existing suite without generating. */
  generating: boolean;
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
  /** The pages of the app's map the change is linked to, in rank order: a coordinated run's planning turn is told them. */
  changeRoutes: readonly string[];
  /** The proof the call graph found for each change page it added: a sidekick's brief carries those of its flow's pages. */
  changeProofs: readonly GraphPage[];
  /** The pages the pack read with results under the declared data state: the witness a failure that reads them empty contradicts. */
  confirmedDataRoutes: readonly { path: string; resultCount: number }[] | undefined;
  blastRadiusSignal: string;
  blastRadiusSignalHasSymbols: boolean;
  /** The files the signal's dossier shows verbatim. */
  blastRadiusSignalFiles: readonly string[];
  serviceLinks: readonly ServiceLink[];
  contractDrift: readonly ContractDrift[];
  crossRepoImpact: CrossRepoImpact | null;
  /** The enrichment every generation of the run starts from. */
  baseEnrichment: GenerationEnrichment;
}

/* What stands in for a generation when none ran (a regression run): it has no end, which no generation's result can have. */
export type RegressionStandIn = Omit<GenerationOutput, "end"> & { end: null };

/* What the generate phase and the pre-exec grounding left for the later phases. */
export interface GenerationOutcome {
  /** The generation the run goes on with: the first pass, or the corrective regeneration that replaced it. */
  generated: GenerationOutput | RegressionStandIn;
  /** The pre-exec gate's counters, real once it has run; 0 when its port is unwired. */
  preExecAmbiguityCatches: number;
  catalogGateInWindow: number;
  catalogGateAdvisory: number;
  catalogGateFailClosed: number;
  /** What the pre-exec grounding asked to correct, and the spec files it attributed those corrections to. */
  groundingCorrections: string[];
  groundingAttribution: string[];
}

/* What the validate, health and execute phases left for the fix loop and the phases after it; the fix loop replaces `run` and adds to `retries`. */
export interface ExecutionOutcome {
  /** The static gate's last verdict; the phase ends the run unless it is ok. */
  validation: Awaited<ReturnType<ValidationPort["validate"]>>;
  /** The latest generation attempt: the delivered one, or the last static-fix regeneration. */
  lastGenerated: GenerationOutput | RegressionStandIn;
  /** Static-fix rounds so far; the fix loop adds to it, never resets it. */
  retries: number;
  /** The hash of the login script that signed in just before execute; only such a file is kept by the suite store. */
  authVerifiedSha256: string | undefined;
  /** The primary execution; a context run's is a synthetic pass with no cases. */
  run: Awaited<ReturnType<ExecutionPort["execute"]>>;
}

/* What the fix loop left for the coverage, review and decide phases; the defaults stand when the loop never engaged. */
export interface FixLoopOutcome {
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
  /** Undefined means the oracle never measured this run; never fabricated as 0. */
  mutantCount: number | undefined;
  killedCount: number | undefined;
  /** The changed lines the first measurement left uncovered, for the enforce-mode regeneration. */
  uncovered: { file: string; lines: number[] }[];
  /** The arms of the decisions on changed lines and how many ran; undefined when none was seen. A signal, never a gate. */
  branchCoverage: { changed: number; taken: number } | undefined;
  /** The arms on changed lines no test ran, for the enforce-mode regeneration beside the uncovered lines. */
  untakenArms: UntakenArm[];
  /** Acceptances spent so far; each names its namespace by it. */
  acceptanceCalls: number;
  /** An accepted regeneration rewrote specs after the last measurement: the coverage ratio is then stale. */
  acceptedRegenAfterMeasure: boolean;
  /** The measurement predates the bytes an accepted regeneration wrote, and the mode reuses it rather than re-measuring. */
  coverageStale: boolean;
  /** The same bytes make the value score describe a suite that is no longer on disk. The oracle stays signal-only: stale is recorded, never a gate. */
  valueStale: boolean;
}

/* What the review phase decided; the defaults stand when the phase never ran. */
export interface ReviewOutcome {
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
  /** A clean context-mode pass produced an architecture map, not tests: it neither persists nor folds. */
  isContextCleanPass: boolean;
}

/* What the publish phase did; undefined `publishOutcome` means publication was not called. */
export interface PublicationOutcome {
  publishOutcome: string | undefined;
}

/* What the persist phase derived and saved; undefined until it has run. */
export interface PersistedOutcome {
  errorClass: string | null;
  loopSignal: ClosedLoopGateSignal | undefined;
  /** Absent for a clean context pass, which persists nothing. */
  mainlineOutcome: RunOutcome | undefined;
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
  publication: PublicationOutcome;
  persisted: PersistedOutcome | undefined;
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
      changeRoutes: [],
      changeProofs: [],
      confirmedDataRoutes: undefined,
      blastRadiusSignal: "",
      blastRadiusSignalHasSymbols: false,
      blastRadiusSignalFiles: [],
      serviceLinks: [],
      contractDrift: [],
      crossRepoImpact: null,
      baseEnrichment: {},
    },
    generation: {
      generated: { specs: [], approved: true, reviewed: false, end: null },
      preExecAmbiguityCatches: 0,
      catalogGateInWindow: 0,
      catalogGateAdvisory: 0,
      catalogGateFailClosed: 0,
      groundingCorrections: [],
      groundingAttribution: [],
    },
    execution: {
      validation: { ok: true, errors: [] },
      lastGenerated: { specs: [], approved: true, reviewed: false, end: null },
      retries: 0,
      authVerifiedSha256: undefined,
      run: { verdict: "pass", cases: [], logs: "" },
    },
    fixLoop: { coverageNamespace: undefined, lastAdjudicatorVerdict: undefined, fixLoopFinalSpecMetas: undefined, devNotRenderedConclusive: false },
    coverage: {
      blocksPublish: false,
      coverageRatio: null,
      coverageStatus: undefined,
      coverageMeasured: false,
      valueScore: null,
      mutantCount: undefined,
      killedCount: undefined,
      uncovered: [],
      branchCoverage: undefined,
      untakenArms: [],
      acceptanceCalls: 0,
      acceptedRegenAfterMeasure: false,
      coverageStale: false,
      valueStale: false,
    },
    review: { reviewerApproved: true, reviewerApprovedForOutcome: undefined, finalReviewerCorrections: [], reviewerSignal: undefined },
    decided: undefined,
    publication: { publishOutcome: undefined },
    persisted: undefined,
  };
}
