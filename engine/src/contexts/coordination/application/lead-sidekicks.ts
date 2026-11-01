/*
 * The lead/sidekick mode of one run: the lead is asked for a plan; a plan of independent flows is authored by sidekicks in
 * parallel, each in a workspace of its own and each closing its own run_spec loop; what each flow wrote comes back by the one rule
 * of the workspace. The lead then reviews the flows in its planning session: it accepts a flow, sends an instruction to the
 * sidekick that wrote it (whose session, workspace and loop are kept for it), starts a fresh sidekick on it, or drops one that
 * delivered nothing; its answer is admitted against the orchestrator's facts (lead-review.ts). The flows are added up the way a
 * generation ends. Whatever cannot be coordinated is refused with the reason recorded (`AUTHORING_REFUSAL`): no plan,
 * no time, nobody to author with, a plan that cannot be admitted. Flows that finished nothing end as a generation that decided nothing.
 * Nothing here decides a verdict: it returns what a generation would, and the run reads it as it reads any generation.
 */

import type { DeadlinePurpose } from "@kernel/deadline-purpose.ts";
import { endsWithSpecPath } from "@kernel/spec-path.ts";
import { heldTo, type HeldTime } from "@kernel/allotment-cap.ts";
import type { TimeLimitSource } from "@kernel/turn-limit.ts";
import { LOG_EFFECT, levelOfEffect } from "@kernel/ports/logger.port.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import { sha256Hex } from "@kernel/content-hash.ts";
import type { ChangedDecision } from "@kernel/changed-decision.ts";
import type { AssembledPrompt } from "@kernel/prompt-sections.ts";
import { posix } from "node:path";
import { PROBE_REL_DIR } from "@contexts/test-execution/application/index.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { AUTHORING_REFUSAL, type CoordinationGateSignal, type CoordinationSettings, type LessonDelivery, type PlanningLimits } from "@kernel/coordination.ts";
import { formatGeoLocation, type GeoLocation } from "@kernel/geolocation.ts";
import { isRunDeadlineError } from "../../../shared-kernel/run-deadline.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowFailureFact, FlowGeolocationHandle, FlowLedgerEntry, FlowLoopHandle, GeolocationHandle } from "@contexts/agent-tools/application/index.ts";
import type { LeadSessionHandle, PlanOutput } from "@kernel/plan-output.ts";
import type { DelegationWorkspace, DelegationWorkspaceRequest, WorkspaceChange } from "../domain/delegation-workspace.ts";
import type { DelegationWorkspacePort } from "./ports/delegation-workspace.port.ts";
import { createDelegationBrief, type DelegationBrief } from "./delegation-brief.ts";
import { briefChangeFor, fitBriefChange, type BriefChange } from "./brief-change.ts";
import { assembleSidekickBrief } from "./sidekick-prompt.ts";
import type { ContextBudget, ContextFit } from "@kernel/context-budget.ts";
import type { WindowFitOutcome } from "@kernel/prompt-sections.ts";
import { entryKey } from "@kernel/change-reach.ts";
import { candidatePagesOf, pageRoutesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { candidateSeeds } from "@kernel/change-map.ts";
import { admissionSetOf, flowCovers, honorContradictedDrops, MAX_PLAN_ROUNDS, needsAmendment, planCoverage, assembleReplanRequest, unvisitedBy, type AdmissionSet, type PlanAmendment, type PlanCoverage, type PlanFacts } from "./plan-coverage.ts";
import { candidateSlicesOf, changeViewOf, ownedSliceOf, type ChangeView } from "./owned-slices.ts";
import { flowCapacity } from "./flow-capacity.ts";
import { unansweredTurn, type CandidateClaim, type DelegationResult } from "./delegation-result.ts";
import { classifyDelegationFailure } from "./delegation-failure-class.ts";
import { admitLeadReview, assembleUnreadableReviewRequest, candidateGapsOf, assembleLeadReview, MAX_REVIEW_TURNS, REVIEW_ACTION, REVIEW_OVERRIDE, withSpecDigests, type FailureBytes, type FlowUnderReview, type NoWritesLeft, type ReviewOrder, type SeenSpecs } from "./lead-review.ts";
import type { CoordinationTelemetryEvent, CoordinationTelemetryPort } from "./coordination-telemetry.ts";
import { PLAN_SNAPSHOT_KIND, type PlanSnapshotCandidate, type PlanSnapshotFlow, type PlanSnapshotKind, type PlanSnapshotPort } from "@kernel/ports/plan-snapshot.port.ts";
import { authorTask } from "./author-task.ts";
import { SIDEKICK_KIND, type SidekickKind } from "./sidekick-kinds.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import { evidenceFromEmptyRead, evidenceFromLessons, evidenceFromPackDataRoutes, type LessonFact } from "./evidence-from.ts";
import { createHash } from "node:crypto";
import type { DevStateGround } from "./dev-state-backing.ts";
import { observationConflictIn } from "./evidence-precedence.ts";
import { AUTHORING_FAILURE, authoringFailureFeedback, classifyAuthoringFailure, type AuthoringFailure } from "./authoring-failure.ts";
import { FanOutDispatcher, FLOW_RESULT, type TimerPort } from "./fan-out-dispatcher.ts";
import { aggregateFlowOutcomes, FLOW_OUTCOME, FLOW_OUTCOME_EFFECT, type AggregatedFlows, type FlowOutcome } from "./flow-outcomes.ts";
import { admitLeadPlan, LEAD_PLAN_KIND, PLAN_REJECTED, type AdmittedFlow, type AdmittedPlan } from "./lead-plan.ts";
import { leadPlanContract } from "./lead-plan.contract.ts";
import { SIDEKICK_AUTHORING, sidekickAuthoring, sidekickDeniedTools, type SidekickAuthoringMode } from "./sidekick-authoring.ts";
import type { SidekickExecutor, SidekickSession } from "./sidekick-executor.ts";
import { SESSION_GONE, turnEndOf } from "./sidekick-turn-end.ts";
import { describeUnreadable, describeUnreadableEntry, readsBetter, type UnreadableEntry } from "./answer-reading.ts";
import { packPagesFor, recordedRequestsFor } from "@contexts/generation/application/index.ts";
import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import type { HarnessFacts } from "@kernel/grounding.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { candidateFlowId, candidateFlowOf, maintenanceFlowId, maintenanceFlowOf, seedsNoCandidate, specNamedBy, uncoveredCandidateOf } from "./maintenance-flow.ts";
import { CORRECTION_ORIGIN, admitLeadCorrection, correctionPreamble, routeOfFinding, assembleLeadCorrection, assembleRefusedCorrection, type CorrectionOrigin, type CorrectionOrder, type CorrectionRebuttal, type FlowUnderCorrection, type CorrectionFinding } from "./lead-correction.ts";

/* The flow's slice of the Context Pack, as a brief field, or nothing when the pack did not read its pages. */
const pagesOf = (pack: string | undefined, routes: readonly string[]): { pages: string } | undefined => {
  const pages = packPagesFor(pack, routes);
  return pages === undefined ? undefined : { pages };
};


/* What a plan's drops are held to besides the candidate itself: the requests the run's capture recorded for a candidate's pages, as the Context Pack states them. */
const planFactsOf = (pack: string | undefined): PlanFacts => ({ recordedRequests: (candidate) => recordedRequestsFor(pack, candidatePagesOf(candidate)) });

/* The pages of the change's candidates, in the order they are offered: the baseline the plan snapshot keeps beside the per-candidate states. */
const changeRoutesOf = (input: { candidates?: readonly UseCaseCandidate[] }): string[] => pageRoutesOf(input.candidates ?? []);

/* Less than this of a flow's time left and a second attempt is not started; less than this of the run and a plan is not asked for. */
/* The specs of a candidate a plan snapshot keeps. */
const MAX_SNAPSHOT_SPECS = 3;

export const MIN_FLOW_MS = 60_000;

export interface LeadSidekicksDeps {
  /* Where every free-form string the lead, the briefs and the evidence carry is redacted. */
  redaction: RedactionPort;
  sidekick: Pick<SidekickExecutor, "open">;
  workspaces: DelegationWorkspacePort;
  timers: TimerPort;
  telemetry?: CoordinationTelemetryPort;
  /* Where the run keeps the plan it admitted and how its flows ended, for grading after the fact; absent: nothing is kept. */
  planSnapshots?: PlanSnapshotPort;
  now?: () => number;
  /* The spec a flow delivered, as it is in the run's working copy, read through the confined reader; absent or unreadable: the review shows none. */
  readSpec?(root: { mirrorDir: string; specDir: string }, specFile: string): Promise<string | undefined>;
  /* The spec file, relative to the spec directory, that a flow's id names. */
  specFileFor(flowId: string): string;
  /* The run's deadline as the agents' turns read it; a call may bring its own. Absent: nothing bounds the run's time. Its allowance is already net of what the phases after the current one are owed: coordination keeps no reserve of its own. */
  deadline?: { allowance(purpose?: DeadlinePurpose): number | null };
  /* The author's window and the working room its turn needs: a brief preloads the flow's changed code while it fits, and an admitted flow whose owned change alone does not fit is asked of the lead to split. Absent, or an unknown window: every owned hunk is preloaded and no flow is too large. */
  contextBudget?: ContextBudget;
  log?(text: string): void;
}

export interface CoordinateInput {
  runId: string;
  app: string;
  objective: string;
  mirrorDir: string;
  specDir: string;
  specRelDir: string;
  settings: CoordinationSettings;
  /* What the sidekicks would author with: whether the app has a login, and the runtime the sidekick role is assigned to; and the runtime the lead plans on, since only some runtimes can hold a planning turn to read-only. */
  facts: { hasLogin: boolean };
  closedLoop?: ClosedLoopHandle;
  agentBrowser?: AgentBrowserHandle;
  /* The run's authoring location, when the app declares one: a flow may name a place and each flow owns its own value. */
  geolocation?: GeolocationHandle;
  devBaseUrl?: string;
  /* The pages the run's Context Pack read with results: every sidekick's brief states them, and a flow's empty read of one is checked against them. */
  confirmedDataRoutes?: readonly { path: string; resultCount: number }[];
  /* What earlier runs' reads of DEV taught about pages: only a flow's brief states them, for the pages that flow visits; the lead and the reviewer are given none. */
  lessons?: readonly LessonFact[];
  /* The run's Context Pack: each flow's brief carries the Live DOM of the pages that flow visits. */
  contextPack?: string;
  /* What the suite's harness declares and the specs the suite holds: each flow's brief states them so its author need not open the harness files. */
  harnessFacts?: HarnessFacts;
  existingSpecs?: readonly string[];
  /* The use cases the change makes testable: the planning turn is told their pages, those no admitted flow visits are reported, and each flow's brief carries the evidence of the pages it visits. */
  candidates?: readonly UseCaseCandidate[];
  /* What the briefs quote of the change: the diff of each repo of the change, the anchor commit's subject, and the decisions on the changed lines of the first diff (the static listing of the run's own working copy). */
  change?: { diffs: readonly string[]; subject?: string; decisions?: readonly ChangedDecision[] };
  /* The run's deadline, when one is armed. */
  deadline?: { allowance(purpose?: DeadlinePurpose): number | null };
  /* The planning turn, asked for with the limits the plan will be held to. Absent: this run's generation cannot plan. */
  plan?: (planning: PlanningLimits) => Promise<PlanOutput>;
  signal?: AbortSignal;
}

export interface FlowProposals {
  flowId: string;
  changes: WorkspaceChange[];
  total: number;
}

export type CoordinateResult =
  /* No author sidekick can run: `refusal` is the code the run records (`AUTHORING_REFUSAL`), `reason` says why in words. The lead never authors in its place. */
  | { action: "refused"; refusal: string; reason: string; signal: CoordinationGateSignal }
  /* The lead declared that nothing is worth a test. */
  | { action: "noop"; reason: string; signal: CoordinationGateSignal }
  /* The flows were authored; `aggregated` says how it ended, as a generation would. */
  | { action: "fanout"; aggregated: AggregatedFlows; proposals: FlowProposals[]; signal: CoordinationGateSignal; pass?: CoordinatedPass; flowCandidates?: FlowCandidates[] };

/* The use cases a flow cites, by the spec it writes (relative to the spec directory); only ids the run derived. */
export interface FlowCandidates {
  specFile: string;
  candidates: string[];
}

/* What one correction turn came to: the specs taken back into the working copy, the lead's rebuttals, and the findings no flow was sent. */
export interface PassCorrection {
  readable: boolean;
  specs: string[];
  /* The source of each of `specs` as the working copy holds it, in the same order; absent when the pass cannot read specs. */
  specSources?: string[];
  rebuttals: CorrectionRebuttal[];
  /* The positions, among the findings the turn was given, of those no flow was sent. */
  unrouted: number[];
  /*
   * A sidekick's claim, on a correction of a failing execution, that its test is right and the app or the environment is not.
   * Only when no flow put new bytes in the working copy: a claim beside a change is not one. A claim, never evidence.
   */
  testCorrect?: { cause: "env" | "app"; reason: string };
}

export interface CorrectionTally {
  turns: number;
  routed: number;
  unrouted: number;
  revised: number;
  replaced: number;
  rebutted: number;
  /* Maintenance flows opened for findings that named a spec no flow of the plan owns; absent when there was none. */
  maintained?: number;
  /* Entries of the lead's correction answers and of the sidekicks' results in these turns that the reader could not read after their one repair turn, and the repair turns asked. */
  unreadable: number;
  repairs: number;
}

/*
 * A coordinated pass kept open after it delivered: the lead's planning session and every flow's sidekick session, workspace, loop
 * and location, for the corrections that follow: the static gate's, the execution's, the change-coverage's and the reviewer's.
 * Whoever holds it releases it, however the run ends.
 */
export interface CoordinatedPass {
  /* One correction turn over findings of one origin; the reviewer's when none is named. */
  correct(findings: readonly CorrectionFinding[], origin?: CorrectionOrigin): Promise<PassCorrection>;
  /* Findings the run does not send through the pass (its correction budget is spent): recorded and counted unrouted, never regenerated by a cold author. */
  leaveUnrouted(findings: readonly CorrectionFinding[], origin: CorrectionOrigin, reason: string): void;
  tally(): CorrectionTally;
  release(): Promise<void>;
}

interface FlowContext {
  input: CoordinateInput;
  mode: SidekickAuthoringMode;
  /* What the reader could not read of the sidekicks' results over the whole pass (the first turns, the lead's revisions, the corrections), after their one repair turn each, and the repair turns asked. */
  unreadable: { delegation: number; repairs: number };
  /* The lessons the briefs of the pass opened a session with, each once (kind, page, digest of the line stated). */
  lessonsDelivered: Map<string, LessonDelivery>;
}

interface FlowReport {
  outcome: FlowOutcome;
  proposals: FlowProposals | undefined;
}

/* A flow while the coordinated pass lasts: its workspace, loop, location and sidekick session are kept for the lead's review and released when the pass ends. */
interface LiveFlow {
  flow: AdmittedFlow;
  delegationId: string;
  workspace: DelegationWorkspace;
  request: DelegationWorkspaceRequest;
  loop?: FlowLoopHandle;
  /* Set when the run held run_spec but the app allows no writes to DEV, so the flow got no loop. */
  writesWithheld?: true;
  geolocation?: FlowGeolocationHandle;
  session?: SidekickSession;
  turns: number;
  last?: DelegationResult;
  /* Whether a turn of the flow ever put its spec in the working copy: those bytes stay there whatever a later turn does. */
  delivered: boolean;
  /* Whether the flow's last turn put its spec in the working copy. */
  taken?: boolean;
  /* Set when the pass released the flow: a turn that answers after it changes nothing and leaves nothing open. */
  released?: boolean;
  /* How many sessions the flow has begun to open: a session that returns when a newer one was begun is stale. */
  opens: number;
  appDefect?: string;
  failure?: AuthoringFailure;
  conflict?: string;
  refusal?: string;
}

/* What the plan came to against the change's use cases: the set it had to answer for and how it answered. */
interface PlanDecision {
  admission: AdmissionSet;
  coverage: PlanCoverage;
}

interface ReviewTally {
  turns: number;
  accepted: number;
  revised: number;
  replaced: number;
  dropped: number;
  refused: number;
  /* Entries of the review answers the reader could not read after the one repair turn, and the repair turns asked. */
  unreadable: number;
  repairs: number;
  /* Orders the lead gave and the orchestrator admitted that were not carried out: the run had no room left, or the flow holds nothing to carry them out in. */
  notCarriedOut: number;
}

export class LeadSidekicks {
  private readonly dispatcher: FanOutDispatcher;
  private readonly now: () => number;

  constructor(private readonly deps: LeadSidekicksDeps) {
    this.dispatcher = new FanOutDispatcher({ timers: deps.timers });
    this.now = deps.now ?? Date.now;
  }

  /* Removes the workspaces a crashed run left. */
  async sweep(): Promise<number> {
    return this.deps.workspaces.sweepAll();
  }

  async coordinate(input: CoordinateInput): Promise<CoordinateResult> {
    const base = { flows: 0, delivered: 0, incomplete: 0 } as const;
    const refuse = (refusal: string, reason: string, extra: Partial<CoordinationGateSignal> = {}): CoordinateResult => {
      this.deps.log?.(`coordination: no author sidekick can run (${refusal}): ${reason}`);
      return { action: "refused", refusal, reason, signal: { ...base, refusal, ...extra } };
    };

    if (!input.plan) return refuse(AUTHORING_REFUSAL.CANNOT_PLAN, "the generation cannot plan");
    const authoring = sidekickAuthoring({
      hasLogin: input.facts.hasLogin,
      runSpecGranted: input.closedLoop !== undefined,
      browserGranted: input.agentBrowser !== undefined,
    });
    if (authoring.mode === SIDEKICK_AUTHORING.EXCLUDED) return refuse(AUTHORING_REFUSAL.NO_AUTHOR_GRANT, authoring.reason ?? "no sidekick can author", { authoring: SIDEKICK_AUTHORING.EXCLUDED });
    const authoringName = authoring.mode;

    const { settings } = input;
    const parallel = Math.min(settings.maxParallel, authoring.maxParallel ?? settings.maxParallel);
    const before = this.allowance(input);
    if (before !== undefined && before < settings.planBudgetMs + MIN_FLOW_MS * 2) {
      return refuse(AUTHORING_REFUSAL.NO_TIME, "too little of the run is left to plan and author in parallel", { authoring: authoringName });
    }

    await this.sweep().catch((err: unknown) => engineLog.error(`[qa] sweeping the delegation workspaces failed (the run goes on): ${err instanceof Error ? err.message : String(err)}`));
    const locations = input.geolocation?.placeNames() ?? [];
    const admission = admissionSetOf(input.candidates);
    const change = changeViewOf(input.change?.diffs, input.candidates);
    const candidateSlices = change && admission.required.length > 0 ? candidateSlicesOf(change, admission.required) : undefined;
    /* The capacity the plan is told, as it will stand once the planning turn has taken its time. */
    const capacity = this.capacity(input, parallel, before === undefined ? undefined : before - settings.planBudgetMs);
    const planned = await input.plan({
      ...(capacity !== undefined ? { capacity } : {}),
      maxParallel: parallel,
      flowBudgetMs: settings.flowBudgetMs.opencode,
      budgetMs: settings.planBudgetMs,
      ...(locations.length > 0 ? { locations } : {}),
      ...(admission.required.length > 0 ? { candidates: admission.required } : {}),
      ...(admission.others > 0 ? { otherCandidates: admission.others } : {}),
      ...(candidateSlices ? { candidateSlices } : {}),
      ...(input.change?.decisions?.length ? { decisions: input.change.decisions } : {}),
      submit: leadPlanContract((answer) => this.admit(input, answer, parallel)),
    });
    /* The lead's planning session, when the plan kept it: its review of the flows is asked there, and it ends with the pass. */
    let leadHanded = false;
    try {
      if (planned.timedOut) return refuse(AUTHORING_REFUSAL.PLAN_TIMED_OUT, "the planning turn ran out of its time", { authoring: authoringName });
      if (planned.noSubmission !== undefined) this.record(input, { kind: "lead-decision", reason: `plan: ${planned.noSubmission}`.slice(0, 1_000) });
      let admitted = this.admit(input, planned.plan, parallel);
      let coverage: PlanCoverage = { covered: [], dropped: [], unresolved: [] };
      if (admitted.kind === LEAD_PLAN_KIND.FANOUT || (admitted.kind === LEAD_PLAN_KIND.NOOP && admitted.dropped !== undefined)) {
        /* A plan is held to the facts once: a drop they contradict returns it to the lead with the fact; what the lead keeps after that is its decision. */
        coverage = planCoverage({ flows: admitted.kind === LEAD_PLAN_KIND.FANOUT ? admitted.flows : [], dropped: admitted.dropped ?? [] }, admission.required, planFactsOf(input.contextPack));
        const amended = await this.amendPlan(input, planned.lead, admitted, coverage, admission, parallel, change);
        admitted = amended.plan;
        coverage = honorContradictedDrops(amended.coverage);
        this.reportContradicted(input, coverage);
      }
      const unreadable = admitted.kind === LEAD_PLAN_KIND.FANOUT || admitted.kind === LEAD_PLAN_KIND.NOOP ? admitted.unreadable ?? [] : [];
      if (unreadable.length > 0) this.recordUnreadable(input, "plan", unreadable, false, "plan: the plan that stands holds entries the reader could not read; they are not acted on, and a use case one of them named is left unresolved");
      const contradicted = contradictionsOf(coverage);
      /* What the amendment turn could not settle about the flows: those still past the capacity are not authored, those still too large are authored with references. */
      const flowFacts = admitted.kind === LEAD_PLAN_KIND.FANOUT ? this.flowAmendment(admitted, change, input) : {};
      const notAdmitted = flowFacts.notAdmitted?.map((flow) => flow.id) ?? [];
      const oversize = flowFacts.oversize?.map((flow) => flow.id) ?? [];
      this.reportFlowsUnsettled(input, flowFacts);
      const withContradictions = {
        ...base,
        ...unreadableSignal(unreadable.length, { delegation: 0, repairs: 0 }),
        ...(contradicted.length > 0 ? { dropsContradicted: contradicted } : {}),
        ...(flowFacts.capacity !== undefined ? { capacity: flowFacts.capacity } : {}),
        ...(notAdmitted.length > 0 ? { notAdmitted } : {}),
        ...(oversize.length > 0 ? { oversize } : {}),
      };
      this.record(input, {
        kind: "proposal",
        action: admitted.kind === LEAD_PLAN_KIND.FANOUT ? "delegate" : "direct",
        reason: describePlan(admitted),
        ...(admitted.kind === LEAD_PLAN_KIND.NOOP && admitted.dropped && admitted.dropped.length > 0 ? { dropBases: [...new Set(admitted.dropped.map((d) => d.basis))], dropContradicted: contradicted.length > 0 } : {}),
        ...(flowFacts.capacity !== undefined ? { capacity: flowFacts.capacity } : {}),
        ...(notAdmitted.length > 0 ? { notAdmitted } : {}),
        ...(oversize.length > 0 ? { oversize } : {}),
      });
      if (admitted.kind === LEAD_PLAN_KIND.NOOP) {
        this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.NOOP, [], admitted.reason, undefined, contradicted.length > 0 ? { admission, coverage } : undefined);
        return { action: "noop", reason: admitted.reason, signal: { ...withContradictions, plan: LEAD_PLAN_KIND.NOOP, authoring: authoringName } };
      }
      if (admitted.kind === PLAN_REJECTED) {
        this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.REJECTED, [], admitted.downgrade);
        return refuse(`${AUTHORING_REFUSAL.PLAN_REJECTED}:${admitted.downgrade}`, `the plan was not admitted (${admitted.downgrade})`, { authoring: authoringName });
      }
      this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.FANOUT, admitted.flows, undefined, undefined, { admission, coverage });
      this.reportUnplanned(input, coverage);
      const result = await this.fanOut(input, admitted.flows, admitted.parallel, { mode: authoring.mode, ...(planned.lead ? { lead: planned.lead } : {}) }, { ...withContradictions, plan: LEAD_PLAN_KIND.FANOUT, authoring: authoringName }, { admission, coverage });
      /* A pass kept open holds the lead's session from here on. */
      if (result.action === "fanout" && result.pass) leadHanded = true;
      return result;
    } finally {
      if (!leadHanded) await planned.lead?.dispose().catch((err: unknown) => engineLog.error(`[qa] closing the lead's session failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /* The plan the lead emitted, held to the run's limits and the time left now. */
  private admit(input: CoordinateInput, raw: unknown, parallel: number): AdmittedPlan {
    const { settings } = input;
    const remaining = this.allowance(input);
    const loop = input.closedLoop?.limits;
    return admitLeadPlan(
      raw,
      {
        ...(settings.maxFlows !== undefined ? { ceiling: settings.maxFlows } : {}),
        maxParallel: parallel,
        flowBudgetMs: settings.flowBudgetMs.opencode,
        ...(remaining !== undefined ? { allowanceMs: remaining } : {}),
        minFlowMs: MIN_FLOW_MS,
        /* Each flow is granted the calls its time can run; the run's call totals are the sum of those grants unless the app set a ceiling. */
        ...(loop ? { runSpecPerCallMs: loop.perCallMs, runSpecDevWrites: loop.maxDevWrites, ...(loop.callsCeiling !== undefined ? { runSpecCallsCeiling: loop.callsCeiling } : {}) } : {}),
        ...(input.agentBrowser ? { browserPerCallMs: input.agentBrowser.limits.perCallMs } : {}),
      },
      {
        redaction: this.deps.redaction,
        specRelDir: input.specRelDir,
        specFileFor: this.deps.specFileFor,
        ...(input.geolocation ? { places: input.geolocation.facts().places } : {}),
      },
    );
  }

  /*
   * The one amendment turn: a plan, of flows or of none, that leaves use cases unresolved (a drop the facts contradict or the reader
   * could not read among them), names flows past the
   * run's capacity, or admits a flow too large for one author goes back to the lead in its open session, once (`MAX_PLAN_ROUNDS`),
   * with every one of those facts in the same request. Its answer replaces the plan only when it is a flow plan the run admits;
   * otherwise, and when no session, time or round is left, the plan stands and what is still unsettled is recorded (unplanned use
   * cases, flows not admitted, flows too large). Never a refusal, never a second round.
   */
  private async amendPlan(
    input: CoordinateInput,
    lead: LeadSessionHandle | undefined,
    first: Extract<AdmittedPlan, { kind: typeof LEAD_PLAN_KIND.FANOUT | typeof LEAD_PLAN_KIND.NOOP }>,
    firstCoverage: PlanCoverage,
    admission: AdmissionSet,
    parallel: number,
    change: ChangeView | undefined,
  ): Promise<{ plan: AdmittedPlan; coverage: PlanCoverage }> {
    const stands = { plan: first as AdmittedPlan, coverage: firstCoverage };
    const flows = first.kind === LEAD_PLAN_KIND.FANOUT ? this.flowAmendment(first, change, input) : {};
    /* A plan of no flows is asked again as a plan of flows is: for every use case it leaves unresolved (a drop the facts contradict, a drop the reader could not read, a use case it names nowhere). A no-op whose drops all read and stand is not asked again. */
    const needed = needsAmendment(firstCoverage.unresolved, flows);
    if (!needed || !lead || MAX_PLAN_ROUNDS < 2 || input.signal?.aborted) return stands;
    const { settings } = input;
    const left = this.allowance(input);
    const asked = amendmentSummary(firstCoverage, flows);
    if (left !== undefined && left < settings.planBudgetMs + MIN_FLOW_MS * 2) {
      this.record(input, { kind: "lead-decision", reason: `plan: ${asked} and too little of the run is left to ask the lead again` });
      return stands;
    }
    this.record(input, { kind: "lead-decision", reason: `plan: asking the lead once more, in one amendment turn, about ${asked}` });
    let answered: Awaited<ReturnType<LeadSessionHandle["askForPlan"]>>;
    try {
      const slices = change && admission.required.length > 0 ? { slices: candidateSlicesOf(change, firstCoverage.unresolved) } : {};
      /* The capacity is the one the answer will be admitted under, once this turn has taken its time, as the planning turn was told its own. */
      const capacity = this.capacity(input, parallel, left === undefined ? undefined : left - settings.planBudgetMs);
      /* One capacity per request: the flows it lists as past the capacity are the plan's flows past that same capacity, not past the one the first plan was cut at. */
      const stated = capacity === undefined ? flows : { ...flows, capacity, ...(first.kind === LEAD_PLAN_KIND.FANOUT ? { notAdmitted: [...first.flows, ...first.notAdmitted].slice(capacity).map(({ id, objective, candidates }) => ({ id, objective, candidates })) } : {}) };
      const request = assembleReplanRequest(this.deps.redaction, firstCoverage.unresolved, firstCoverage.refused, { ...stated, admitted: first.kind === LEAD_PLAN_KIND.FANOUT ? first.flows.length : 0, ...slices });
      answered = await lead.askForPlan(request.text, planTurnOpts(request, settings.planBudgetMs, left));
    } catch (err) {
      if (isRunDeadlineError(err)) throw err;
      this.record(input, { kind: "lead-decision", reason: `plan: the lead's second plan turn failed (${err instanceof Error ? err.message : String(err)}); the first plan stands` });
      return stands;
    }
    if (answered.noSubmission !== undefined) this.record(input, { kind: "lead-decision", reason: `plan: the amendment turn delivered no accepted plan (${answered.noSubmission})`.slice(0, 1_000) });
    if (input.signal?.aborted) return stands;
    const second = answered.plan !== undefined ? this.admit(input, answered.plan, parallel) : undefined;
    /* A plan of flows, or a plan that drops every use case, which the facts must now allow. */
    const answer = second?.kind === LEAD_PLAN_KIND.FANOUT ? second : second?.kind === LEAD_PLAN_KIND.NOOP && second.dropped !== undefined && first.kind === LEAD_PLAN_KIND.NOOP ? second : undefined;
    if (answer === undefined) {
      this.record(input, { kind: "lead-decision", reason: "plan: the lead's second answer was not a plan of flows the run admits; the first plan stands" });
      return stands;
    }
    return { plan: answer, coverage: planCoverage({ flows: answer.kind === LEAD_PLAN_KIND.FANOUT ? answer.flows : [], dropped: answer.dropped ?? [] }, admission.required, planFactsOf(input.contextPack)) };
  }

  /* The flows of an admitted plan: each authored once, then reviewed by the lead, then added up. Every flow's resources end here, however the pass ends. */
  private async fanOut(input: CoordinateInput, flows: AdmittedFlow[], parallel: number, how: { mode: SidekickAuthoringMode; lead?: LeadSessionHandle }, base: CoordinationGateSignal, decided: PlanDecision): Promise<CoordinateResult> {
    const context: FlowContext = { input, mode: how.mode, unreadable: { delegation: 0, repairs: 0 }, lessonsDelivered: new Map() };
    const live = new Map<string, LiveFlow>();
    const reports = new Map<string, FlowReport>();
    let handed = false;
    try {
      const results = await this.dispatcher.run(flows, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (flow, signal) => this.author(flow, context, live, signal));
      await this.settle(input, results, live, reports);

      const tally: ReviewTally = { turns: 0, accepted: 0, revised: 0, replaced: 0, dropped: 0, refused: 0, unreadable: 0, repairs: 0, notCarriedOut: 0 };
      if (how.lead && !input.signal?.aborted) await this.review(how.lead, flows, parallel, context, live, reports, tally, decided);

      const outcomes = flows.map((flow) => reports.get(flow.id)?.outcome ?? { id: flow.id, kind: FLOW_OUTCOME.FAILED, reason: "no attempt could be made" });
      const proposals = flows.flatMap((flow) => {
        const p = reports.get(flow.id)?.proposals;
        return p && p.total > 0 ? [p] : [];
      });
      const aggregated = aggregateFlowOutcomes(outcomes);
      const overWindow = outcomes.filter((o) => o.kind === FLOW_OUTCOME.OVER_WINDOW).map((o) => o.id);
      const known = new Set((input.candidates ?? []).map((c) => c.id));
      const flowCandidates = flows.map((flow) => ({ specFile: flow.specFile, candidates: flow.candidates.filter((id) => known.has(id)) }));
      this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.FANOUT, flows, undefined, outcomes, decided, new Map([...live].flatMap(([id, entry]) => (entry.last?.candidates ? [[id, entry.last.candidates] as const] : []))));
      const signal: CoordinationGateSignal = {
        ...base,
        flows: flows.length,
        delivered: outcomes.filter((o) => o.kind === FLOW_OUTCOME.DELIVERED).length,
        incomplete: aggregated.incompleteFlows.length,
        ...(overWindow.length > 0 ? { overWindow } : {}),
        ...(tally.turns > 0 ? { review: tally } : {}),
        ...unreadableSignal(base.unreadable?.plan ?? 0, context.unreadable),
        ...(context.lessonsDelivered.size > 0 ? { lessonsDelivered: [...context.lessonsDelivered.values()] } : {}),
        specPages: flows.map((flow) => ({ spec: flow.specFile, routes: [...new Set(flow.routes.map(pagePathname))] })),
        ...runSpecFailureReadsOf(live),
      };
      for (const p of proposals) this.deps.log?.(`coordination: flow ${p.flowId} changed ${p.total} file(s) it was not given to write; they are proposals and were not applied`);

      /* With the lead's session the pass is kept open for the reviewer's corrections; its holder releases it. */
      if (how.lead && !input.signal?.aborted && aggregated.end === GENERATION_END.DELIVERED) {
        handed = true;
        return { action: "fanout", aggregated, proposals, signal, pass: this.passOf(how.lead, flows, parallel, context, live, signal), flowCandidates };
      }
      return { action: "fanout", aggregated, proposals, signal, flowCandidates };
    } finally {
      if (!handed) for (const entry of live.values()) await this.release(entry);
    }
  }

  /*
   * What each dispatched turn came to, as the flow's report. A flow's session is ended here only when the run was cancelled or the
   * runtime says the session is gone: a flow out of its time, or met by a fault outside its turn, keeps its idle session for the
   * lead's next order, and the pass's release ends it.
   */
  private async settle(input: CoordinateInput, results: ReadonlyArray<{ id: string; status: string; value?: FlowReport; error?: unknown }>, live: Map<string, LiveFlow>, reports: Map<string, FlowReport>): Promise<void> {
    for (const result of results) {
      switch (result.status) {
        case FLOW_RESULT.SETTLED:
          reports.set(result.id, result.value!);
          continue;
        case FLOW_RESULT.TIMED_OUT:
          /* The flow's time is spent, not its session: it is idle and aborted, the lead may still revise it, and the pass release closes it. */
          reports.set(result.id, this.keepDelivered(live.get(result.id), { outcome: { id: result.id, kind: FLOW_OUTCOME.TIMED_OUT }, proposals: undefined }));
          continue;
        case FLOW_RESULT.ABORTED:
          reports.set(result.id, this.keepDelivered(live.get(result.id), { outcome: { id: result.id, kind: FLOW_OUTCOME.FAILED, reason: "the run was cancelled" }, proposals: undefined }));
          break;
        case FLOW_RESULT.THREW:
          /* The run's own time spent ends the run, not a flow. */
          if (isRunDeadlineError(result.error)) throw result.error;
          engineLog[levelOfEffect(FLOW_OUTCOME_EFFECT[FLOW_OUTCOME.FAILED])](`[qa] flow ${result.id} failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
          this.recordFlowFault(input, live.get(result.id), result.id, result.error);
          reports.set(result.id, this.keepDelivered(live.get(result.id), { outcome: { id: result.id, kind: FLOW_OUTCOME.FAILED, reason: "the sidekick's session failed" }, proposals: undefined }));
          if (!input.signal?.aborted && turnEndOf(result.error).kind !== SESSION_GONE) continue;
          break;
      }
      await this.closeSession(live.get(result.id));
    }
  }

  /* A flow whose sidekick's session failed outside a turn's answer (it could not be opened, or the flow was stopped under it): said in the run's decisions with the typed end of the fault, never only in the log. */
  private recordFlowFault(input: CoordinateInput, entry: LiveFlow | undefined, flowId: string, error: unknown): void {
    const end = turnEndOf(error, input.signal);
    this.record(input, {
      kind: "delegation",
      action: "delegate",
      sidekickKind: entry?.flow.kind ?? SIDEKICK_KIND.AUTHOR,
      reason: `flow ${flowId}: the sidekick's session failed (${end.kind}${end.errorType !== undefined ? `, ${end.errorType}` : ""})`.slice(0, 400),
      flowId,
      ...(entry ? { delegationId: entry.delegationId, attempt: entry.turns } : {}),
      failureClass: "failed",
      turnEnd: end.kind,
      ...(end.errorType !== undefined ? { errorType: end.errorType } : {}),
    });
  }

  /* The flow's first turn: its workspace, loop, location and browser share, and the sidekick's session on the brief. */
  private async author(flow: AdmittedFlow, context: FlowContext, live: Map<string, LiveFlow>, signal: AbortSignal): Promise<FlowReport> {
    const { input } = context;
    const delegationId = `${input.runId}-flow-${flow.id}`;
    const request: DelegationWorkspaceRequest = {
      runId: input.runId,
      delegationId,
      mirrorDir: input.mirrorDir,
      specDir: input.specDir,
      specRelDir: input.specRelDir,
      writablePaths: flow.writablePaths,
    };
    const workspace = await this.deps.workspaces.create(request);
    /* A flow stopped while its workspace was being made: the pass may already have released what it holds. */
    if (signal.aborted) {
      await this.deps.workspaces.dispose(workspace);
      throw new Error(`flow ${flow.id} was stopped before it started`);
    }
    const geolocation = input.geolocation?.openFlow(delegationId, flow.location);
    const entry: LiveFlow = { flow, delegationId, workspace, request, turns: 0, opens: 0, delivered: false, ...(geolocation ? { geolocation } : {}) };
    live.set(flow.id, entry);
    const probePath = `${PROBE_REL_DIR}/${posix.basename(flow.specFile)}`;
    if (input.closedLoop && flow.runSpecCalls > 0) {
      /* A flow's share is 0 only when the app allows no writes to DEV at all; every other flow gets its loop, and the run's one write ledger refuses writes once the run's cap is spent. */
      const loop = flow.runSpecDevWrites > 0
        ? input.closedLoop.openFlow({
            delegationId,
            flowId: flow.id,
            limits: { maxCalls: flow.runSpecCalls, maxDevWrites: flow.runSpecDevWrites },
            workspace: { dir: workspace.dir, specDir: workspace.specDir },
            specFile: flow.specFile,
            stage: async () => ((await this.deps.workspaces.stage(workspace, request, flow.writablePaths[0]!, probePath)) ? probePath : undefined),
          })
        : undefined;
      if (loop) entry.loop = loop;
      else if (flow.runSpecDevWrites === 0) {
        entry.writesWithheld = true;
        this.record(input, { kind: "lead-decision", flowId: flow.id, delegationId, reason: `flow ${flow.id}: no run_spec loop, the app allows no requests that write to DEV` });
      }
    }
    if (context.mode === SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER && input.agentBrowser && flow.browserCalls > 0) {
      input.agentBrowser.grantShare(delegationId, flow.browserCalls);
    }
    return this.freshTurn(entry, context, signal, flow.budgetMs);
  }

  /*
   * A fresh sidekick session on the flow's brief, and what its turn came to. A brief still over the author's known window with all
   * its change named by reference is not sent: the flow ends over-window, recorded with the numbers it was judged by.
   */
  private async freshTurn(entry: LiveFlow, context: FlowContext, signal: AbortSignal, timeoutMs: number, feedback?: string): Promise<FlowReport> {
    const { brief, sent, contextFit, fit } = this.briefOf(entry, context);
    if (contextFit?.outcome === "over") return this.overWindow(entry, context.input, contextFit);
    const result = await this.openSession(entry, context, brief, sent, contextFit, fit, signal, timeoutMs, feedback);
    return this.assess(entry, context, result, signal);
  }

  /* The flow whose minimal brief does not fit: nothing is sent, the decision is recorded, and a spec it delivered earlier stays delivered. */
  private overWindow(entry: LiveFlow, input: CoordinateInput, fit: ContextFit): FlowReport {
    const { flow } = entry;
    const reason = `its brief, with all its change named by reference and its suite listing and pages given up to the window, is ${fit.promptTokens} tokens and its turn needs ${fit.workingRoomTokens ?? 0} tokens of working room, over the author's window of ${fit.windowTokens ?? 0} tokens; it was not sent`;
    engineLog[levelOfEffect(FLOW_OUTCOME_EFFECT[FLOW_OUTCOME.OVER_WINDOW])](`[qa] flow ${flow.id}: ${reason}`);
    this.record(input, { kind: "lead-decision", flowId: flow.id, overWindow: [flow.id], contextFit: fit, delegationId: entry.delegationId, reason: `flow ${flow.id}: ${reason}` });
    return this.keepDelivered(entry, { outcome: { id: flow.id, kind: FLOW_OUTCOME.OVER_WINDOW, reason }, proposals: undefined });
  }

  /* A fresh sidekick session on the brief, with the feedback when there is some; the session is kept on the flow. */
  private async openSession(entry: LiveFlow, context: FlowContext, brief: DelegationBrief, sent: string, contextFit: ContextFit | undefined, fit: ((bytes: number) => WindowFitOutcome) | undefined, signal: AbortSignal, timeoutMs: number, feedback?: string): Promise<DelegationResult> {
    const seq = ++entry.opens;
    const session = await this.deps.sidekick.open(brief, {
      cwd: entry.workspace.dir,
      kind: entry.flow.kind,
      keepUnanswered: true,
      signal,
      timeoutMs: Math.max(1, timeoutMs),
      timeLimit: "flow-budget",
      delegationId: entry.delegationId,
      denyTools: sidekickDeniedTools(context.mode, entry.loop !== undefined),
      devStateGround: () => devStateGroundOf(entry, context.input),
      ...(contextFit ? { contextFit } : {}),
      ...(fit ? { fit } : {}),
      ...(feedback ? { feedback } : {}),
    });
    noteLessonsDelivered(context, this.deps.redaction, sent, brief);
    /* A session that opened after its pass released the flow, or after a newer one was begun for it, belongs to nobody: it is closed at once. */
    if (entry.released || entry.opens !== seq) {
      await session.dispose().catch((err: unknown) => engineLog.error(`[qa] closing flow ${entry.flow.id}'s late session failed: ${err instanceof Error ? err.message : String(err)}`));
      throw new Error(`flow ${entry.flow.id}'s session opened after the flow was stopped`);
    }
    /* A flow stopped while its first turn ran (its time, the run's cancel) keeps the idle session: the lead may still revise it, and the pass releases it (the pass or this fan-out's `finally`, which holds every live flow). */
    if (signal.aborted) {
      entry.session = session;
      throw new Error(`flow ${entry.flow.id}'s session opened after the flow was stopped`);
    }
    entry.session = session;
    return session.first;
  }

  /*
   * The flow author's brief: the flow's slice of the change, its own pages' facts and the tools its turn grants. The slice's owned
   * hunks are preloaded while the whole brief fits the author's window; what does not fit is named
   * by file and range. The fit it was judged by rides on the turn's telemetry.
   */
  /* `sent` is the text the brief renders to under the fit rule it is judged by: the one render its lessons' delivery is decided from. */
  private briefOf(entry: LiveFlow, context: FlowContext): { brief: DelegationBrief; sent: string; contextFit?: ContextFit; fit?: (bytes: number) => WindowFitOutcome } {
    const { input, mode } = context;
    const { flow } = entry;
    const browser = mode === SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER && input.agentBrowser !== undefined;
    const tools = [
      "read",
      ...(flow.writablePaths.length > 0 ? ["write"] : []),
      ...(entry.loop ? ["run_spec"] : []),
      ...(browser ? ["authbrowser"] : []),
      ...(mode === SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER ? ["playwright"] : []),
      ...(entry.geolocation ? ["set_geolocation"] : []),
    ];
    const derived = briefChangeFor(flow, input.candidates, {
      diffs: input.change?.diffs ?? [],
      ...(input.change?.subject !== undefined ? { subject: input.change.subject } : {}),
      ...(input.change?.decisions !== undefined ? { decisions: input.change.decisions } : {}),
    });
    const build = (change: BriefChange | undefined): DelegationBrief =>
      createDelegationBrief({
        redaction: this.deps.redaction,
        delegationId: entry.delegationId,
        runId: input.runId,
        objective: flow.objective,
        task: authorTask(flow, entry.loop, browser ? input.agentBrowser!.limits.perCallMs : undefined, entry.geolocation, entry.writesWithheld === true),
        acceptanceCriteria: flow.acceptance,
        scope: { readablePaths: ["."], writablePaths: flow.writablePaths, allowedCommands: [] },
        knownFacts: [...knownFactsOf(this.deps.redaction, input, flow.routes), ...lessonFactsOf(this.deps.redaction, input, flow.routes)],
        tools,
        ...(pagesOf(input.contextPack, flow.routes) ?? {}),
        ...(input.harnessFacts ? { harnessFacts: input.harnessFacts, specRelDir: input.specRelDir } : {}),
        ...(input.existingSpecs?.length ? { suite: input.existingSpecs } : {}),
        ...(derived.candidates.length > 0 ? { candidates: derived.candidates } : {}),
        ...(change ? { change } : {}),
        ...(input.devBaseUrl ? { artifactRefs: [{ id: "dev-base-url", path: input.devBaseUrl }] } : {}),
      });
    const budget = this.deps.contextBudget;
    if (!budget) {
      const brief = build(derived.change);
      return { brief, sent: assembleSidekickBrief(this.deps.redaction, brief).text };
    }
    const fitOf = (bytes: number): ContextFit => budget.fit({ prompt: { bytes }, role: "author" });
    const fit = (bytes: number): WindowFitOutcome => fitOf(bytes).outcome;
    /* The owned hunks give way first, judged on the whole brief; once they are all references, the sections that can (the suite listing, then the flow's pages) give way to the window as the brief is rendered, and the fit it is sent with is the one it comes to then. */
    const measure = (change: BriefChange | undefined): ContextFit => fitOf(Buffer.byteLength(assembleSidekickBrief(this.deps.redaction, build(change)).text, "utf8"));
    const rendered = (brief: DelegationBrief): { sent: string; contextFit: ContextFit } => {
      const { text } = assembleSidekickBrief(this.deps.redaction, brief, fit);
      return { sent: text, contextFit: fitOf(Buffer.byteLength(text, "utf8")) };
    };
    if (!derived.change) {
      const brief = build(undefined);
      return { brief, ...rendered(brief), fit };
    }
    const fitted = fitBriefChange(derived.change, measure);
    const brief = build(fitted.change);
    const { sent, contextFit } = rendered(brief);
    if (fitted.referenced > 0 && contextFit.outcome !== "over") {
      engineLog.warn(`[qa] flow ${flow.id}'s brief fits the author's window with ${fitted.referenced} owned hunk(s) named by file and range instead of preloaded (${fitted.change.hunks.length} preloaded)`);
    }
    return { brief, sent, contextFit, fit };
  }

  /* What one turn of a sidekick came to, from what the orchestrator sees: the workspace, the flow's run_spec ledger and the Context Pack's reads. */
  private async assess(entry: LiveFlow, context: FlowContext, result: DelegationResult, signal: AbortSignal): Promise<FlowReport> {
    const { input } = context;
    const { flow, delegationId } = entry;
    const sidekickKind = flow.kind;
    entry.turns += 1;
    entry.last = result;
    const attempt = entry.turns;
    /* A session the runtime says is gone is ended; any other turn that did not answer leaves its session to the lead's next order. */
    if (result.turnEnd?.kind === SESSION_GONE) await this.closeSession(entry);
    const eligible = result.status === "completed" || result.status === "completed-with-concerns";
    let copied = false;
    let proposals: FlowProposals | undefined;
    /* Whether the workspace shows the sidekick changed no file at all: its own list of what it changed is its word, this is what is on disk. */
    let workspaceUntouched = false;
    entry.refusal = undefined;
    /* What the sidekick wrote is taken back whatever its turn ended in (an answer that could not be read included): its status is its word, and the run's static gate, execution and review judge the bytes. */
    if (!signal.aborted && !entry.released) {
      const collected = await this.deps.workspaces.collect(entry.workspace, entry.request);
      copied = collected.copied.length > 0;
      entry.refusal = collected.refused[0] ? `${collected.refused[0].path}: ${collected.refused[0].reason}` : undefined;
      workspaceUntouched = collected.proposalsTotal === 0;
      if (collected.proposalsTotal > 0) proposals = { flowId: flow.id, changes: collected.proposals, total: collected.proposalsTotal };
    }
    if ((result.unreadableEntries?.length ?? 0) > 0 || result.repaired === true) {
      const left = result.unreadableEntries ?? [];
      context.unreadable.delegation += left.length;
      if (result.repaired === true) context.unreadable.repairs += 1;
      this.recordUnreadable(input, "delegation", left, result.repaired === true, `flow ${flow.id} turn ${attempt}: ${left.length} part(s) of the sidekick's answer left unread${result.repaired === true ? " after asking it once more" : ""}, and not acted on`, { flowId: flow.id, delegationId, attempt });
    }
    const failureClass = classifyDelegationFailure(result.status, result.filesChanged.length, copied ? 1 : 0, result.readMiss);
    const { loop } = entry;
    const ledger = loop?.ledger() ?? [];
    const lastCall = ledger.at(-1);
    this.record(input, {
      kind: "delegation",
      action: "delegate",
      sidekickKind,
      reason: result.readMiss ? `flow ${flow.id} turn ${attempt}: sidekick answer ${result.readMiss}${copied ? ", file taken back" : ""}` : result.turnEnd ? `flow ${flow.id} turn ${attempt}: the turn did not answer (${result.turnEnd.kind}${result.turnEnd.errorType !== undefined ? `, ${result.turnEnd.errorType}` : ""})${copied ? ", file taken back" : ""}` : `flow ${flow.id} turn ${attempt}: sidekick status=${result.status}${copied ? ", file taken back" : ""}`,
      delegationId,
      attempt,
      flowId: flow.id,
      ...(flow.candidates.length > 0 ? { candidateIds: flow.candidates } : {}),
      ...(failureClass ? { failureClass } : {}),
      sidekickStatus: result.readMiss ?? result.status,
      ...(result.turnEnd ? { turnEnd: result.turnEnd.kind, ...(result.turnEnd.errorType !== undefined ? { errorType: result.turnEnd.errorType } : {}) } : {}),
      ...(lastCall ? { lastRunSpec: lastCall.status } : {}),
    });

    entry.taken = copied;
    /* What the flow's last run_spec call met, from the facts the orchestrator kept of it. */
    const failure = lastCall?.status === "failed" ? classifyAuthoringFailure(lastCall.failures) : undefined;
    entry.failure = failure;
    /* The app at fault: the spec is right to fail and is never sent back to be made green; the run's own execution reports the defect from the bytes taken back, and with no bytes the flow ends on it. */
    const appDefect = failure?.kind === AUTHORING_FAILURE.APP_DEFECT ? `app defect: ${failure.reason}` : undefined;
    if (appDefect) entry.appDefect = failure!.reason;
    if (copied) {
      entry.delivered = true;
      if (appDefect) this.record(input, { kind: "delegation", action: "delegate", sidekickKind, reason: `flow ${flow.id}: ${appDefect}; the spec that showed it is taken back`, delegationId, attempt, flowId: flow.id, failureClass: AUTHORING_FAILURE.APP_DEFECT });
      return { outcome: { id: flow.id, kind: FLOW_OUTCOME.DELIVERED, specs: [flow.specFile] }, proposals };
    }
    if (appDefect) {
      this.record(input, { kind: "delegation", action: "delegate", sidekickKind, reason: `flow ${flow.id}: ${appDefect}; the spec that showed it is no longer the sidekick's, and no attempt is made to make it pass`, delegationId, attempt, flowId: flow.id, failureClass: AUTHORING_FAILURE.APP_DEFECT });
      return this.keepDelivered(entry, { outcome: { id: flow.id, kind: FLOW_OUTCOME.FAILED, reason: `${appDefect}; the spec that showed it is no longer in the workspace` }, proposals: undefined });
    }
    /* What the run knows beside what the sidekick says: the pages the Context Pack read with results, and the pages the flow's own run_spec calls read empty. */
    const evidence = [...knownFactsOf(this.deps.redaction, input), ...emptyReadEvidence(this.deps.redaction, ledger)];
    const conflict = observationConflictIn(evidence);
    entry.conflict = conflict ? `${conflict.pack.summary}, but ${conflict.read.summary}` : undefined;
    /* A decline that rests on an empty read the Context Pack contradicts is not taken. */
    if (conflict === undefined && eligible && entry.refusal === undefined && workspaceUntouched && result.filesChanged.length === 0 && result.summary.trim() !== "") {
      return this.keepDelivered(entry, { outcome: { id: flow.id, kind: FLOW_OUTCOME.DECLINED, reason: result.summary }, proposals });
    }
    const reason = `${result.status}: ${entry.conflict ? `observation conflict: ${entry.conflict}` : result.summary}`;
    return this.keepDelivered(entry, { outcome: { id: flow.id, kind: result.status === "needs-lead" ? FLOW_OUTCOME.NEEDS_LEAD : FLOW_OUTCOME.FAILED, reason }, proposals: undefined });
  }

  /* A flow whose spec reached the working copy in an earlier turn still delivered it: those bytes are what the run will execute. */
  private keepDelivered(entry: LiveFlow | undefined, report: FlowReport): FlowReport {
    if (!entry?.delivered || report.outcome.kind === FLOW_OUTCOME.DELIVERED) return report;
    return { outcome: { id: entry.flow.id, kind: FLOW_OUTCOME.DELIVERED, specs: [entry.flow.specFile], ...(report.outcome.reason ? { reason: `the last turn ended ${report.outcome.kind}: ${report.outcome.reason}` } : {}) }, proposals: report.proposals };
  }

  /* The lead's review: up to MAX_REVIEW_TURNS turns in its planning session, each followed by the revisions it ordered, while the run has time for them. */
  private async review(lead: LeadSessionHandle, flows: AdmittedFlow[], parallel: number, context: FlowContext, live: Map<string, LiveFlow>, reports: Map<string, FlowReport>, tally: ReviewTally, decided: PlanDecision): Promise<void> {
    const { input } = context;
    const dropped = new Set(decided.coverage.dropped.map((d) => d.candidate.id));
    /* What this lead session was shown of each flow's spec: a spec whose bytes it has seen is not sent again. */
    const seen: SeenSpecs = new Map();
    for (let turn = 1; turn <= MAX_REVIEW_TURNS; turn++) {
      const room = this.room(input);
      if (room !== undefined && room < MIN_FLOW_MS) {
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: too little of the run is left (${room} ms, under the ${MIN_FLOW_MS} ms a flow needs) to ask the lead; the flows stand as they are` });
        break;
      }
      const underReview = await Promise.all(flows.map((flow) => this.underReview(flow, live.get(flow.id), reports.get(flow.id)!, input)));
      const gaps = candidateGapsOf(decided.admission, dropped, flows.map((flow, i) => ({ routes: flow.routes, candidates: flow.candidates, review: underReview[i]! })));
      let reply: { output: string; timedOut: boolean };
      try {
        const request = assembleLeadReview(this.deps.redaction, withSpecDigests(underReview, seen, turn), { turn, maxTurns: MAX_REVIEW_TURNS }, gaps, this.leadFit());
        reply = await lead.ask(request.text, planTurnOpts(request, input.settings.planBudgetMs, room));
      } catch (err) {
        /* The run's own time spent ends the run; any other failure of the lead's turn leaves the flows as they are. */
        if (isRunDeadlineError(err)) throw err;
        tally.turns += 1;
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: the lead's turn failed (${err instanceof Error ? err.message : String(err)}); the flows stand as they are` });
        break;
      }
      tally.turns += 1;
      if (reply.timedOut) {
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: the lead ran out of its time; the flows stand as they are` });
        break;
      }
      const read = (output: string) => admitLeadReview(this.deps.redaction, output, underReview, { revisionsAllowed: turn < MAX_REVIEW_TURNS });
      let admission = read(reply.output);
      let repairTurn = false;
      /* A part of the answer the reader could not read is asked about once, in the lead's own session, held as a correction turn is to leave the flows it orders their minimum time; an answer with nothing in it is the lead's absence, not an answer to repair. */
      if (admission.unreadable.length > 0 && reply.output.trim() !== "") {
        const turnTime = this.leadTurnTime(input);
        if (turnTime === undefined) {
          this.recordUnreadable(input, "review", admission.unreadable, false, `review turn ${turn}: too little of the run is left to ask the lead about what could not be read without costing the flows their minimum time`);
        } else {
          repairTurn = true;
          tally.repairs += 1;
          try {
            const request = assembleUnreadableReviewRequest(admission.unreadable);
            const again = await lead.ask(request.text, turnOpts(request, turnTime.ms, turnTime.limit));
            if (!again.timedOut) {
              const second = read(again.output);
              if (second.readable && (!admission.readable || readsBetter(second.unreadable, admission.unreadable))) admission = second;
            }
          } catch (err) {
            if (isRunDeadlineError(err)) throw err;
            this.record(input, { kind: "lead-decision", answer: "review", reason: `review turn ${turn}: the lead's turn to restate its review failed (${err instanceof Error ? err.message : String(err)}); its first answer stands` });
          }
        }
      }
      tally.unreadable += admission.unreadable.length;
      if (admission.unreadable.length > 0 || repairTurn) this.recordUnreadable(input, "review", admission.unreadable, repairTurn, `review turn ${turn}: ${admission.unreadable.length} part(s) of the answer left unread${repairTurn ? " after asking the lead once more" : ""}, and not acted on`);
      if (!admission.readable) {
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: the lead's answer could not be read; the flows stand as they are` });
        break;
      }
      tally.accepted += admission.accepted.length;
      tally.refused += admission.refused.length;
      for (const r of admission.refused) this.record(input, { kind: "lead-decision", flowId: r.flowId, decision: r.action, overridden: true, overrideReason: r.code, reason: `review turn ${turn}: flow ${r.flowId} ${r.action} not taken: ${r.reason}` });
      for (const d of admission.dropped) {
        tally.dropped += 1;
        reports.set(d.flowId, { outcome: { id: d.flowId, kind: FLOW_OUTCOME.DECLINED, reason: `dropped by the lead: ${d.reason}` }, proposals: undefined });
        this.record(input, { kind: "lead-decision", flowId: d.flowId, decision: REVIEW_ACTION.DROP, overridden: false, reason: `review turn ${turn}: flow ${d.flowId} dropped: ${d.reason}` });
      }
      const orders = admission.orders.filter((o) => live.has(o.flowId));
      const notLive = admission.orders.filter((o) => !live.has(o.flowId));
      this.leaveUncarried(input, turn, notLive, REVIEW_OVERRIDE.FLOW_NOT_LIVE, "the flow holds no workspace to carry it out in", tally);
      if (orders.length === 0) break;
      const after = this.room(input);
      if (after !== undefined && after < MIN_FLOW_MS) {
        this.leaveUncarried(input, turn, orders, REVIEW_OVERRIDE.NO_TIME, `too little of the run is left (${after} ms, under the ${MIN_FLOW_MS} ms a flow needs)`, tally);
        break;
      }
      const slots = orders.map((order) => {
        const flow = live.get(order.flowId)!.flow;
        return { ...order, id: order.flowId, budgetMs: Math.min(flow.budgetMs, after ?? flow.budgetMs) };
      });
      for (const order of orders) {
        if (order.action === REVIEW_ACTION.REVISE) tally.revised += 1;
        else tally.replaced += 1;
        this.record(input, { kind: "lead-decision", flowId: order.flowId, decision: order.action, overridden: order.overrideReason !== undefined, ...(order.overrideReason !== undefined ? { overrideReason: order.overrideReason } : {}), reason: `review turn ${turn}: flow ${order.flowId} ${order.action}`, delegationId: live.get(order.flowId)!.delegationId });
      }
      const results = await this.dispatcher.run(slots, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (slot, signal) => this.revise(live.get(slot.flowId)!, slot, this.now() + slot.budgetMs, context, signal));
      await this.settle(input, results, live, reports);
      if (input.signal?.aborted) break;
    }
  }

  /* Orders the lead gave and the orchestrator admitted that are not carried out: each is said in the run's decisions with what it was and why, and all are counted. */
  private leaveUncarried(input: CoordinateInput, turn: number, orders: readonly ReviewOrder[], code: string, why: string, tally: ReviewTally): void {
    for (const order of orders) {
      tally.notCarriedOut += 1;
      this.record(input, { kind: "lead-decision", flowId: order.flowId, decision: order.action, overridden: true, overrideReason: code, reason: `review turn ${turn}: flow ${order.flowId} ${order.action} not carried out: ${why}` });
    }
  }

  /*
   * One revision the lead ordered: its instruction, with the orchestrator's facts, to the sidekick's own session; or to a fresh one.
   * The turn is given what is left of the flow's slot at `due`, so its own limit runs out with the slot, not after it.
   */
  private async revise(entry: LiveFlow, order: ReviewOrder, due: number, context: FlowContext, signal: AbortSignal): Promise<FlowReport> {
    const instruction = [order.instruction, orchestratorFacts(entry, await this.currentSpecSha(entry, context.input))].filter(Boolean).join("\n");
    const timeoutMs = Math.max(1, due - this.now());
    if (order.action === REVIEW_ACTION.REVISE && entry.session && sessionOpenOf(entry)) {
      const result = await this.followUp(entry, entry.session, instruction, timeoutMs, context.input, signal);
      return this.assess(entry, context, result, signal);
    }
    await this.closeSession(entry);
    return this.freshTurn(entry, context, signal, timeoutMs, instruction);
  }

  /*
   * A follow-up turn in a session kept open, bounded by the flow's slot. The session's own signal belonged to the turn that opened
   * it, so a stop of the slot ends the turn here, as its typed end (the flow's time spent: `timeout`; the run cancelled: `aborted`),
   * and leaves the session: the prompt still running is ended by its own limit, which runs out with the slot, and the transport
   * aborts it without deleting the session. A cancelled run's sessions are ended where the dispatch settles.
   */
  private async followUp(entry: LiveFlow, session: SidekickSession, instruction: string, timeoutMs: number, input: CoordinateInput, signal: AbortSignal): Promise<DelegationResult> {
    const stoppedTurn = (): DelegationResult => unansweredTurn({ delegationId: entry.delegationId, runId: input.runId }, turnEndOf(undefined, signal));
    if (signal.aborted) return stoppedTurn();
    const turn = session.ask(instruction, { timeoutMs, timeLimit: "flow-budget" });
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<DelegationResult>((resolve) => {
      onAbort = () => resolve(stoppedTurn());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([turn, stopped]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      turn.catch(() => undefined);
    }
  }

  /* The sha256 of the flow's spec as the working copy holds it now, read through the confined reader; undefined when it cannot be read. */
  private async currentSpecSha(entry: LiveFlow, input: CoordinateInput): Promise<string | undefined> {
    const spec = this.deps.readSpec ? await this.deps.readSpec({ mirrorDir: input.mirrorDir, specDir: input.specDir }, entry.flow.specFile).catch(() => undefined) : undefined;
    return spec === undefined ? undefined : sha256Hex(spec);
  }

  /* A flow as the lead's review is shown it: the orchestrator's facts first, the sidekick's word beside them. */
  private async underReview(flow: AdmittedFlow, entry: LiveFlow | undefined, report: FlowReport, input: CoordinateInput): Promise<FlowUnderReview> {
    const loop = entry?.loop;
    const ledger = loop?.ledger() ?? [];
    const lastCall = ledger.at(-1);
    const delivered = report.outcome.kind === FLOW_OUTCOME.DELIVERED;
    const spec = delivered && this.deps.readSpec ? await this.deps.readSpec({ mirrorDir: input.mirrorDir, specDir: input.specDir }, flow.specFile).catch(() => undefined) : undefined;
    const lastFailure = lastCall?.status === "failed" ? describeFailure(lastCall.failures) : undefined;
    /* A failure is the spec's current one only when the bytes that failed are the bytes the working copy holds now; with no spec held, there are no current bytes to compare. */
    const lastFailureOn: FailureBytes = spec === undefined ? "no-spec" : lastCall !== undefined && lastCall.sha256 === sha256Hex(spec) ? "current" : "earlier";
    const last = entry?.last;
    return {
      id: flow.id,
      objective: flow.objective,
      acceptance: flow.acceptance,
      outcome: report.outcome,
      answer: last?.answerMiss ? { kind: last.answerMiss } : last?.turnEnd ? { kind: "unanswered", end: last.turnEnd.kind } : { kind: "read", ...(last?.summary ? { summary: last.summary } : {}), concerns: last?.concerns ?? [], ...(last?.unmetByDevState?.length ? { devLimits: last.unmetByDevState.map((u) => `criterion ${u.criterion} (${flow.acceptance[u.criterion - 1] ?? "?"}) on ${u.pages.join(", ")}; ${u.backing}`) } : {}) },
      ...(loop ? { runSpec: { calls: ledger.length, maxCalls: loop.limits.maxCalls, ...(lastCall ? { lastStatus: lastCall.status } : {}), ...(lastFailure ? { lastFailure, lastFailureOn } : {}), ...noWritesLeftOf(loop) } } : {}),
      verified: loop ? await loop.isClosed().catch(() => false) : false,
      ...(entry?.appDefect ? { appDefect: entry.appDefect } : {}),
      sessionOpen: sessionOpenOf(entry),
      specFile: flow.specFile,
      ...(spec !== undefined ? { spec } : {}),
    };
  }

  /* The lead's window fit rule for a prompt of its own turns: whether a prompt of this many bytes leaves the lead the working room its turn needs. Absent a budget, nothing is degraded. */
  private leadFit(): ((bytes: number) => WindowFitOutcome) | undefined {
    const budget = this.deps.contextBudget;
    return budget ? (bytes) => budget.fit({ prompt: { bytes }, role: "lead" }).outcome : undefined;
  }

  /* The pass, kept open: corrections are asked of the lead's planning session and carried out by the flows' sidekicks. */
  private passOf(lead: LeadSessionHandle, flows: AdmittedFlow[], parallel: number, context: FlowContext, live: Map<string, LiveFlow>, signal: CoordinationGateSignal): CoordinatedPass {
    const tally: CorrectionTally = { turns: 0, routed: 0, unrouted: 0, revised: 0, replaced: 0, rebutted: 0, unreadable: 0, repairs: 0 };
    const state = { released: false };
    /* The pass's own list of flows: the plan's, then the maintenance flows it opens. */
    const pool = [...flows];
    return {
      correct: async (findings, origin = CORRECTION_ORIGIN.REVIEW) => {
        const corrected = await this.correct(lead, pool, parallel, context, live, findings, origin, tally, state);
        /* The calls the correction's sidekicks made are the run's too: the signal the run reads at its end holds them. */
        delete signal.runSpecFailureReads;
        Object.assign(signal, runSpecFailureReadsOf(live));
        return corrected;
      },
      leaveUnrouted: (findings, origin, reason) => {
        tally.unrouted += findings.length;
        this.leftUnrouted(context.input, origin, findings.map((_, i) => i), reason);
      },
      tally: () => ({ ...tally }),
      release: async () => {
        if (state.released) return;
        state.released = true;
        for (const entry of live.values()) await this.release(entry);
        await lead.dispose().catch((err: unknown) => engineLog.error(`[qa] closing the lead's session failed: ${err instanceof Error ? err.message : String(err)}`));
      },
    };
  }

  /* One correction turn: the lead routes the findings, the orchestrator holds it to its facts, and each flow sent findings is corrected by its sidekick. */
  private async correct(lead: LeadSessionHandle, flows: AdmittedFlow[], parallel: number, context: FlowContext, live: Map<string, LiveFlow>, findings: readonly CorrectionFinding[], origin: CorrectionOrigin, tally: CorrectionTally, state: { released: boolean }): Promise<PassCorrection> {
    const { input } = context;
    const nothing = (why: string, code: string): PassCorrection => {
      tally.unrouted += findings.length;
      this.record(input, { kind: "lead-decision", origin, findings: findings.length, routes: { spec: 0, candidate: 0, lead: 0, candidateFlow: 0, unrouted: findings.length }, unroutedReasons: findings.length > 0 ? [code] : [], reason: `correction (${origin}): ${why}; the findings stand` });
      return { readable: false, specs: [], rebuttals: [], unrouted: findings.map((_, i) => i) };
    };
    if (state.released) return nothing("the pass was released", "pass-released");
    if (findings.length === 0) return { readable: true, specs: [], rebuttals: [], unrouted: [] };
    const room = this.room(input);
    if (room !== undefined && room < MIN_FLOW_MS) return nothing("too little of the run is left", "no-time");
    const under: FlowUnderCorrection[] = await Promise.all(flows.filter((flow) => live.has(flow.id)).map(async (flow) => {
      const spec = this.deps.readSpec ? await this.deps.readSpec({ mirrorDir: input.mirrorDir, specDir: input.specDir }, flow.specFile).catch(() => undefined) : undefined;
      const cited = (input.candidates ?? []).filter((c) => flowCovers(flow, c));
      return { id: flow.id, objective: flow.objective, specFile: flow.specFile, sessionOpen: sessionOpenOf(live.get(flow.id)), candidates: cited.map((c) => c.id), seedFiles: [...new Set(cited.flatMap((c) => candidateSeeds(c).map((seed) => seed.file)))], directSeedFiles: [...new Set(cited.flatMap((c) => c.seeds.map((seed) => seed.file)))], ...(spec !== undefined ? { spec } : {}) };
    }));
    /*
     * The lead's turns are bounded by what the flows they order need: a turn that would leave the run less than a flow's minimum is
     * not sent. Without the first turn each finding goes to the owner the orchestrator already derives from its own facts (the spec it
     * cites or names, the flow whose test ran the file, the flow whose use case holds it as a direct seed, plan order); without the
     * second, the first answer stands.
     */
    const askLead = async (request: AssembledPrompt, again: boolean): Promise<{ output: string; sent: boolean }> => {
      const turnTime = this.leadTurnTime(input);
      if (turnTime === undefined) {
        this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): too little of the run is left ${again ? "to ask the lead again; its first answer stands" : "for the lead to route the findings without costing the flows their minimum time; each finding goes to its default owner"}` });
        return { output: "", sent: false };
      }
      try {
        const answer = await lead.ask(request.text, turnOpts(request, turnTime.ms, turnTime.limit));
        if (answer.timedOut) this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): the lead ran out of its time${again ? "; its first answer stands" : "; each flow is sent its own findings"}` });
        else return { output: answer.output, sent: true };
      } catch (err) {
        if (isRunDeadlineError(err)) throw err;
        this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): the lead's turn failed (${err instanceof Error ? err.message : String(err)})${again ? "; its first answer stands" : "; each flow is sent its own findings"}` });
      }
      return { output: "", sent: true };
    };
    let askedAgain = new Set<number>();
    const first = await askLead(assembleLeadCorrection(this.deps.redaction, under, findings, origin, this.leadFit()), false);
    if (first.sent) tally.turns += 1;
    let admission = admitLeadCorrection(this.deps.redaction, first.output, under, findings, origin);
    /* What the reader could not read of a real answer is asked about with what the orchestrator refused, in the one repair turn; an answer with nothing in it is the lead's absence. */
    const unreadableFirst = first.output.trim() !== "" ? admission.unreadable : [];
    let repairTurn = false;
    for (const r of admission.refused) this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): ${r.flowId ? `flow ${r.flowId} ` : ""}${r.finding ? `finding ${r.finding} ` : ""}not taken: ${r.reason}` });
    /*
     * An order the orchestrator refused leaves findings with no flow, and a readable answer may leave findings it neither sent to a flow
     * nor rebutted that no flow of the orchestrator's own takes (`opensFlowFor`): the lead is asked once, in its open session, with the
     * reasons and the numbers it left out, and its re-answer is admitted as any answer.
     */
    const omitted = admission.readable ? admission.unrouted.filter((i) => !this.opensFlowFor(input, flows, findings[i]!)) : [];
    const refusedLeft = admission.refused.length > 0 && admission.unrouted.length > 0;
    if ((refusedLeft || omitted.length > 0 || unreadableFirst.length > 0) && !state.released && !input.signal?.aborted) {
      const parts = [...(admission.refused.length > 0 ? [`${admission.refused.length} part(s) of the answer not admitted`] : []), ...(unreadableFirst.length > 0 ? [`${unreadableFirst.length} part(s) of the answer the reader could not read`] : []), ...(omitted.length > 0 ? [`finding(s) ${omitted.map((i) => i + 1).join(", ")} neither sent to a flow nor rebutted`] : [])];
      if (this.leadTurnTime(input) !== undefined) this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): ${parts.join("; ")}; asking the lead once more` });
      const again = await askLead(assembleRefusedCorrection([...admission.refused, ...unreadableFirst.map((u) => ({ reason: describeUnreadableEntry(u) }))], findings.length, omitted, origin), true);
      if (again.sent) {
        tally.turns += 1;
        if (unreadableFirst.length > 0) {
          repairTurn = true;
          tally.repairs += 1;
        }
        askedAgain = new Set(omitted);
        const second = admitLeadCorrection(this.deps.redaction, again.output, under, findings, origin);
        if (second.readable && second.unrouted.length <= admission.unrouted.length && second.unreadable.length <= admission.unreadable.length) {
          admission = second;
          for (const r of second.refused) this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): ${r.flowId ? `flow ${r.flowId} ` : ""}${r.finding ? `finding ${r.finding} ` : ""}not taken after the second asking: ${r.reason}` });
        } else this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): the lead's second answer did not improve on the first; the first stands` });
      }
    }
    tally.rebutted += admission.rebuttals.length;
    if (first.output.trim() !== "") {
      tally.unreadable += admission.unreadable.length;
      if (admission.unreadable.length > 0 || repairTurn) this.recordUnreadable(input, "correction", admission.unreadable, repairTurn, `correction (${origin}): ${admission.unreadable.length} part(s) of the answer left unread${repairTurn ? " after asking the lead once more" : ""}, and not acted on`, { origin });
    }
    const after = this.room(input);
    const stopped = state.released || input.signal?.aborted === true || (after !== undefined && after < MIN_FLOW_MS);
    const orders = stopped ? [] : admission.orders.filter((o) => live.has(o.flowId));
    /* A finding the lead sent to a flow that cannot take it now is counted unrouted, as a finding no flow was sent. */
    const untaken = admission.orders.filter((o) => !orders.includes(o)).flatMap((o) => o.indices);
    const unrouted = [...admission.unrouted, ...untaken];
    /* A finding that names a spec no flow owns goes to one maintenance flow for that spec; the rest stays unrouted. */
    const specFlows = stopped ? [] : await this.maintenanceFor(input, flows, live, findings, admission.unrouted, origin, after);
    /* A finding about a changed file that seeds a use case no flow covers opens one flow for that use case. */
    const takenBySpec = new Set(specFlows.flatMap((m) => m.indices));
    const candidateFlows = stopped ? [] : await this.candidateFlowsFor(input, flows, findings, admission.unrouted.filter((i) => !takenBySpec.has(i)), origin, after);
    const maintenance = [...specFlows, ...candidateFlows];
    const maintained = new Set(maintenance.flatMap((m) => m.indices));
    if (maintenance.length > 0) tally.maintained = (tally.maintained ?? 0) + maintenance.length;
    for (const order of orders) {
      tally.routed += order.findings.length;
      if (order.action === REVIEW_ACTION.REVISE) tally.revised += 1;
      else tally.replaced += 1;
      this.record(input, { kind: "lead-decision", origin, flowId: order.flowId, decision: order.action, findings: order.findings.length, candidateIds: under.find((u) => u.id === order.flowId)?.candidates ?? [], reason: `correction (${origin}): flow ${order.flowId} ${order.action} with ${order.findings.length} finding(s)`, delegationId: live.get(order.flowId)!.delegationId });
    }
    const slots = orders.map((order) => ({ ...order, id: order.flowId, budgetMs: Math.min(live.get(order.flowId)!.flow.budgetMs, after ?? live.get(order.flowId)!.flow.budgetMs) }));
    for (const slot of slots) live.get(slot.flowId)!.taken = false;
    const delegationBefore = { ...context.unreadable };
    /* A claim is read only from a turn this correction made: a flow whose turn failed keeps the result of an earlier one. */
    const turnsBefore = new Map(slots.map((slot) => [slot.flowId, live.get(slot.flowId)!.turns]));
    /* The flows' corrections and the maintenance flows share one pool, so the run's parallelism holds for both. */
    const tasks = [
      ...slots.map((slot) => ({ id: slot.id, budgetMs: slot.budgetMs, slot, maintain: undefined })),
      ...maintenance.map((m) => ({ id: m.flow.id, budgetMs: m.flow.budgetMs, slot: undefined, maintain: m.flow })),
    ];
    const results = await this.dispatcher.run(tasks, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (task, signal) => (task.maintain
      ? this.author(task.maintain, context, live, signal)
      : this.amend(live.get(task.slot!.flowId)!, task.slot!, origin, task.budgetMs, context, signal)));
    await this.settle(input, results, live, new Map());
    tally.unreadable += context.unreadable.delegation - delegationBefore.delegation;
    tally.repairs += context.unreadable.repairs - delegationBefore.repairs;
    const specs = [...new Set([...slots.map((slot) => slot.flowId), ...maintenance.map((m) => m.flow.id)].flatMap((id) => (live.get(id)?.taken ? [live.get(id)!.flow.specFile] : [])))];
    /* The findings of a maintenance flow that put nothing in the working copy were corrected by nobody. */
    const idle = maintenance.filter((m) => !live.get(m.flow.id)?.taken);
    const left = [...unrouted.filter((i) => !maintained.has(i)), ...idle.flatMap((m) => m.indices)].sort((a, b) => a - b);
    tally.unrouted += left.length;
    /*
     * Why each finding was left is one fact, said under one code: the log line and the summary's attribute read the same decision
     * (`unroutedCodeOf`). A finding about a file no use case of the change is seeded by has no flow to own it; a finding sent to a
     * flow that could not take it (the run's time, a released pass, a stopped run) was lost to that, and is not one no flow took.
     */
    const seedless = new Set(left.filter((i) => seedsNoCandidate(findings[i]!, input.candidates ?? [])));
    const stranded = new Set(idle.flatMap((m) => m.indices));
    const lost = new Set(untaken);
    const codeOf = (i: number): UnroutedCode => unroutedCodeOf(i, { seedless, stranded, lost });
    const heldBack = state.released ? "the pass was released" : input.signal?.aborted ? "the run was stopped" : after !== undefined && after < MIN_FLOW_MS ? `too little of the run was left (${after} ms, under the ${MIN_FLOW_MS} ms a flow needs)` : "the flow they were sent to has no live session";
    const leftWith = (code: UnroutedCode, also: (i: number) => boolean = () => true) => left.filter((i) => codeOf(i) === code && also(i));
    this.leftUnrouted(input, origin, leftWith("no-seed-use-case"), "the file they name seeds no use case of the change, so no flow owns them and none can be opened", "no-seed-use-case");
    this.leftUnrouted(input, origin, leftWith("maintenance-flow-empty"), "a maintenance flow was opened for them and put nothing in the working copy", "maintenance-flow-empty");
    this.leftUnrouted(input, origin, leftWith("flow-unavailable"), `the flow they were sent to could not correct them: ${heldBack}`, "flow-unavailable");
    this.leftUnrouted(input, origin, leftWith("no-flow-took", (i) => askedAgain.has(i)), "the lead neither sent them to a flow nor rebutted them after being asked once more, and no cold author is run for them", "no-flow-took");
    this.leftUnrouted(input, origin, leftWith("no-flow-took", (i) => !askedAgain.has(i)), "no flow took them and no cold author is run for them", "no-flow-took");
    const finalUnrouted = left;
    this.record(input, { kind: "lead-decision", origin, ...routingSummary(findings, under, orders, maintenance, left, codeOf), reason: `correction (${origin}): ${findings.length} finding(s) routed` });
    const read = this.deps.readSpec;
    const specSources = read ? await Promise.all(specs.map((spec) => read({ mirrorDir: input.mirrorDir, specDir: input.specDir }, spec).catch(() => undefined))) : undefined;
    const claims = origin === CORRECTION_ORIGIN.EXECUTION && specs.length === 0 ? slots.flatMap((slot) => {
      const entry = live.get(slot.flowId);
      const claim = entry && entry.turns > turnsBefore.get(slot.flowId)! ? entry.last?.testCorrect : undefined;
      return claim ? [claim] : [];
    }) : [];
    return {
      readable: admission.readable,
      specs,
      ...(specSources && specSources.every((source) => source !== undefined) ? { specSources: specSources as string[] } : {}),
      rebuttals: admission.rebuttals,
      unrouted: finalUnrouted,
      ...(claims.length > 0 ? { testCorrect: { cause: claims.every((c) => c.cause === "env") ? "env" : "app", reason: claims.map((c) => c.reason).join("; ") } } : {}),
    };
  }

  /* Whether the orchestrator opens a flow of its own for a finding no flow took: one naming a spec no flow of the pass authors (a maintenance flow), or one about a changed file that seeds a use case no flow covers. Such a finding is not the lead's to place. */
  private opensFlowFor(input: CoordinateInput, pool: readonly AdmittedFlow[], finding: CorrectionFinding): boolean {
    const spec = specNamedBy(finding, input.specRelDir);
    if (spec !== undefined && !pool.some((flow) => flow.specFile === spec)) return true;
    return uncoveredCandidateOf(finding, input.candidates ?? [], (c) => pool.some((flow) => flowCovers(flow, c))) !== undefined;
  }

  /*
   * The maintenance flows a correction turn opens: one per spec that findings no flow took name, when the spec lies inside the spec
   * directory, is readable in the working copy, and the app's flow ceiling, when it sets one, has room. The flow is added to the pass's pool, so a later
   * finding on that spec is routed to it like any other. A spec that gets none is left with its findings unrouted, the reason recorded.
   */
  private async maintenanceFor(input: CoordinateInput, pool: AdmittedFlow[], live: Map<string, LiveFlow>, findings: readonly CorrectionFinding[], candidates: readonly number[], origin: CorrectionOrigin, room: number | undefined): Promise<Array<{ flow: AdmittedFlow; indices: number[] }>> {
    const bySpec = new Map<string, number[]>();
    for (const i of candidates) {
      const spec = specNamedBy(findings[i]!, input.specRelDir);
      if (spec !== undefined) bySpec.set(spec, [...(bySpec.get(spec) ?? []), i]);
    }
    const opened: Array<{ flow: AdmittedFlow; indices: number[] }> = [];
    const proto = pool[0];
    if (!proto) return opened;
    const skip = (spec: string, why: string): void => this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): no maintenance flow for ${spec}: ${why}` });
    for (const [spec, indices] of bySpec) {
      if (pool.some((flow) => flow.specFile === spec)) continue;
      if (input.settings.maxFlows !== undefined && pool.length >= input.settings.maxFlows) {
        skip(spec, `the run already has ${pool.length} flow(s), the ceiling its app sets (maxFlows ${input.settings.maxFlows})`);
        continue;
      }
      const source = this.deps.readSpec ? await this.deps.readSpec({ mirrorDir: input.mirrorDir, specDir: input.specDir }, spec).catch(() => undefined) : "";
      if (source === undefined) {
        skip(spec, "the spec is not readable in the working copy");
        continue;
      }
      const owners = (input.candidates ?? []).filter((c) => c.existingSpecs.some((file) => endsWithSpecPath(file, spec)));
      const flow = maintenanceFlowOf({
        id: maintenanceFlowId(spec, new Set(pool.map((f) => f.id))),
        specFile: spec,
        specRelDir: input.specRelDir,
        findings: [...new Set(indices.map((i) => this.deps.redaction.redact(findings[i]!.text)))],
        preamble: correctionPreamble(origin),
        routes: [...new Set(owners.flatMap((c) => candidatePagesOf(c)))],
        candidates: owners.map((c) => c.id),
        share: proto,
        budgetMs: Math.min(proto.budgetMs, room ?? proto.budgetMs),
      });
      pool.push(flow);
      opened.push({ flow, indices });
      this.record(input, { kind: "lead-decision", origin, flowId: flow.id, findings: indices.length, candidateIds: owners.map((c) => c.id), reason: `correction (${origin}): maintenance flow ${flow.id} for ${spec} with ${indices.length} finding(s) no flow of the plan owns`, delegationId: `${input.runId}-flow-${flow.id}` });
    }
    return opened;
  }

  /*
   * The flows a correction turn opens for use cases the plan did not cover: one per candidate that findings about a changed file
   * no flow took are seeded by and no flow of the pass covers (dropped or unplanned). Within the app's flow ceiling and the run's time, a fresh
   * sidekick writes the flow's deterministic spec; a finding whose file seeds no candidate is left to the caller, unrouted.
   */
  private async candidateFlowsFor(input: CoordinateInput, pool: AdmittedFlow[], findings: readonly CorrectionFinding[], indices: readonly number[], origin: CorrectionOrigin, room: number | undefined): Promise<Array<{ flow: AdmittedFlow; indices: number[] }>> {
    const byCandidate = new Map<UseCaseCandidate, number[]>();
    for (const i of indices) {
      const candidate = uncoveredCandidateOf(findings[i]!, input.candidates ?? [], (c) => pool.some((flow) => flowCovers(flow, c)));
      if (candidate !== undefined) byCandidate.set(candidate, [...(byCandidate.get(candidate) ?? []), i]);
    }
    const opened: Array<{ flow: AdmittedFlow; indices: number[] }> = [];
    const proto = pool[0];
    if (!proto) return opened;
    for (const [candidate, taken] of byCandidate) {
      const skip = (why: string): void => this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): no flow for use case ${candidate.id}: ${why}` });
      if (input.settings.maxFlows !== undefined && pool.length >= input.settings.maxFlows) {
        skip(`the run already has ${pool.length} flow(s), the ceiling its app sets (maxFlows ${input.settings.maxFlows})`);
        continue;
      }
      const id = candidateFlowId(candidate, new Set(pool.map((f) => f.id)));
      const flow = candidateFlowOf({
        id,
        candidate,
        specFile: this.deps.specFileFor(id),
        specRelDir: input.specRelDir,
        findings: [...new Set(taken.map((i) => this.deps.redaction.redact(findings[i]!.text)))],
        preamble: correctionPreamble(origin),
        share: proto,
        budgetMs: Math.min(proto.budgetMs, room ?? proto.budgetMs),
      });
      if (!flow) {
        skip("its spec path is outside the spec directory");
        continue;
      }
      pool.push(flow);
      opened.push({ flow, indices: taken });
      this.record(input, { kind: "lead-decision", origin, flowId: flow.id, findings: taken.length, candidateIds: [candidate.id], reason: `correction (${origin}): flow ${flow.id} opened for use case ${candidate.id} with ${taken.length} finding(s) about the changed files it is seeded by`, delegationId: `${input.runId}-flow-${flow.id}` });
    }
    return opened;
  }

  /* Findings left with no flow, said in the run's decisions and loudly in its log; nothing regenerates them. */
  private leftUnrouted(input: CoordinateInput, origin: CorrectionOrigin, indices: readonly number[], reason: string, code = "left-by-caller"): void {
    if (indices.length === 0) return;
    const which = indices.map((i) => i + 1).join(", ");
    this.record(input, { kind: "lead-decision", origin, findings: indices.length, unroutedReasons: [code], reason: `correction (${origin}): finding(s) ${which} left unrouted: ${reason}` });
    engineLog[levelOfEffect(LOG_EFFECT.CARRIED_ON)](`[qa] correction (${origin}): ${indices.length} finding(s) left unrouted (${which}): ${reason}`);
  }

  /* One flow's correction: its workspace brought up to the working copy, then the findings and the lead's instruction to its sidekick. */
  private async amend(entry: LiveFlow, order: CorrectionOrder, origin: CorrectionOrigin, timeoutMs: number, context: FlowContext, signal: AbortSignal): Promise<FlowReport> {
    const due = this.now() + timeoutMs;
    await this.deps.workspaces.refresh(entry.workspace, entry.request).catch((err: unknown) => engineLog.error(`[qa] refreshing flow ${entry.flow.id}'s workspace failed (it corrects the bytes it has): ${err instanceof Error ? err.message : String(err)}`));
    const instruction = [
      correctionPreamble(origin),
      ...order.findings.map((finding) => `- ${this.deps.redaction.redact(finding)}`),
      `The lead's instruction: ${order.instruction}`,
      origin === CORRECTION_ORIGIN.REVIEW
        ? "Correct each finding in your spec without weakening an assertion; a finding you hold to be wrong goes in concerns, with the evidence."
        : "Correct your spec for each finding without weakening an assertion.",
      ...(origin === CORRECTION_ORIGIN.EXECUTION
        ? [`If you hold the test right and the failure the app's or the environment's, change nothing and add to your result \`"testCorrect":{"cause":"app"|"env","reason":"<the evidence>"}\`. The orchestrator checks the claim against this run's evidence; it is never taken on your word.`]
        : []),
    ].join("\n");
    return this.revise(entry, { flowId: order.flowId, action: order.action, instruction }, due, context, signal);
  }

  /* What the run can still spend on flows and the lead's turns: the time its deadline allots to the phase the run is in, net of what the phases after it are owed. Undefined: no deadline. */
  private room(input: CoordinateInput): number | undefined {
    return this.allowance(input);
  }

  /*
   * The time one of the lead's correction turns, or the repair turn of its review, may take, or undefined when none fits. A turn is held to the room less two flows'
   * minimum: one is what the lead's orders need to run, the other is the slack for a turn that ends after its timeout (an abort never
   * lands on it). The room is the allowance of the purpose the run is in, which shrinks by at most what the turn spends. A turn that
   * could be given less than a flow's minimum is not worth sending. Up to the plan budget (`plan-budget`, or `allotment` when the room
   * is smaller). No deadline: the plan budget.
   */
  private leadTurnTime(input: CoordinateInput): { ms: number; limit: HeldTime["limit"] } | undefined {
    const room = this.room(input);
    if (room === undefined) return { ms: input.settings.planBudgetMs, limit: "plan-budget" };
    const spare = room - MIN_FLOW_MS * 2;
    if (spare < MIN_FLOW_MS) return undefined;
    const held = heldTo({ ms: input.settings.planBudgetMs, limit: "plan-budget" }, spare);
    return { ms: Math.max(1, held.ms), limit: held.limit };
  }

  private allowance(input: CoordinateInput): number | undefined {
    return (input.deadline ?? this.deps.deadline)?.allowance() ?? undefined;
  }

  /* The flows the run can author in `remaining` of allotted time and the app's ceiling; undefined when nothing bounds them. */
  private capacity(input: CoordinateInput, parallel: number, remaining: number | undefined): number | undefined {
    return flowCapacity({
      maxParallel: parallel,
      flowBudgetMs: input.settings.flowBudgetMs.opencode,
      ...(remaining !== undefined ? { allowanceMs: remaining } : {}),
      minFlowMs: MIN_FLOW_MS,
      ...(input.settings.maxFlows !== undefined ? { ceiling: input.settings.maxFlows } : {}),
    });
  }

  /*
   * What an admitted fan-out leaves unsettled about its flows: the capacity it was admitted under, the flows past it, and the
   * admitted flows whose owned change (the slice of the use cases each cites or visits) alone does not fit an author's window. A
   * window the run does not know makes no flow too large.
   */
  private flowAmendment(plan: Extract<AdmittedPlan, { kind: typeof LEAD_PLAN_KIND.FANOUT }>, change: ChangeView | undefined, input: CoordinateInput): PlanAmendment {
    const budget = this.deps.contextBudget;
    const oversize = change && budget
      ? plan.flows.flatMap((flow) => {
          const ids = [...new Set([...flow.candidates, ...(input.candidates ?? []).filter((c) => flowCovers(flow, c)).map((c) => c.id)])];
          if (ids.length === 0) return [];
          const { bytes, ...size } = ownedSliceOf(change, ids);
          return size.hunks > 0 && budget.fit({ prompt: { bytes }, role: "author" }).outcome === "over" ? [{ id: flow.id, size }] : [];
        })
      : [];
    return {
      ...(plan.capacity !== undefined ? { capacity: plan.capacity } : {}),
      ...(plan.notAdmitted.length > 0 ? { notAdmitted: plan.notAdmitted } : {}),
      ...(oversize.length > 0 ? { oversize } : {}),
    };
  }

  /* The flows the amendment turn did not settle: said in the run's decisions, never silent. */
  private reportFlowsUnsettled(input: CoordinateInput, flows: PlanAmendment): void {
    const notAdmitted = flows.notAdmitted ?? [];
    if (notAdmitted.length > 0) {
      this.record(input, {
        kind: "lead-decision",
        ...(flows.capacity !== undefined ? { capacity: flows.capacity } : {}),
        notAdmitted: notAdmitted.map((flow) => flow.id),
        candidateIds: [...new Set(notAdmitted.flatMap((flow) => flow.candidates))],
        reason: `plan: ${notAdmitted.length} flow(s) past the run's capacity of ${flows.capacity ?? 0} were not admitted and are not authored: ${notAdmitted.map((flow) => flow.id).join(", ")}`.slice(0, 1_000),
      });
      engineLog.warn(`[qa] plan: ${notAdmitted.length} flow(s) past the run's capacity of ${flows.capacity ?? 0} were not admitted and are not authored: ${notAdmitted.map((flow) => flow.id).join(", ")}`.slice(0, 1_000));
    }
    const oversize = flows.oversize ?? [];
    if (oversize.length > 0) {
      this.record(input, {
        kind: "lead-decision",
        oversize: oversize.map((flow) => flow.id),
        reason: `plan: ${oversize.length} flow(s) own more of the change than an author's window holds and were kept whole; their briefs carry the rest as references: ${oversize.map((flow) => flow.id).join(", ")}`.slice(0, 1_000),
      });
    }
  }

  private async closeSession(entry: LiveFlow | undefined): Promise<void> {
    const session = entry?.session;
    if (!entry || !session) return;
    entry.session = undefined;
    await session.dispose().catch((err: unknown) => engineLog.error(`[qa] closing flow ${entry.flow.id}'s session failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /* Everything a flow held, released: its session, its loop, its location and its workspace. Never throws. */
  private async release(entry: LiveFlow): Promise<void> {
    entry.released = true;
    await this.closeSession(entry);
    if (entry.loop) await entry.loop.close().catch((err: unknown) => engineLog.error(`[qa] closing flow ${entry.flow.id}'s run_spec loop failed: ${err instanceof Error ? err.message : String(err)}`));
    entry.geolocation?.close();
    await this.deps.workspaces.dispose(entry.workspace);
  }

  /* Keeps what the run planned: the flows, the pages each visits, and what became of every use case the plan had to answer for. A flow visits a page when one of its routes names it (`namesTemplatePage`). */
  private snapshotPlan(input: CoordinateInput, kind: PlanSnapshotKind, flows: readonly AdmittedFlow[], reason?: string, outcomes?: readonly FlowOutcome[], decided?: PlanDecision, claims?: ReadonlyMap<string, readonly CandidateClaim[]>): void {
    const coverage = decided?.coverage;
    const changeRoutes = changeRoutesOf(input);
    const known = new Set((input.candidates ?? []).map((c) => c.id));
    const snapshotFlows: PlanSnapshotFlow[] = flows.map((flow) => {
      const outcome = outcomes?.find((o) => o.id === flow.id);
      return {
        id: flow.id,
        objective: flow.objective,
        acceptance: [...flow.acceptance],
        routes: [...flow.routes],
        specFile: flow.specFile,
        visits: changeRoutes.filter((route) => flow.routes.some((visited) => namesTemplatePage(route, visited))),
        candidates: [...new Set([...flow.candidates.filter((id) => known.has(id)), ...(decided?.admission.required ?? []).filter((c) => flowCovers(flow, c)).map((c) => c.id)])].map((id) => {
          const claimed = claims?.get(flow.id)?.find((claim) => claim.id === id)?.status;
          return { id, ...(claimed !== undefined ? { claimed } : {}) };
        }),
        ...(outcome ? { outcome: { kind: outcome.kind, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}), ...(outcome.specs ? { specs: [...outcome.specs] } : {}) } } : {}),
      };
    });
    const unvisited = unvisitedBy(changeRoutes, flows.flatMap((flow) => flow.routes));
    const state = (candidate: UseCaseCandidate, state: PlanSnapshotCandidate["state"], why?: string): PlanSnapshotCandidate => ({ id: candidate.id, tier: candidate.tier, reachability: candidate.reachability, state, pages: candidatePagesOf(candidate), entry: entryKey(candidate.entry), existingSpecs: candidate.existingSpecs.slice(0, MAX_SNAPSHOT_SPECS), ...(why !== undefined ? { reason: why } : {}) });
    const candidates: PlanSnapshotCandidate[] = coverage
      ? [...coverage.covered.map((c) => state(c, "planned")), ...coverage.dropped.map((d) => ({ ...state(d.candidate, "dropped", d.reason), ...(d.contradicted ? { contradicted: d.contradicted } : {}) })), ...coverage.unresolved.map((c) => state(c, "unplanned"))]
      : [];
    try {
      this.deps.planSnapshots?.record({ runId: input.runId, kind, ...(reason !== undefined ? { reason } : {}), changeRoutes, unvisited, candidates, flows: snapshotFlows, recordedAt: this.now() });
    } catch (err) {
      engineLog.error(`[qa] the run's plan could not be kept (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* The use cases the plan, after its re-plan, still answers for nowhere: said in the run's decisions, never silent. */
  /* The drops the facts contradicted that the lead kept after the one re-ask: honored, and said in the run's decisions. */
  private reportContradicted(input: CoordinateInput, coverage: PlanCoverage): void {
    const kept = contradictionsOf(coverage);
    if (kept.length > 0) this.record(input, { kind: "lead-decision", dropBases: [...new Set(kept.map((c) => c.basis))], dropContradicted: true, candidateIds: kept.map((c) => c.candidate), reason: `plan: ${kept.length} drop(s) the run's facts contradict were kept by the lead after being asked once more, and stand: ${kept.map((c) => `${c.candidate} (${c.basis}: ${c.why})`).join("; ")}`.slice(0, 1_000) });
  }

  private reportUnplanned(input: CoordinateInput, coverage: PlanCoverage): void {
    if (coverage.unresolved.length > 0) this.record(input, { kind: "lead-decision", candidateIds: coverage.unresolved.map((c) => c.id), reason: `plan: ${coverage.unresolved.length} use case(s) neither covered nor dropped, recorded as unplanned: ${coverage.unresolved.map((c) => c.id).join(", ")}` });
  }

  /* An answer's entries the reader could not read, said in the run's decisions: where each sits and why, how many, and whether a repair turn was asked about them. */
  private recordUnreadable(input: CoordinateInput, answer: "plan" | "review" | "correction" | "delegation", unreadable: readonly UnreadableEntry[], repairTurn: boolean, what: string, extra: { flowId?: string; delegationId?: string; attempt?: number; origin?: string } = {}): void {
    this.record(input, { kind: answer === "delegation" ? "delegation" : "lead-decision", answer, unreadable: unreadable.length, repairTurn, ...extra, reason: `${what}: ${describeUnreadable(unreadable).join("; ")}`.slice(0, 1_000) });
  }

  private record(input: CoordinateInput, event: Omit<CoordinationTelemetryEvent, "runId" | "app" | "at" | "kind" | "action"> & { kind: "proposal" | "delegation" | "lead-decision"; action?: "direct" | "delegate" | "abort-human" }): void {
    this.deps.telemetry?.record({ runId: input.runId, app: input.app, at: this.now(), ...event });
  }
}

/*
 * How a correction turn's findings ended, as the structured attributes of its summary event: the count per route (a finding the lead
 * rebutted is in none) and why the unrouted ones were left, as distinct codes.
 */
function routingSummary(findings: readonly CorrectionFinding[], under: readonly FlowUnderCorrection[], orders: readonly CorrectionOrder[], maintenance: ReadonlyArray<{ indices: number[] }>, left: readonly number[], codeOf: (index: number) => UnroutedCode): Pick<CoordinationTelemetryEvent, "findings" | "routes" | "unroutedReasons"> {
  const ordered = new Set(orders.flatMap((o) => o.indices));
  const opened = new Set(maintenance.flatMap((m) => m.indices));
  const unrouted = new Set(left);
  const routes = { spec: 0, candidate: 0, lead: 0, candidateFlow: 0, unrouted: 0 };
  const reasons = new Set<string>();
  findings.forEach((finding, i) => {
    if (unrouted.has(i)) {
      routes.unrouted += 1;
      reasons.add(codeOf(i));
    } else if (ordered.has(i)) {
      const by = routeOfFinding(finding, under)?.by;
      if (by === "spec") routes.spec += 1;
      else if (by === "candidate") routes.candidate += 1;
      else routes.lead += 1;
    } else if (opened.has(i)) routes.candidateFlow += 1;
  });
  return { findings: findings.length, routes, ...(reasons.size > 0 ? { unroutedReasons: [...reasons] } : {}) };
}

/* Why a correction turn left a finding with no flow, as the distinct code the run's decisions and the log both carry. */
type UnroutedCode = "no-seed-use-case" | "maintenance-flow-empty" | "flow-unavailable" | "no-flow-took";

/* The code of one unrouted finding: the file it names seeds no use case, a maintenance flow opened for it delivered nothing, the flow it was sent to could not take it, or no flow was sent it. */
function unroutedCodeOf(index: number, facts: { seedless: ReadonlySet<number>; stranded: ReadonlySet<number>; lost: ReadonlySet<number> }): UnroutedCode {
  return facts.seedless.has(index) ? "no-seed-use-case" : facts.stranded.has(index) ? "maintenance-flow-empty" : facts.lost.has(index) ? "flow-unavailable" : "no-flow-took";
}

/* The drops of a plan the facts contradict and the lead kept, as the run's signal carries them. */
function contradictionsOf(coverage: PlanCoverage): Array<{ candidate: string; basis: string; why: string }> {
  return coverage.dropped.flatMap((d) => (d.contradicted ? [{ candidate: d.candidate.id, basis: d.contradicted.basis, why: d.contradicted.why }] : []));
}

/* What an amendment turn asks about, in words for the run's decisions. */
function amendmentSummary(coverage: PlanCoverage, flows: PlanAmendment): string {
  const parts = [
    ...(coverage.unresolved.length > 0 ? [`${coverage.unresolved.length} use case(s) it neither covers nor drops (${coverage.unresolved.map((c) => c.id).join(", ")})`] : []),
    ...((flows.notAdmitted?.length ?? 0) > 0 ? [`${flows.notAdmitted!.length} flow(s) past the run's capacity of ${flows.capacity ?? 0} (${flows.notAdmitted!.map((f) => f.id).join(", ")})`] : []),
    ...((flows.oversize?.length ?? 0) > 0 ? [`${flows.oversize!.length} flow(s) too large for one author (${flows.oversize!.map((f) => f.id).join(", ")})`] : []),
  ];
  return parts.join("; ").slice(0, 900);
}

/* The run's count of what the reader could not read of the plan and of the sidekicks' results; nothing when there was none. */
function unreadableSignal(plan: number, delegation: { delegation: number; repairs: number }): { unreadable?: { plan: number; delegation: number; repairs: number } } {
  return plan > 0 || delegation.delegation > 0 || delegation.repairs > 0 ? { unreadable: { plan, delegation: delegation.delegation, repairs: delegation.repairs } } : {};
}

function describePlan(plan: AdmittedPlan): string {
  if (plan.kind === LEAD_PLAN_KIND.FANOUT) return `plan: fanout of ${plan.flows.length} flow(s), ${plan.parallel} at a time`;
  if (plan.kind === LEAD_PLAN_KIND.NOOP) return `plan: noop (${plan.reason})`;
  return `plan: rejected (${plan.downgrade})`;
}

/* The pages the Context Pack read with results, as facts; with routes, only the pages those routes name (a flow's brief states its own pages' facts alone). */
function knownFactsOf(redaction: RedactionPort, input: Pick<CoordinateInput, "confirmedDataRoutes">, routes?: readonly string[]): EvidenceRef[] {
  const pages = (input.confirmedDataRoutes ?? []).filter((page) => routes === undefined || routes.some((route) => namesTemplatePage(route, page.path) || namesTemplatePage(page.path, route)));
  return pages.length > 0 ? evidenceFromPackDataRoutes(redaction, pages) : [];
}

/* The settled failure points of the failing tests of every flow's run_spec calls, in call order: where a test failed on a page, and what the page showed there. A failure read while the page was still changing, or with no page or no count, says nothing about DEV's data. */
function runSpecFailureReadsOf(live: ReadonlyMap<string, LiveFlow>): Pick<CoordinationGateSignal, "runSpecFailureReads"> {
  const reads = [...live.values()].flatMap((entry) => (entry.loop?.ledger() ?? []).flatMap((call) => (call.failures ?? []).flatMap((f) => (f.unsettled !== true && f.path !== undefined && f.resultCount !== undefined ? [{ path: f.path, resultCount: f.resultCount }] : []))));
  return reads.length > 0 ? { runSpecFailureReads: reads } : {};
}

/* A page named by its pathname: a query or fragment of a plan route may carry a secret or a value of the moment, and no lesson is about either. */
function pagePathname(route: string): string {
  return route.split(/[?#]/, 1)[0] ?? route;
}

/* The lessons that name one of the flow's pages, as facts of its brief; none for a run with no lessons. */
function lessonFactsOf(redaction: RedactionPort, input: Pick<CoordinateInput, "lessons">, routes: readonly string[]): EvidenceRef[] {
  const pages = routes.map(pagePathname);
  const named = (input.lessons ?? []).filter((lesson) => pages.some((page) => namesTemplatePage(page, lesson.scope) || namesTemplatePage(lesson.scope, page)));
  return evidenceFromLessons(redaction, named);
}

/* A lesson counts as delivered when the brief a session was opened on went out with its line: a lesson the window gave way to a count, or a session that could not be opened, delivered none. */
function noteLessonsDelivered(context: FlowContext, redaction: RedactionPort, sent: string, brief: DelegationBrief): void {
  for (const fact of brief.knownFacts) {
    if (fact.kind !== "lesson" || fact.dataRef === undefined || !sent.includes(redaction.redact(fact.summary))) continue;
    const key = `${fact.source}\u0000${fact.dataRef}`;
    if (!context.lessonsDelivered.has(key)) context.lessonsDelivered.set(key, { kind: fact.source, scope: fact.dataRef, digest: createHash("sha256").update(fact.summary).digest("hex").slice(0, 12) });
  }
}

/* Whose writes to DEV are spent when the flow's next run_spec call would be refused for writes: its own share first, then the run's cap every flow shares; nothing while it can still run. */
function noWritesLeftOf(loop: FlowLoopHandle): { noWritesLeft?: NoWritesLeft } {
  if (loop.signals().devWrites >= loop.limits.maxDevWrites) return { noWritesLeft: "flow" };
  if (loop.runWritesLeft() <= 0) return { noWritesLeft: "run" };
  return {};
}

/* The pages the flow's run_spec calls read empty at a failure point, each once. */
function emptyReadPaths(ledger: readonly FlowLedgerEntry[]): string[] {
  return [...new Set(ledger.flatMap((entry) => (entry.failures ?? []).flatMap((f) => (f.resultCount === 0 && f.path !== undefined ? [f.path] : []))))];
}

function emptyReadEvidence(redaction: RedactionPort, ledger: readonly FlowLedgerEntry[]): EvidenceRef[] {
  return emptyReadPaths(ledger).map((path) => evidenceFromEmptyRead(redaction, path));
}

/* What the orchestrator itself holds of a flow that an unmet criterion attributed to DEV's state is checked against: the pages its browser session was shown, the pages its run_spec calls read empty, and the pages the Context Pack read with results. */
function devStateGroundOf(entry: LiveFlow, input: Pick<CoordinateInput, "agentBrowser" | "confirmedDataRoutes">): DevStateGround {
  return {
    flowReads: input.agentBrowser?.readsOf(entry.delegationId) ?? [],
    emptyReads: emptyReadPaths(entry.loop?.ledger() ?? []),
    dataRoutes: input.confirmedDataRoutes ?? [],
  };
}

const MAX_FACTS_CHARS = 2_000;

/* The options of a lead turn: its time, the sizes and hashes of the sections its prompt was assembled from, so the transport's trace can split the turn, and its stable prefix. */
function turnOpts(assembled: AssembledPrompt, timeoutMs: number, timeLimit?: TimeLimitSource): { timeoutMs: number; timeLimit?: TimeLimitSource; sectionSizes: Record<string, number>; sectionHashes?: Record<string, string>; sectionsDegraded?: number; promptStablePrefixBytes: number } {
  return { timeoutMs, ...(timeLimit !== undefined ? { timeLimit } : {}), sectionSizes: assembled.sectionSizes, ...(assembled.sectionHashes ? { sectionHashes: assembled.sectionHashes } : {}), ...(assembled.windowFit ? { sectionsDegraded: assembled.windowFit.degraded.length } : {}), promptStablePrefixBytes: assembled.stablePrefixBytes };
}

/* A lead turn under the plan budget: the budget while it is below what the run's deadline allots the turn, else the allowance, typed as the bound it is. */
function planTurnOpts(assembled: AssembledPrompt, planBudgetMs: number, allowanceMs: number | undefined): ReturnType<typeof turnOpts> {
  const held = heldTo({ ms: planBudgetMs, limit: "plan-budget" }, allowanceMs);
  return turnOpts(assembled, Math.max(1, held.ms), held.limit);
}

/* Whether the flow's sidekick can be asked again: its holder still holds the session, and the flow's last turn did not end with the runtime saying the session is gone. */
function sessionOpenOf(entry: LiveFlow | undefined): boolean {
  return entry?.session !== undefined && entry.last?.turnEnd?.kind !== SESSION_GONE;
}

/* What the orchestrator adds to an instruction of the lead's: what it saw of the flow's last run_spec call, the kind of failure it met, and the reads that disagree. */
function orchestratorFacts(entry: LiveFlow, currentSha?: string): string {
  const lastCall = entry.loop?.ledger().at(-1);
  const lastRun = lastCall?.status;
  /* A call's outcome is about the spec as it is now only when the bytes it ran are those the working copy holds. */
  const ofEarlierBytes = lastCall !== undefined && currentSha !== undefined && lastCall.sha256 !== currentSha ? ", on an earlier version of your spec" : "";
  const kind = authoringFailureFeedback(entry.failure);
  const facts = [
    entry.loop ? (lastRun ? `- The last run_spec call ended ${lastRun}${ofEarlierBytes}.` : "- No run_spec call of yours was seen.") : "",
    kind ? `- ${kind}` : "",
    entry.conflict ? `- Two reads of the same page disagree: ${entry.conflict}. An empty read there is no evidence that DEV has no data, so it is no reason to decline the flow or to assert that the page is empty.` : "",
    entry.refusal ? `- The file could not be taken back: ${entry.refusal}` : "",
  ].filter(Boolean);
  return facts.length > 0 ? ["Facts the orchestrator observed:", ...facts].join("\n").slice(0, MAX_FACTS_CHARS) : "";
}

/* The last failing test of a run_spec call, in one line. */
function describeFailure(failures: readonly FlowFailureFact[] | undefined): string | undefined {
  const f = failures?.[0];
  if (!f) return undefined;
  return [
    f.detail,
    f.path ? `on ${f.path}` : "",
    f.httpStatus !== undefined ? `(server ${f.httpStatus})` : "",
    f.resultCount !== undefined ? `(${f.resultCount} results shown)` : "",
    f.runtimeErrors?.length ? `(${f.runtimeErrors.length} runtime error(s): ${f.runtimeErrors[0]!.text})` : "",
    f.unsettled ? "(the page was still changing)" : "",
  ].filter(Boolean).join(" ");
}
