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
  ExplorationBrief,
  GroundingOmission,
  HarnessFacts,
  RelevanceBias,
  RetrievedRule,
  SelectedExemplar,
  ServiceLink,
} from "../ports/index.ts";

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
  contextBrief: ExplorationBrief | undefined;
  harnessFacts: HarnessFacts | undefined;
  /** The added labels whose changed-value line in the pack said more nodes than unchanged lines: what an unobservable no-op is set beside. */
  moreNodes: readonly string[];
  blastRadiusSignal: string;
  blastRadiusSignalHasSymbols: boolean;
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

/* What the validate, health and execute phases left for the fix loop and the phases after it. */
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

export interface RunState {
  classification: Classification;
  setup: SetupOutcome;
  grounding: Grounding;
  generation: GenerationOutcome;
  execution: ExecutionOutcome;
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
      contextBrief: undefined,
      harnessFacts: undefined,
      moreNodes: [],
      blastRadiusSignal: "",
      blastRadiusSignalHasSymbols: false,
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
  };
}
