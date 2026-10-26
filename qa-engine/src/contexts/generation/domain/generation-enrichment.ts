import type { RetrievedRule, SelectedExemplar } from "@kernel/learned-rule.ts";
import type { ServiceLink, ContractDrift, ImpactedLink } from "@kernel/service-links.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { CommitIntent } from "@kernel/commit-intent.ts";
import type { GroundingOmission, ArchitectureContext, HarnessFacts } from "@kernel/grounding.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";

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
  /**
   * The same gap as separate units (a file's uncovered lines, an arm no test ran), in the order the gap lists them. Only the lead's
   * routing reads it, so that a number it cites names one unit; an author reads `coverageGap`.
   */
  coverageGapItems?: readonly string[];
  /**
   * The intent lock's violations of the turn before this one (A-2b): what the contract held before and
   * after, handed back as facts so the generator can repair the weakening it introduced. Structural
   * mirror of the domain's ContractFeedback: this barrel carries no cross-context type.
   */
  contractFeedback?: readonly { rule: string; file: string; clauseId: string; before: string; after: string }[];
  /** Present only when the run granted the generator the run_spec tool: the limits its prompt states. */
  closedLoop?: ClosedLoopLimits;
  /** Present only when the run granted the authoring agents the authenticated browser: the limits its prompt states. */
  agentBrowser?: AgentBrowserLimits;
  /** Present only when the app declares a location: the default, the places and where this authoring scope is. */
  geolocation?: GeolocationFacts;
  /**
   * Every spec this run has delivered so far, refreshed for each regeneration turn: the lead's
   * declared flow and objective where it declared them, a sidekick's specs by path alone.
   * Absent on a first pass and when nothing was delivered. The adapter drops the entries whose
   * file is gone before they reach a prompt.
   */
  deliveredSpecs?: readonly DeliveredSpec[];
  /**
   * The suite files whose source holds a selector that one of `selectorContradictions` names:
   * a contradiction names no spec itself. Absent when none could be attributed.
   */
  attributedSpecFiles?: readonly string[];
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
  /** The pack's delivered grounding ids and omissions (packDeliveredItemIds), threaded with the pack text. */
  contextPackItemIds?: readonly string[];
  contextPackOmissions?: readonly GroundingOmission[];
  /**
   * App login is declared but the suite's auth.setup.ts is still the stock seed and did not
   * sign in, so the generator must author the login first. Set only when true.
   */
  authSeedUnauthored?: boolean;
  /**
   * Structured map from specDir/.qa/context.json. Distinct from contextPack
   * (assembled markdown). Absent when the json is missing/invalid (fail-open).
   */
  contextMap?: ArchitectureContext;
  /**
   * Facts about the suite's harness (configured test-id attribute, fixtures exports). Facts
   * only, never an instruction. Absent when nothing was configured or scannable.
   */
  harnessFacts?: HarnessFacts;
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
   * True when `staticSignal` names symbols (impacted or callers). Only such a signal stands for
   * an explored blast radius; one that holds co-change files alone does not. Present only
   * alongside `staticSignal`, and only when true — absent is never a fabricated false.
   */
  staticSignalHasSymbols?: boolean;
  /** The files the static signal's dossier shows verbatim (repo-relative). Present only alongside `staticSignal`. */
  staticSignalFiles?: readonly string[];
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
  /** Present only on the planning turn of a coordinated run: the limits the plan will be held to. Absent on every other turn. */
  planning?: PlanningLimits;
}
