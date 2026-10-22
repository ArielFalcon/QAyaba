/* The data a run carries from one phase to the next. Each section is written by the phase that owns it and read by the later ones; it holds no live object, so it can be recorded as it stands. */

import type {
  ArchitectureContext,
  CommitIntent,
  ContractDrift,
  GenerationEnrichment,
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

export interface RunState {
  classification: Classification;
  setup: SetupOutcome;
  grounding: Grounding;
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
  };
}
