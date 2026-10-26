import type { NoopKind } from "@kernel/noop-kind.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";
import type { PlanOutput } from "@kernel/plan-output.ts";
import type { AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import type { CommitIntent } from "@kernel/commit-intent.ts";
import type { RetrievedRule, SelectedExemplar } from "@contexts/cross-run-learning/application/index.ts";
import type { ArchitectureContext, GroundingOmission, HarnessFacts } from "@kernel/grounding.ts";
import type { ContractDrift, ImpactedLink, ServiceLink } from "@contexts/service-topology/application/index.ts";

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
  /** The change pages the lead's admitted plan left unvisited, when the lead authors the change alone. */
  unvisitedChangePages?: readonly string[];
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

/**
 * What one generation hands the run. `end` says how it ended: with specs the run continues;
 * without them, only a declared no-op is a decision, and the other ends say why nothing was
 * written. `reviewed` is whether an independent reviewer looked at the specs: `approved` is
 * that reviewer's verdict only when it is true — otherwise it is a placeholder, and the run must
 * read it through `reviewerApprovalOf`. `note` explains an end that wrote nothing.
 * `specSources` is just-generated spec text for selector checks; absent/empty is never
 * fabricated. `specMetas` is the flow/objective projection for publication; absent/empty omits
 * the "tested" section. `parsed` is false only when no verdict JSON could be parsed. `turn` is
 * what the generation's main turn measured, when its runtime can measure a turn. `declaredSpecs`
 * is what the verdict declared for each delivered spec (flow, objective), the lead's own word:
 * what the run carries into its later regenerations. Absent when no spec was delivered.
 */
export interface GenerationOutput {
  specs: string[];
  declaredSpecs?: DeliveredSpec[];
  end: GenerationEndKind;
  /** For a declared no-op, the reason its verdict named (`unspecified` when it named none). Absent for every other end. Observe-only. */
  noopKind?: NoopKind;
  reviewed: boolean;
  approved: boolean;
  note?: string;
  specSources?: string[];
  parsed?: boolean;
  specMetas?: { flow?: string; objective?: string }[];
  turn?: AgentTurnStats;
  /* The generator's typed claim that the test is correct; a claim, never evidence. Absent unless the verdict carried one. */
  testCorrect?: { cause: "env" | "app"; reason: string };
  /* The findings the generator disputes instead of correcting, each with the basis the run must check. Absent unless the verdict carried one. */
  rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[];
}

/** The reviewer's verdict on a generation, or undefined when no reviewer looked at it: the one way the run reads `approved`. */
export function reviewerApprovalOf(generation: Pick<GenerationOutput, "reviewed" | "approved">): boolean | undefined {
  return generation.reviewed ? generation.approved : undefined;
}

export interface GenerationPort {
  /**
   * `signal` interrupts in-flight generation on cancel. `diff` is the real
   * per-run commit diff (diff mode only); absent falls back to the adapter's
   * static per-run value. `enrichment` is independently absent-safe.
   */
  generate(specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationOutput>;
  /**
   * The one turn a coordinated run asks the lead for a plan instead of specs. `enrichment.planning` carries the limits the plan
   * will be held to and is required. Absent: this port cannot plan, and a coordinated run authors the change as one piece of work.
   */
  plan?(specDir: string, signal: AbortSignal | undefined, diff: string | undefined, enrichment: GenerationEnrichment): Promise<PlanOutput>;
  /** Ends the generator session the run kept for its regenerations. Called once when the run ends, however it ends. Absent: this port keeps no session. */
  release?(): Promise<void>;
}
