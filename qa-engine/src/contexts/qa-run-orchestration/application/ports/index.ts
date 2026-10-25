/*
 * Segregated ports for the QA run lifecycle. RunPipelinePort is the driving
 * seam (one RunInput → RunOutcome). Driven ports are the capabilities the run
 * composes, plus ObserverPort and RunHistoryPort. Types here stay
 * kernel-resident: no cross-context imports; generation and topology shapes
 * are structural mirrors.
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
import type { Objective } from "@kernel/objective.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunEventBody } from "@kernel/run-event.ts";
import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";
import type { AgentBrowserGateSignal, AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeoLocation, GeolocationFacts } from "@kernel/geolocation.ts";

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
  routes: Array<{ path: string; name?: string; component?: string; source?: string; implementationFiles?: string[] }>;
  api: Array<{ operationId: string; method: string; path: string; service?: string; spec?: string }>;
  feBe: Array<{ route: string; operationId: string; via?: string }>;
  flows?: Array<{ id: string; routes: string[]; operations?: string[] }>;
}

/** Port-local HarnessFacts. Generation's type is structurally assignable; this barrel does not import across contexts. */
export interface HarnessFacts {
  /** Only when the app declares one: no default is invented. */
  testIdAttribute?: string;
  fixtures?: { file: string; exports: readonly string[] };
}

/** Port-local mirror of the generation Omission shape (this barrel does not import across contexts). */
export interface GroundingOmission {
  class: "selection" | "truncation";
  reason: string;
  count: number;
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

/**
 * The run_spec loop of one run, as the use case sees it: the right to execute a spec while authoring, granted to the
 * generator's own sessions. The run opens it after the login and closes it when it ends, however it ends.
 */
export interface ClosedLoopOpenInput {
  runId: string;
  app: string;
  mode: RunMode;
  purpose?: RunPurpose;
  mirrorDir: string;
  specDir: string;
  /** The run's own choice, when it makes one (an A/B arm): overrides the app's setting. Absent: the app's setting decides. */
  enabled?: boolean;
  /** The run's cancellation: a call in flight when it fires is stopped. */
  signal?: AbortSignal;
}
export interface ClosedLoopSignals {
  /** run_spec calls that started. */
  calls: number;
  /** Mutating requests the executed specs sent to DEV. */
  devWrites: number;
}
/** What a flow's loop is opened with: its own share of the run's calls and writes, the sidekick's workspace its spec is read from, and the one spec it may run. */
export interface FlowLoopOpenInput {
  delegationId: string;
  /** The flow's slug: it names the namespace of the flow's calls. */
  flowId: string;
  limits: { maxCalls: number; maxDevWrites: number };
  /** The sidekick's workspace: where its spec is written and read. */
  workspace: { dir: string; specDir: string };
  /** The one spec the flow may run, relative to the spec directory. */
  specFile: string;
  /** Puts the spec in the working copy where the suite runs it, and says where (relative to the spec directory), or undefined when the workspace has no such spec. Called inside the lease of each call. */
  stage(): Promise<string | undefined>;
}
/** One call of a flow's loop that ran: the bytes of the spec it ran (their sha256), and how it ended. */
export interface FlowLedgerEntry {
  path: string;
  sha256: string;
  status: string;
  devWrites: number;
  /** The facts of the call's failing tests: error, page by pathname, results read, server status, runtime errors, whether the page was still changing. */
  failures?: readonly FlowFailureFact[];
}
/** One failing test of a flow's run_spec call, as the orchestrator kept it. */
export interface FlowFailureFact {
  detail?: string;
  path?: string;
  resultCount?: number;
  httpStatus?: number;
  runtimeErrors?: readonly { type: string; text: string }[];
  unsettled?: true;
}
export interface FlowLoopHandle {
  /** What the flow's prompt states about the tool: its own share. */
  limits: ClosedLoopLimits;
  signals(): ClosedLoopSignals;
  /** What the orchestrator saw the flow's calls do, oldest first. */
  ledger(): readonly FlowLedgerEntry[];
  /** Whether the spec the sidekick holds now is the one whose last call passed. */
  isClosed(): Promise<boolean>;
  /** Revokes the flow's right and cleans the data of a call that was in flight. Never throws. */
  close(): Promise<void>;
}
export interface ClosedLoopHandle {
  /** What the generator's prompt states about the tool. */
  limits: ClosedLoopLimits;
  /** Opens the loop of one flow of a plan, for the sidekick that authors it; undefined once the run's loop is closed. Throws when the flow is already open. */
  openFlow(input: FlowLoopOpenInput): FlowLoopHandle | undefined;
  /** Removes the probe specs a generator session left in the spec directory. Idempotent. */
  sweepProbes(): Promise<void>;
  /** Whether every one of these delivered specs holds the bytes whose last call passed. */
  isClosed(deliveredSpecs: readonly string[]): Promise<boolean>;
  signals(): ClosedLoopSignals;
  /** Revokes the right, removes the probes and the data the calls left. Never throws. */
  close(): Promise<void>;
}
export interface ClosedLoopPort {
  /** Resolves undefined when this run is not granted the loop (disabled, another runtime, nothing to run it with). */
  open(input: ClosedLoopOpenInput): Promise<ClosedLoopHandle | undefined>;
}

/**
 * The authenticated browser of one run, as the use case sees it: the right of the authoring agents to read DEV through the
 * session the run signed in with, without ever holding it. The run opens it after the login and closes it when it ends,
 * however it ends.
 */
export interface AgentBrowserOpenInput {
  runId: string;
  app: string;
  mode: RunMode;
  purpose?: RunPurpose;
  /** The suite directory of the run's working copy: where a renewed login is prepared for. */
  specDir: string;
  /** The run's own choice, when it makes one (an A/B arm): overrides the app's setting. */
  enabled?: boolean;
  /** The run's cancellation: a call in flight when it fires is stopped. */
  signal?: AbortSignal;
  /** The app's declared location, when it declares one: the browser opens at it, and each session's own scope may move it. Absent: the browser is not given a location. */
  geolocation?: { default: GeoLocation; forSession(sessionId: string): GeoLocation | undefined };
}
export interface AgentBrowserHandle {
  /** What the generator's prompt states about the tools. */
  limits: AgentBrowserLimits;
  /** Gives a flow of a plan the calls its sidekick may make out of the run's, before the sidekick's session opens. */
  grantShare(delegationId: string, calls: number): void;
  signals(): AgentBrowserGateSignal;
  /** Revokes the right, stops the browser. Never throws. */
  close(): Promise<void>;
}
export interface AgentBrowserPort {
  /** Resolves undefined when this run is not granted the browser (disabled, another runtime, no saved session to use). */
  open(input: AgentBrowserOpenInput): Promise<AgentBrowserHandle | undefined>;
}

/**
 * The device location of one run, as the use case sees it: the app's declared default and places, the lead's own value,
 * and one value per flow of a plan. The run opens it after the login and closes it when it ends, however it ends. It is
 * authoring context: the authenticated browser uses it, and a delivered spec pins its own location with setLocation().
 */
export interface GeolocationOpenInput {
  runId: string;
  app: string;
  mode: RunMode;
  /** The run's cancellation: no change is accepted once it fires. */
  signal?: AbortSignal;
}
export interface FlowGeolocationHandle {
  facts(): GeolocationFacts;
  current(): GeoLocation;
  /** Forgets the flow's value; a change from one of its sessions is refused afterwards. */
  close(): void;
}
export interface GeolocationHandle {
  /** The app's declared default: what the suite runs with when a spec sets none. */
  readonly default: GeoLocation;
  /** The lead's scope: the app default until the lead moves it. */
  facts(): GeolocationFacts;
  placeNames(): readonly string[];
  /** Where a session's own scope is now (its flow, or the run's lead), or undefined when the session is not bound to this run. */
  forSession(sessionId: string): GeoLocation | undefined;
  /** Opens a flow's own value, starting where the plan says or where the lead is. Undefined once the run's location is closed. */
  openFlow(delegationId: string, initial?: GeoLocation): FlowGeolocationHandle | undefined;
  /** Revokes every scope and forgets the flows. Never throws. */
  close(): void;
}
export interface GeolocationPort {
  /** Resolves undefined when the app declares no location: no tool, no section and no value to inject. */
  open(input: GeolocationOpenInput): Promise<GeolocationHandle | undefined>;
}

export interface GenerationPort {
  /**
   * `signal` interrupts in-flight generation on cancel. `diff` is the real
   * per-run commit diff (diff mode only); absent falls back to the adapter's
   * static per-run value. `enrichment` is independently absent-safe.
   */
  generate(objectives: readonly Objective[], specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationOutput>;
  /**
   * The one turn a coordinated run asks the lead for a plan instead of specs. `enrichment.planning` carries the limits the plan
   * will be held to and is required. Absent: this port cannot plan, and a coordinated run authors the change as one piece of work.
   */
  plan?(specDir: string, signal: AbortSignal | undefined, diff: string | undefined, enrichment: GenerationEnrichment): Promise<PlanOutput>;
  /** Ends the generator session the run kept for its regenerations. Called once when the run ends, however it ends. Absent: this port keeps no session. */
  release?(): Promise<void>;
}
/**
 * What a planning turn came to. `plan` is the object the lead's verdict carried, untrusted: only the orchestrator's admission reads
 * it. `noopReason` is the reason the lead gave for writing nothing when it declared that instead of planning. A turn that gives
 * neither is `parsed` when its verdict could be read at all; `timedOut` is a turn that ran out of its planning time.
 */
export interface PlanOutput {
  plan?: Record<string, unknown>;
  noopReason?: string;
  parsed: boolean;
  timedOut: boolean;
  turn?: AgentTurnStats;
  /** The lead's planning session, held open when the turn came back with a plan, for the lead's review of the flows. The caller disposes it. */
  lead?: LeadSessionHandle;
}
/** What a run is asked when it opens the lead's code-graph tools. */
export interface CodeGraphToolsOpenInput {
  runId: string;
}
/** The lead's code-graph right for one run: its limits, what was used of it, and its end. */
export interface CodeGraphToolsHandle {
  limits: { maxCalls: number; maxFiles: number; maxAnswerChars: number };
  signals(): { calls: number; refused: number; failed: number };
  /** Revokes the right. Never throws. */
  close(): void;
}
/** Grants the lead the read-only `explore` of the run's own code-graph index. `open` answers nothing when the run cannot be granted it. */
export interface CodeGraphToolsPort {
  open(input: CodeGraphToolsOpenInput): Promise<CodeGraphToolsHandle | undefined>;
}
/** The lead's planning session, held open for its next turn: asked read-only, a turn out of its time answers `timedOut`. */
export interface LeadSessionHandle {
  ask(text: string, opts: { timeoutMs: number }): Promise<{ output: string; timedOut: boolean }>;
  dispose(): Promise<void>;
}
/**
 * `priorCorrections` lets the next review judge convergence on previously
 * raised blocking issues instead of inventing new nits.
 */
export interface ReviewEnrichment {
  priorCorrections?: readonly string[];
  /* The spec lines that changed since the prior rejection, already bounded and rendered. */
  specChanges?: string;
  /* Paths of the suite's existing specs: context only, never a target and never a reason to reject. */
  existingSpecFiles?: readonly string[];
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
  /**
   * The run's own execution of the specs under review (verdict and cases). The adapter renders it as
   * the reviewer's execution evidence, so an app defect (a 5xx, a redirect, a runtime error) is
   * distinguishable from a test defect without asking the generator. Absent: the prompt carries none.
   */
  executionEvidence?: { verdict: string; cases: readonly QaCase[] };
  /** Per-run id for the reviewer SSE session (separate from the generator's). */
  runId?: string;
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
/**
 * What one reviewer turn cost, as its own runtime reported it. Every figure is optional and absent
 * when the runtime did not report it: never a fabricated zero. `durationMs` is always measured by the
 * bridge. Persisted on the run's reviewer signal, never read back into the verdict.
 */
export interface ReviewStats {
  durationMs: number;
  promptBytes: number;
  outputChars: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  steps?: number;
}

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
    /* The reviewer's own severity per correction, and the evidence it cites, in the same order. */
    severities?: ("blocking" | "advisory")[];
    citations?: ({ kind: "contract" | "execution" | "dom"; ref: string } | undefined)[];
    /**
     * True when no judgment was possible because the reviewer's runtime failed or returned nothing: an
     * integration fault, which is neither an approval nor a rejection. Absent on every review that
     * reached a reviewer's answer, including an unreadable one (a parse miss).
     */
    unavailable?: boolean;
    /** What the turn cost. Absent when the port never opened a reviewer session. */
    stats?: ReviewStats;
  }>;
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
/**
 * Port-local RelevanceBias — mirrors cross-run-learning's RuleGovernanceService.RelevanceBias
 * structurally (same no-cross-context-import rule as CommitIntent above, this barrel's own
 * header). Deterministic retrieval-time bias toward rules whose errorClass/archetype matches THIS
 * run's own signals (never an LLM signal) — see learning-port.adapter.ts for what RunQaUseCase
 * actually has available to populate it with at retrieval time.
 */
export interface RelevanceBias {
  errorClass?: string | null;
  archetypes?: readonly string[];
}
export interface LearningPort {
  /** Off-path: a failure is logged and swallowed, never gates publish. */
  fold(outcome: RunOutcome): Promise<void>;
  /** relevance is optional enrichment — omitted (or every field absent) retrieves ungrounded, exactly as before this bias existed. */
  retrieve(sha: Sha, relevance?: RelevanceBias): Promise<RetrievedRule[]>;
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

/**
 * Post-generate capture of on-disk spec text plus live route trees.
 * Re-reads specs on every call so a re-check after regen sees rewritten specs.
 * RouteTree is duck-typed locally (no cross-context import). Absent: the
 * pre-exec gate is skipped and related gateSignals stay the number 0, not
 * undefined. Adapter must not throw.
 * The sources are read through the confined reader: a spec that is not a regular
 * file inside the spec directory reads as "", never as what a link it planted
 * points at. `specFiles` names each source, relative to the spec directory and
 * index-aligned with `specSources`.
 */
export interface PreExecGroundingPort {
  capture(specDir: string, signal?: AbortSignal): Promise<{
    specFiles: string[];
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
  /** The pack's delivered grounding ids and omissions, computed from the kept lines (packDeliveredItemIds). Threaded with the pack text so the prompt's delivered span is read from the assembly. */
  contextPackItemIds?: readonly string[];
  contextPackOmissions?: readonly GroundingOmission[];
  /**
   * On-disk spec paths enumerated before the first generate(). Absent/empty when
   * the e2e dir does not exist yet or enumeration failed (fail-open).
   */
  existingSpecFiles?: string[];
  /** ArchitectureContext from specDir/.qa/context.json. Absent when missing/invalid (fail-open). */
  contextMap?: ArchitectureContext;
  /** Facts about the suite's harness (the configured test-id attribute, what the fixtures file exports). Absent when nothing was configured or scannable (fail-open). */
  harnessFacts?: HarnessFacts;
  /** The added labels whose changed-value line in the pack said more nodes than unchanged lines of the file. Absent when none did, or when no pack carries such lines. */
  changedValuesWithMoreNodes?: string[];
  /** The pages the pack read with results (> 0) under the app's declared data state, by pathname. Absent when it read none. */
  packConfirmedDataRoutes?: { path: string; resultCount: number }[];
  /** The pages of the app's map the change is linked to, in rank order: the map's own links, then the pages the call graph proved. Absent when none is. */
  changeRoutes?: string[];
  /** Why each change page is one, parallel to `changeRoutes`. */
  changeRouteBasis?: ChangePageBasis[];
  /** What the change-page join over the call graph found (its proofs, hubs and disagreements). Absent when no index answered. */
  changePages?: ChangePagesJoin;
}

/** What the change-page join needs beyond the map: the change, and on a cross-repo run the stitcher's links as they are. */
export interface GroundingChange {
  sha: string;
  serviceLinks?: readonly ServiceLink[];
  crossRepoImpact?: CrossRepoImpact | null;
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
  ground(specDir: string, signal?: AbortSignal, diff?: string, change?: GroundingChange): Promise<GroundingResult>;
}

export interface ChangePagesRequest {
  map: ArchitectureContext;
  sha: string;
  changedFiles: readonly string[];
  touchedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** The pages the map already links to the change: they keep the map's basis. */
  linked: ReadonlySet<string>;
  crossRepoImpact?: CrossRepoImpact | null;
}

/**
 * The pages of the map the run's call graph proves the change reaches (S10-S12). Advisory: it only adds pages, ranked after
 * the map's links, and never throws; undefined when no index could answer.
 */
export interface ChangePagesPort {
  resolve(request: ChangePagesRequest): Promise<ChangePagesJoin | undefined>;
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
 * The advisory block and whether it names symbols. An empty `text` is no signal, and then
 * `hasSymbols` is false: nothing is claimed.
 */
export interface StructuralSignalResult {
  text: string;
  hasSymbols: boolean;
  /** The files the block's dossier shows verbatim: a read of one re-fetches what the prompt already carries. */
  providedFiles?: string[];
  /** The commit of the code-graph index the block was read from; absent when the graph gave no answer. */
  indexedSha?: string;
}

/**
 * Advisory blast-radius markdown for GenerationEnrichment.staticSignal.
 * Absent: no staticSignal. Throw is fail-open at the caller. Unavailable
 * query degrades to an empty `text` — never a fabricated claim.
 */
export interface StructuralSignalPort {
  render(repoDir: string, changed: BlastRadius): Promise<StructuralSignalResult>;
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
  operation?: { verb: string; path: string };
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
 * (triggerRepo present and a resolved link targets it). Failure degrades to null
 * and whole-link rendering falls back, except UntrustedGitTreeError (untrusted
 * code replaced the mirror's git dir), which is thrown and fails the run.
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

/**
 * Captures the FE<->BE architecture map (`${specDir}/.qa/context.json`) a successful mode:context
 * generation wrote, and persists it as the app's durable stored map (shell-side SQLite — see
 * history.ts's context_maps table). This is the write side; PreGenerationGroundingPort.loadContextMap
 * is the read side. Invoked once per clean context-mode pass, in BOTH shadow and non-shadow runs —
 * publishing e2e/.qa/context.json via PR stays independently shadow-gated (buildVcsPublish), but the
 * stored map must survive regardless, since the mirror's e2e/.qa/context.json is wiped by the next
 * run's `git checkout -f` + `git clean -fd`. Off-path: a capture fault is fault-isolated inside the
 * adapter (never gates a verdict or publish), same contract as CurriculumPort.fold above.
 */
export interface ContextMapCapturePort {
  capture(specDir: string, app: string, sha: string): Promise<void>;
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

