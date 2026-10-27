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

import { engineLog } from "@kernel/ports/process-logger.ts";
import { sha256Hex } from "@kernel/content-hash.ts";
import type { ChangedDecision } from "@kernel/changed-decision.ts";
import type { AssembledPrompt } from "@kernel/prompt-sections.ts";
import { posix } from "node:path";
import { PROBE_REL_DIR } from "@contexts/test-execution/application/index.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { AUTHORING_REFUSAL, type CoordinationGateSignal, type CoordinationSettings, type PlanningLimits } from "@kernel/coordination.ts";
import { formatGeoLocation, type GeoLocation } from "@kernel/geolocation.ts";
import { isRunDeadlineError } from "../../../shared-kernel/run-deadline.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowFailureFact, FlowGeolocationHandle, FlowLedgerEntry, FlowLoopHandle, GeolocationHandle } from "@contexts/agent-tools/application/index.ts";
import type { LeadSessionHandle, PlanOutput } from "@kernel/plan-output.ts";
import type { CodeGraphToolsHandle } from "@contexts/agent-tools/application/index.ts";
import type { DelegationWorkspace, DelegationWorkspaceRequest, WorkspaceChange } from "../domain/delegation-workspace.ts";
import type { DelegationWorkspacePort } from "./ports/delegation-workspace.port.ts";
import { createDelegationBrief, type DelegationBrief } from "./delegation-brief.ts";
import { briefChangeFor, fitBriefChange, type BriefChange } from "./brief-change.ts";
import { assembleSidekickBrief } from "./sidekick-prompt.ts";
import type { ContextBudget, ContextFit } from "@kernel/context-budget.ts";
import { entryKey } from "@kernel/change-reach.ts";
import { candidatePagesOf, pageRoutesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { admissionSetOf, flowCovers, honorContradictedDrops, impliedNoopDrops, MAX_PLAN_ROUNDS, needsAmendment, planCoverage, assembleReplanRequest, unvisitedBy, type AdmissionSet, type PlanAmendment, type PlanCoverage } from "./plan-coverage.ts";
import { candidateSlicesOf, changeViewOf, ownedSliceOf, type ChangeView } from "./owned-slices.ts";
import { flowCapacity } from "./flow-capacity.ts";
import type { CandidateClaim, DelegationResult } from "./delegation-result.ts";
import { classifyDelegationFailure } from "./delegation-failure-class.ts";
import { admitLeadReview, candidateGapsOf, assembleLeadReview, MAX_REVIEW_TURNS, REVIEW_ACTION, withSpecDigests, type FailureBytes, type FlowUnderReview, type ReviewOrder, type SeenSpecs } from "./lead-review.ts";
import type { CoordinationTelemetryEvent, CoordinationTelemetryPort } from "./coordination-telemetry.ts";
import { PLAN_SNAPSHOT_KIND, type PlanSnapshotCandidate, type PlanSnapshotFlow, type PlanSnapshotKind, type PlanSnapshotPort } from "@kernel/ports/plan-snapshot.port.ts";
import { authorTask } from "./author-task.ts";
import { SIDEKICK_KIND, SIDEKICK_TIER, type SidekickKind, type SidekickTier } from "./sidekick-kinds.ts";
import { admitExploreRequest } from "./explore-request.ts";
import { assembleExploreOutcome, runExploreRound } from "./explore-round.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import { evidenceFromEmptyRead, evidenceFromPackDataRoutes } from "./evidence-from.ts";
import { observationConflictIn } from "./evidence-precedence.ts";
import { AUTHORING_FAILURE, authoringFailureFeedback, classifyAuthoringFailure, type AuthoringFailure } from "./authoring-failure.ts";
import { FanOutDispatcher, FLOW_RESULT, type TimerPort } from "./fan-out-dispatcher.ts";
import { aggregateFlowOutcomes, FLOW_OUTCOME, type AggregatedFlows, type FlowOutcome } from "./flow-outcomes.ts";
import { admitLeadPlan, LEAD_PLAN_KIND, PLAN_DOWNGRADE, PLAN_REJECTED, assembleRejectedPlanRequest, type AdmittedFlow, type AdmittedPlan } from "./lead-plan.ts";
import { resolveSidekickModel } from "./resolve-sidekick-model.ts";
import { SIDEKICK_AUTHORING, sidekickAuthoring, sidekickDeniedTools, type SidekickAuthoringMode } from "./sidekick-authoring.ts";
import type { SidekickExecutor, SidekickSession } from "./sidekick-executor.ts";
import { packPagesFor } from "@contexts/generation/application/index.ts";
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


/* The pages of the change's candidates, in the order they are offered: the baseline the plan snapshot keeps beside the per-candidate states. */
const changeRoutesOf = (input: { candidates?: readonly UseCaseCandidate[] }): string[] => pageRoutesOf(input.candidates ?? []);

/* Less than this of a flow's time left and a second attempt is not started; less than this of the run and a plan is not asked for. */
/* The specs of a candidate a plan snapshot keeps. */
const MAX_SNAPSHOT_SPECS = 3;

export const MIN_FLOW_MS = 60_000;
/* What a run keeps for what follows the flows (validation, execution, the reviewer): a quarter of what is left, and never less than this. */
export const MIN_RESERVE_MS = 120_000;
export const RESERVE_SHARE = 0.25;

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
  /* The model a fresh sidekick the lead's review starts on a flow runs with; absent: the same as the first. */
  escalatedModel?: string;
  /* The spec a flow delivered, as it is in the run's working copy, read through the confined reader; absent or unreadable: the review shows none. */
  readSpec?(root: { mirrorDir: string; specDir: string }, specFile: string): Promise<string | undefined>;
  /* The spec file, relative to the spec directory, that a flow's id names. */
  specFileFor(flowId: string): string;
  /* Whether the run's code graph holds the symbol an explore finding names (`<file>#<symbol>`); absent: no symbol finding is verified. */
  graphHolds?(ref: string): Promise<boolean>;
  /* The run's deadline as the agents' turns read it; a call may bring its own. Absent: nothing bounds the run's time. */
  deadline?: { remainingMs(): number | undefined };
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
  /* The run's code-graph right: an explore sidekick is given a share of its calls. */
  codeGraph?: CodeGraphToolsHandle;
  /* The run's authoring location, when the app declares one: a flow may name a place and each flow owns its own value. */
  geolocation?: GeolocationHandle;
  devBaseUrl?: string;
  /* The pages the run's Context Pack read with results: every sidekick's brief states them, and a flow's empty read of one is checked against them. */
  confirmedDataRoutes?: readonly { path: string; resultCount: number }[];
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
  deadline?: { remainingMs(): number | undefined };
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
  /* Units of a gap the caps cut from the turns the lead was asked; absent when none was. */
  omitted?: number;
}

/*
 * A coordinated pass kept open after it delivered: the lead's planning session and every flow's sidekick session, workspace, loop
 * and location, for the corrections that follow: the static gate's, the execution's, the change-coverage's and the reviewer's.
 * Whoever holds it releases it, however the run ends.
 */
export interface CoordinatedPass {
  /* One correction turn over findings of one origin; the reviewer's when none is named. */
  correct(findings: readonly CorrectionFinding[], origin?: CorrectionOrigin, omitted?: number): Promise<PassCorrection>;
  /* Findings the run does not send through the pass (its correction budget is spent): recorded and counted unrouted, never regenerated by a cold author. */
  leaveUnrouted(findings: readonly CorrectionFinding[], origin: CorrectionOrigin, reason: string): void;
  tally(): CorrectionTally;
  release(): Promise<void>;
}

interface FlowContext {
  input: CoordinateInput;
  mode: SidekickAuthoringMode;
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
  geolocation?: FlowGeolocationHandle;
  session?: SidekickSession;
  tier: SidekickTier;
  turns: number;
  last?: DelegationResult;
  /* Whether a turn of the flow ever put its spec in the working copy: those bytes stay there whatever a later turn does. */
  delivered: boolean;
  /* Whether the flow's last turn put its spec in the working copy. */
  taken?: boolean;
  /* Set when the pass released the flow: a turn that answers after it changes nothing and leaves nothing open. */
  released?: boolean;
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
    const before = this.remaining(input);
    if (before !== undefined && before < settings.planBudgetMs + MIN_RESERVE_MS + MIN_FLOW_MS * 2) {
      return refuse(AUTHORING_REFUSAL.NO_TIME, "too little of the run is left to plan and author in parallel", { authoring: authoringName });
    }

    await this.sweep().catch((err: unknown) => engineLog.error(`[qa] sweeping the delegation workspaces failed (the run goes on): ${err instanceof Error ? err.message : String(err)}`));
    const locations = input.geolocation?.placeNames() ?? [];
    const admission = admissionSetOf(input.candidates);
    const change = changeViewOf(input.change?.diffs, input.candidates);
    const candidateSlices = change && admission.required.length > 0 ? candidateSlicesOf(change, admission.required) : undefined;
    /* The capacity the plan is told, as it will stand once the planning turn has taken its time. */
    const capacity = this.capacity(input, parallel, before === undefined ? undefined : before - settings.planBudgetMs);
    let planned = await input.plan({
      ...(capacity !== undefined ? { capacity } : {}),
      maxParallel: parallel,
      flowBudgetMs: settings.flowBudgetMs.opencode,
      budgetMs: settings.planBudgetMs,
      ...(locations.length > 0 ? { locations } : {}),
      ...(admission.required.length > 0 ? { candidates: admission.required } : {}),
      ...(admission.others > 0 ? { otherCandidates: admission.others } : {}),
      ...(candidateSlices ? { candidateSlices } : {}),
      ...(input.change?.decisions?.length ? { decisions: input.change.decisions } : {}),
    });
    /* The lead's planning session, when the plan kept it: its review of the flows is asked there, and it ends with the pass. */
    let leadHanded = false;
    try {
      if (planned.explore !== undefined) {
        const explored = await this.explore(input, planned);
        if ("downgrade" in explored) {
          this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.REJECTED, [], explored.downgrade);
          return refuse(`${AUTHORING_REFUSAL.PLAN_REJECTED}:${explored.downgrade}`, `the exploration request was not admitted (${explored.downgrade})`, { authoring: authoringName });
        }
        planned = explored.planned;
      }
      if (planned.timedOut) return refuse(AUTHORING_REFUSAL.PLAN_TIMED_OUT, "the planning turn ran out of its time", { authoring: authoringName });
      /* A declared no-op in either shape (`{"kind":"noop"}` or a plan of no flows that drops every use case) is held to the same facts. */
      const noopOf = (reason: string): AdmittedPlan => ({ kind: LEAD_PLAN_KIND.NOOP, reason, ...(admission.required.length > 0 ? { dropped: impliedNoopDrops(reason, admission.required) } : {}) });
      let admitted = planned.noopReason !== undefined ? noopOf(planned.noopReason) : this.admit(input, planned.plan, parallel);
      if (admitted.kind === PLAN_REJECTED) {
        const corrected = await this.reask(input, planned.lead, admitted.downgrade, parallel);
        if (corrected.noopReason !== undefined) admitted = noopOf(corrected.noopReason);
        else if (corrected.plan) admitted = corrected.plan;
      }
      let coverage: PlanCoverage = { covered: [], dropped: [], unresolved: [] };
      if (admitted.kind === LEAD_PLAN_KIND.FANOUT || (admitted.kind === LEAD_PLAN_KIND.NOOP && admitted.dropped !== undefined)) {
        /* A plan is held to the facts once: a drop they contradict returns it to the lead with the fact; what the lead keeps after that is its decision. */
        coverage = planCoverage({ flows: admitted.kind === LEAD_PLAN_KIND.FANOUT ? admitted.flows : [], dropped: admitted.dropped ?? [] }, admission.required);
        const amended = await this.amendPlan(input, planned.lead, admitted, coverage, admission, parallel, change);
        admitted = amended.plan;
        coverage = honorContradictedDrops(amended.coverage);
        this.reportContradicted(input, coverage);
      }
      const contradicted = contradictionsOf(coverage);
      /* What the amendment turn could not settle about the flows: those still past the capacity are not authored, those still too large are authored with references. */
      const flowFacts = admitted.kind === LEAD_PLAN_KIND.FANOUT ? this.flowAmendment(admitted, change, input) : {};
      const notAdmitted = flowFacts.notAdmitted?.map((flow) => flow.id) ?? [];
      const oversize = flowFacts.oversize?.map((flow) => flow.id) ?? [];
      this.reportFlowsUnsettled(input, flowFacts);
      const withContradictions = {
        ...base,
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
    const remaining = this.remaining(input);
    const loop = input.closedLoop?.limits;
    return admitLeadPlan(
      raw,
      {
        ...(settings.maxFlows !== undefined ? { ceiling: settings.maxFlows } : {}),
        maxParallel: parallel,
        flowBudgetMs: settings.flowBudgetMs.opencode,
        ...(remaining !== undefined ? { remainingMs: remaining } : {}),
        reserveMs: remaining === undefined ? 0 : this.reserve(remaining),
        minFlowMs: MIN_FLOW_MS,
        ...(loop ? { runSpecCalls: loop.maxCalls, runSpecDevWrites: loop.maxDevWrites, runSpecPerCallMs: loop.perCallMs } : {}),
        ...(input.agentBrowser ? { browserCalls: input.agentBrowser.limits.maxCalls, browserPerCallMs: input.agentBrowser.limits.perCallMs } : {}),
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
   * A plan the run cannot admit goes back to the lead in its open session, once, with the reason, the way a plan that leaves use
   * cases unresolved does: the lead's answer is untrusted text and a wrong shape is a correctable slip, not a decision. A no-op or
   * an admitted plan replaces it; anything else, a failed turn, or no session or time left keeps the first refusal. Never twice.
   */
  private async reask(input: CoordinateInput, lead: LeadSessionHandle | undefined, downgrade: string, parallel: number): Promise<{ plan?: AdmittedPlan; noopReason?: string }> {
    if (!lead || input.signal?.aborted) return {};
    const { settings } = input;
    const left = this.remaining(input);
    if (left !== undefined && left < settings.planBudgetMs + MIN_RESERVE_MS + MIN_FLOW_MS) {
      this.record(input, { kind: "lead-decision", reason: `plan: not admitted (${downgrade}) and too little of the run is left to ask the lead again` });
      return {};
    }
    this.record(input, { kind: "lead-decision", reason: `plan: not admitted (${downgrade}); asking the lead once more with the reason` });
    let answered: Awaited<ReturnType<LeadSessionHandle["askForPlan"]>>;
    try {
      const request = assembleRejectedPlanRequest(downgrade);
      answered = await lead.askForPlan(request.text, turnOpts(request, Math.max(1, left === undefined ? settings.planBudgetMs : Math.min(settings.planBudgetMs, left))));
    } catch (err) {
      if (isRunDeadlineError(err)) throw err;
      this.record(input, { kind: "lead-decision", reason: `plan: the lead's corrected plan turn failed (${err instanceof Error ? err.message : String(err)}); the refusal stands` });
      return {};
    }
    if (input.signal?.aborted) return {};
    if (answered.noopReason !== undefined) return { noopReason: answered.noopReason };
    const second = answered.plan !== undefined ? this.admit(input, answered.plan, parallel) : undefined;
    if (second === undefined || second.kind === PLAN_REJECTED) {
      this.record(input, { kind: "lead-decision", reason: `plan: the lead's corrected answer was not admitted (${second?.downgrade ?? PLAN_DOWNGRADE.NO_PLAN}); the refusal stands` });
      return {};
    }
    return { plan: second };
  }

  /*
   * The one amendment turn: a plan that leaves use cases unresolved (a drop the facts contradict among them), names flows past the
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
    /* A plan of no flows is asked again only for a drop the facts contradict: the lead's other no-ops stand as they always did. */
    const needed = first.kind === LEAD_PLAN_KIND.NOOP ? (firstCoverage.refused?.length ?? 0) > 0 : needsAmendment(firstCoverage.unresolved, flows);
    if (!needed || !lead || MAX_PLAN_ROUNDS < 2 || input.signal?.aborted) return stands;
    const { settings } = input;
    const left = this.remaining(input);
    const asked = amendmentSummary(firstCoverage, flows);
    if (left !== undefined && left < settings.planBudgetMs + MIN_RESERVE_MS + MIN_FLOW_MS * 2) {
      this.record(input, { kind: "lead-decision", reason: `plan: ${asked} and too little of the run is left to ask the lead again` });
      return stands;
    }
    this.record(input, { kind: "lead-decision", reason: `plan: asking the lead once more, in one amendment turn, about ${asked}` });
    let answered: Awaited<ReturnType<LeadSessionHandle["askForPlan"]>>;
    try {
      const slices = change && admission.required.length > 0 ? { slices: candidateSlicesOf(change, firstCoverage.unresolved) } : {};
      const request = assembleReplanRequest(this.deps.redaction, firstCoverage.unresolved, firstCoverage.refused, { ...flows, ...slices });
      answered = await lead.askForPlan(request.text, turnOpts(request, Math.max(1, left === undefined ? settings.planBudgetMs : Math.min(settings.planBudgetMs, left))));
    } catch (err) {
      if (isRunDeadlineError(err)) throw err;
      this.record(input, { kind: "lead-decision", reason: `plan: the lead's second plan turn failed (${err instanceof Error ? err.message : String(err)}); the first plan stands` });
      return stands;
    }
    if (input.signal?.aborted) return stands;
    const second = answered.plan !== undefined ? this.admit(input, answered.plan, parallel) : undefined;
    /* A plan of flows, or a plan that drops every use case, which the facts must now allow. */
    const answer = second?.kind === LEAD_PLAN_KIND.FANOUT ? second : second?.kind === LEAD_PLAN_KIND.NOOP && second.dropped !== undefined && first.kind === LEAD_PLAN_KIND.NOOP ? second : undefined;
    if (answer === undefined) {
      this.record(input, { kind: "lead-decision", reason: "plan: the lead's second answer was not a plan of flows the run admits; the first plan stands" });
      return stands;
    }
    return { plan: answer, coverage: planCoverage({ flows: answer.kind === LEAD_PLAN_KIND.FANOUT ? answer.flows : [], dropped: answer.dropped ?? [] }, admission.required) };
  }

  /*
   * The one round of exploration the lead asked for instead of a plan: read-only sidekicks answer its questions, the orchestrator
   * labels each finding by what it holds itself, and the lead is asked again in the same session; that answer must be a plan.
   */
  private async explore(input: CoordinateInput, planned: PlanOutput): Promise<{ planned: PlanOutput } | { downgrade: string }> {
    const lead = planned.lead;
    const request = admitExploreRequest(planned.explore, this.deps.redaction);
    if (!lead || request.kind === "rejected") {
      this.record(input, { kind: "lead-decision", reason: `explore: the request was not admitted (${request.kind === "rejected" ? request.reason : "no session to ask again"})` });
      return { downgrade: PLAN_DOWNGRADE.MALFORMED };
    }
    this.record(input, { kind: "proposal", action: "delegate", sidekickKind: SIDEKICK_KIND.EXPLORE, reason: `explore: ${request.questions.length} question(s)` });
    const remaining = this.remaining(input);
    const outcome = await runExploreRound(
      {
        redaction: this.deps.redaction,
        sidekick: this.deps.sidekick,
        dispatcher: this.dispatcher,
        ...(this.deps.graphHolds ? { graphHolds: this.deps.graphHolds } : {}),
        record: (event) => this.record(input, { kind: "delegation", action: "delegate", sidekickKind: SIDEKICK_KIND.EXPLORE, tier: SIDEKICK_TIER.STANDARD, ...event }),
        now: this.now,
        ...(this.deps.log ? { log: this.deps.log } : {}),
      },
      {
        runId: input.runId,
        mirrorDir: input.mirrorDir,
        questions: request.questions,
        spareMs: remaining === undefined ? undefined : remaining - this.reserve(remaining),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.agentBrowser ? { agentBrowser: input.agentBrowser } : {}),
        ...(input.codeGraph ? { codeGraph: input.codeGraph } : {}),
        ...(input.contextPack ? { contextPack: input.contextPack } : {}),
        ...(input.confirmedDataRoutes ? { confirmedDataRoutes: input.confirmedDataRoutes } : {}),
        ...(input.devBaseUrl ? { devBaseUrl: input.devBaseUrl } : {}),
      },
    );
    /* A cancelled run spends no further turn of the lead: it has no plan to admit, and the caller reads the cancellation. */
    if (input.signal?.aborted) return { planned: { parsed: false, timedOut: false, lead } };
    const left = this.remaining(input);
    const followUp = assembleExploreOutcome(this.deps.redaction, outcome);
    const answered = await lead.askForPlan(followUp.text, turnOpts(followUp,Math.max(1, left === undefined ? input.settings.planBudgetMs : Math.min(input.settings.planBudgetMs, left))));
    /* One round per run: a second request is not a plan. */
    if (answered.explore !== undefined) {
      this.record(input, { kind: "lead-decision", reason: "explore: the lead asked to explore a second time, which a run does not allow" });
      return { downgrade: PLAN_DOWNGRADE.MALFORMED };
    }
    return { planned: { ...(answered.plan ? { plan: answered.plan } : {}), ...(answered.noopReason !== undefined ? { noopReason: answered.noopReason } : {}), parsed: answered.parsed, timedOut: answered.timedOut, lead } };
  }

  /* The flows of an admitted plan: each authored once, then reviewed by the lead, then added up. Every flow's resources end here, however the pass ends. */
  private async fanOut(input: CoordinateInput, flows: AdmittedFlow[], parallel: number, how: { mode: SidekickAuthoringMode; lead?: LeadSessionHandle }, base: CoordinationGateSignal, decided: PlanDecision): Promise<CoordinateResult> {
    const context: FlowContext = { input, mode: how.mode };
    const live = new Map<string, LiveFlow>();
    const reports = new Map<string, FlowReport>();
    let handed = false;
    try {
      const results = await this.dispatcher.run(flows, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (flow, signal) => this.author(flow, context, live, signal));
      await this.settle(results, live, reports);

      const tally: ReviewTally = { turns: 0, accepted: 0, revised: 0, replaced: 0, dropped: 0, refused: 0 };
      if (how.lead && !input.signal?.aborted) await this.review(how.lead, flows, parallel, context, live, reports, tally, decided);

      const outcomes = flows.map((flow) => reports.get(flow.id)?.outcome ?? { id: flow.id, kind: FLOW_OUTCOME.FAILED, reason: "no attempt could be made" });
      const proposals = flows.flatMap((flow) => {
        const p = reports.get(flow.id)?.proposals;
        return p && p.total > 0 ? [p] : [];
      });
      const aggregated = aggregateFlowOutcomes(outcomes);
      const known = new Set((input.candidates ?? []).map((c) => c.id));
      const flowCandidates = flows.map((flow) => ({ specFile: flow.specFile, candidates: flow.candidates.filter((id) => known.has(id)) }));
      this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.FANOUT, flows, undefined, outcomes, decided, new Map([...live].flatMap(([id, entry]) => (entry.last?.candidates ? [[id, entry.last.candidates] as const] : []))));
      const signal: CoordinationGateSignal = {
        ...base,
        flows: flows.length,
        delivered: outcomes.filter((o) => o.kind === FLOW_OUTCOME.DELIVERED).length,
        incomplete: aggregated.incompleteFlows.length,
        ...(tally.turns > 0 ? { review: tally } : {}),
      };
      for (const p of proposals) this.deps.log?.(`coordination: flow ${p.flowId} changed ${p.total} file(s) it was not given to write; they are proposals and were not applied`);

      /* With the lead's session the pass is kept open for the reviewer's corrections; its holder releases it. */
      if (how.lead && !input.signal?.aborted && aggregated.end === GENERATION_END.DELIVERED) {
        handed = true;
        return { action: "fanout", aggregated, proposals, signal, pass: this.passOf(how.lead, flows, parallel, context, live), flowCandidates };
      }
      return { action: "fanout", aggregated, proposals, signal, flowCandidates };
    } finally {
      if (!handed) for (const entry of live.values()) await this.release(entry);
    }
  }

  /* What each dispatched turn came to, as the flow's report. A flow whose turn did not settle has no session left to ask. */
  private async settle(results: ReadonlyArray<{ id: string; status: string; value?: FlowReport; error?: unknown }>, live: Map<string, LiveFlow>, reports: Map<string, FlowReport>): Promise<void> {
    for (const result of results) {
      switch (result.status) {
        case FLOW_RESULT.SETTLED:
          reports.set(result.id, result.value!);
          continue;
        case FLOW_RESULT.TIMED_OUT:
          reports.set(result.id, this.keepDelivered(live.get(result.id), { outcome: { id: result.id, kind: FLOW_OUTCOME.TIMED_OUT }, proposals: undefined }));
          break;
        case FLOW_RESULT.ABORTED:
          reports.set(result.id, this.keepDelivered(live.get(result.id), { outcome: { id: result.id, kind: FLOW_OUTCOME.FAILED, reason: "the run was cancelled" }, proposals: undefined }));
          break;
        case FLOW_RESULT.THREW:
          /* The run's own time spent ends the run, not a flow. */
          if (isRunDeadlineError(result.error)) throw result.error;
          engineLog.error(`[qa] flow ${result.id} failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
          reports.set(result.id, this.keepDelivered(live.get(result.id), { outcome: { id: result.id, kind: FLOW_OUTCOME.FAILED, reason: "the sidekick's session failed" }, proposals: undefined }));
          break;
      }
      await this.closeSession(live.get(result.id));
    }
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
    const entry: LiveFlow = { flow, delegationId, workspace, request, tier: SIDEKICK_TIER.STANDARD, turns: 0, delivered: false, ...(geolocation ? { geolocation } : {}) };
    live.set(flow.id, entry);
    const probePath = `${PROBE_REL_DIR}/${posix.basename(flow.specFile)}`;
    if (input.closedLoop && flow.runSpecCalls > 0) {
      entry.loop = input.closedLoop.openFlow({
        delegationId,
        flowId: flow.id,
        limits: { maxCalls: flow.runSpecCalls, maxDevWrites: flow.runSpecDevWrites },
        workspace: { dir: workspace.dir, specDir: workspace.specDir },
        specFile: flow.specFile,
        stage: async () => ((await this.deps.workspaces.stage(workspace, request, flow.writablePaths[0]!, probePath)) ? probePath : undefined),
      });
    }
    if (context.mode === SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER && input.agentBrowser && flow.browserCalls > 0) {
      input.agentBrowser.grantShare(delegationId, flow.browserCalls);
    }
    const result = await this.openSession(entry, context, signal, flow.budgetMs);
    return this.assess(entry, context, result, signal);
  }

  /* A fresh sidekick session on the flow's brief, with the feedback when there is some; the session is kept on the flow. */
  private async openSession(entry: LiveFlow, context: FlowContext, signal: AbortSignal, timeoutMs: number, feedback?: string): Promise<DelegationResult> {
    const model = resolveSidekickModel(entry.tier, this.deps.escalatedModel);
    const { brief, contextFit } = this.briefOf(entry, context, model);
    const session = await this.deps.sidekick.open(brief, {
      cwd: entry.workspace.dir,
      kind: entry.flow.kind,
      ...(model ? { model } : {}),
      signal,
      timeoutMs: Math.max(1, timeoutMs),
      delegationId: entry.delegationId,
      denyTools: sidekickDeniedTools(context.mode, entry.loop !== undefined),
      ...(contextFit ? { contextFit } : {}),
      ...(feedback ? { feedback } : {}),
    });
    /* A session that opened after its flow was stopped or released belongs to nobody: it is closed at once. */
    if (signal.aborted || entry.released) {
      await session.dispose().catch((err: unknown) => engineLog.error(`[qa] closing flow ${entry.flow.id}'s late session failed: ${err instanceof Error ? err.message : String(err)}`));
      throw new Error(`flow ${entry.flow.id}'s session opened after the flow was stopped`);
    }
    entry.session = session;
    return session.first;
  }

  /*
   * The flow author's brief: the flow's slice of the change, its own pages' facts and the tools its turn grants. The slice's owned
   * hunks are preloaded while the whole brief fits the author's window (the model the session runs on); what does not fit is named
   * by file and range. The fit it was judged by rides on the turn's telemetry.
   */
  private briefOf(entry: LiveFlow, context: FlowContext, model: string | undefined): { brief: DelegationBrief; contextFit?: ContextFit } {
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
        task: authorTask(flow, entry.loop, browser ? input.agentBrowser!.limits.perCallMs : undefined, entry.geolocation),
        acceptanceCriteria: flow.acceptance,
        scope: { readablePaths: ["."], writablePaths: flow.writablePaths, allowedCommands: [] },
        knownFacts: knownFactsOf(this.deps.redaction, input, flow.routes),
        tools,
        ...(pagesOf(input.contextPack, flow.routes) ?? {}),
        ...(input.harnessFacts ? { harnessFacts: input.harnessFacts, specRelDir: input.specRelDir } : {}),
        ...(input.existingSpecs?.length ? { suite: input.existingSpecs } : {}),
        ...(derived.candidates.length > 0 ? { candidates: derived.candidates } : {}),
        ...(change ? { change } : {}),
        ...(input.devBaseUrl ? { artifactRefs: [{ id: "dev-base-url", path: input.devBaseUrl }] } : {}),
      });
    const budget = this.deps.contextBudget;
    if (!budget) return { brief: build(derived.change) };
    const measure = (change: BriefChange | undefined): ContextFit =>
      budget.fit({ prompt: { bytes: Buffer.byteLength(assembleSidekickBrief(this.deps.redaction, build(change)).text, "utf8") }, role: "author", ...(model ? { model } : {}) });
    if (!derived.change) return { brief: build(undefined), contextFit: measure(undefined) };
    const fitted = fitBriefChange(derived.change, measure);
    if (fitted.referenced > 0 || fitted.fit.outcome === "over") {
      engineLog.warn(`[qa] flow ${flow.id}'s brief ${fitted.fit.outcome === "over" ? "is over the author's window even" : "fits the author's window"} with ${fitted.referenced} owned hunk(s) named by file and range instead of preloaded (${fitted.change.hunks.length} preloaded)`);
    }
    return { brief: build(fitted.change), contextFit: fitted.fit };
  }

  /* What one turn of a sidekick came to, from what the orchestrator sees: the workspace, the flow's run_spec ledger and the Context Pack's reads. */
  private async assess(entry: LiveFlow, context: FlowContext, result: DelegationResult, signal: AbortSignal): Promise<FlowReport> {
    const { input } = context;
    const { flow, delegationId, tier } = entry;
    const sidekickKind = flow.kind;
    entry.turns += 1;
    entry.last = result;
    const attempt = entry.turns;
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
    const failureClass = classifyDelegationFailure(result.status, result.filesChanged.length, copied ? 1 : 0, result.readMiss);
    const { loop } = entry;
    const ledger = loop?.ledger() ?? [];
    const lastCall = ledger.at(-1);
    this.record(input, {
      kind: "delegation",
      action: "delegate",
      sidekickKind,
      tier,
      reason: result.readMiss ? `flow ${flow.id} turn ${attempt}: sidekick answer ${result.readMiss}${copied ? ", file taken back" : ""}` : `flow ${flow.id} turn ${attempt}: sidekick status=${result.status}${copied ? ", file taken back" : ""}`,
      delegationId,
      attempt,
      flowId: flow.id,
      ...(flow.candidates.length > 0 ? { candidateIds: flow.candidates } : {}),
      ...(failureClass ? { failureClass } : {}),
      sidekickStatus: result.readMiss ?? result.status,
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
      if (appDefect) this.record(input, { kind: "delegation", action: "delegate", sidekickKind, tier, reason: `flow ${flow.id}: ${appDefect}; the spec that showed it is taken back`, delegationId, attempt, flowId: flow.id, failureClass: AUTHORING_FAILURE.APP_DEFECT });
      return { outcome: { id: flow.id, kind: FLOW_OUTCOME.DELIVERED, specs: [flow.specFile] }, proposals };
    }
    if (appDefect) {
      this.record(input, { kind: "delegation", action: "delegate", sidekickKind, tier, reason: `flow ${flow.id}: ${appDefect}; the spec that showed it is no longer the sidekick's, and no attempt is made to make it pass`, delegationId, attempt, flowId: flow.id, failureClass: AUTHORING_FAILURE.APP_DEFECT });
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
      if (room !== undefined && room < MIN_FLOW_MS) break;
      const underReview = await Promise.all(flows.map((flow) => this.underReview(flow, live.get(flow.id), reports.get(flow.id)!, input)));
      const gaps = candidateGapsOf(decided.admission, dropped, flows.map((flow, i) => ({ routes: flow.routes, candidates: flow.candidates, review: underReview[i]! })));
      let reply: { output: string; timedOut: boolean };
      try {
        const request = assembleLeadReview(this.deps.redaction, withSpecDigests(underReview, seen, turn), { turn, maxTurns: MAX_REVIEW_TURNS }, gaps);
        reply = await lead.ask(request.text, turnOpts(request, Math.min(input.settings.planBudgetMs, room ?? input.settings.planBudgetMs)));
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
      const admission = admitLeadReview(this.deps.redaction, reply.output, underReview, { revisionsAllowed: turn < MAX_REVIEW_TURNS });
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
      if (orders.length === 0) break;
      const after = this.room(input);
      if (after !== undefined && after < MIN_FLOW_MS) break;
      const slots = orders.map((order) => {
        const flow = live.get(order.flowId)!.flow;
        return { ...order, id: order.flowId, budgetMs: Math.min(flow.budgetMs, after ?? flow.budgetMs) };
      });
      for (const order of orders) {
        if (order.action === REVIEW_ACTION.REVISE) tally.revised += 1;
        else tally.replaced += 1;
        this.record(input, { kind: "lead-decision", flowId: order.flowId, decision: order.action, overridden: order.overrideReason !== undefined, ...(order.overrideReason !== undefined ? { overrideReason: order.overrideReason } : {}), reason: `review turn ${turn}: flow ${order.flowId} ${order.action}`, delegationId: live.get(order.flowId)!.delegationId });
      }
      const results = await this.dispatcher.run(slots, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (slot, signal) => this.revise(live.get(slot.flowId)!, slot, slot.budgetMs, context, signal));
      await this.settle(results, live, reports);
      if (input.signal?.aborted) break;
    }
  }

  /* One revision the lead ordered: its instruction, with the orchestrator's facts, to the sidekick's own session; or to a fresh one, on the escalated capability. */
  private async revise(entry: LiveFlow, order: ReviewOrder, timeoutMs: number, context: FlowContext, signal: AbortSignal): Promise<FlowReport> {
    const instruction = [order.instruction, orchestratorFacts(entry, await this.currentSpecSha(entry, context.input))].filter(Boolean).join("\n");
    if (order.action === REVIEW_ACTION.REVISE && entry.session) {
      const result = await this.untilStopped(entry, entry.session.ask(instruction, { timeoutMs: Math.max(1, timeoutMs) }), signal);
      return this.assess(entry, context, result, signal);
    }
    await this.closeSession(entry);
    entry.tier = SIDEKICK_TIER.ESCALATED;
    const result = await this.openSession(entry, context, signal, timeoutMs, instruction);
    return this.assess(entry, context, result, signal);
  }

  /*
   * A follow-up turn in a session kept open, ended with its flow: the session's own signal belonged to the turn that opened it, so
   * a stop of the run (or of this flow's slot) closes the session, which ends the turn, and the flow is stopped.
   */
  private async untilStopped<T>(entry: LiveFlow, turn: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      await this.closeSession(entry);
      throw new Error(`flow ${entry.flow.id} was stopped before its follow-up turn`);
    }
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void this.closeSession(entry);
        reject(new Error(`flow ${entry.flow.id} was stopped during its follow-up turn`));
      };
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
      answer: last?.answerMiss ? { kind: last.answerMiss } : { kind: "read", ...(last?.summary ? { summary: last.summary } : {}), concerns: last?.concerns ?? [] },
      ...(loop ? { runSpec: { calls: ledger.length, maxCalls: loop.limits.maxCalls, ...(lastCall ? { lastStatus: lastCall.status } : {}), ...(lastFailure ? { lastFailure, lastFailureOn } : {}) } } : {}),
      verified: loop ? await loop.isClosed().catch(() => false) : false,
      ...(entry?.appDefect ? { appDefect: entry.appDefect } : {}),
      sessionOpen: entry?.session !== undefined,
      ...(spec !== undefined ? { spec } : {}),
    };
  }

  /* The pass, kept open: corrections are asked of the lead's planning session and carried out by the flows' sidekicks. */
  private passOf(lead: LeadSessionHandle, flows: AdmittedFlow[], parallel: number, context: FlowContext, live: Map<string, LiveFlow>): CoordinatedPass {
    const tally: CorrectionTally = { turns: 0, routed: 0, unrouted: 0, revised: 0, replaced: 0, rebutted: 0 };
    const state = { released: false };
    /* The pass's own list of flows: the plan's, then the maintenance flows it opens. */
    const pool = [...flows];
    return {
      correct: (findings, origin = CORRECTION_ORIGIN.REVIEW, omitted = 0) => this.correct(lead, pool, parallel, context, live, findings, origin, tally, state, omitted),
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
  private async correct(lead: LeadSessionHandle, flows: AdmittedFlow[], parallel: number, context: FlowContext, live: Map<string, LiveFlow>, findings: readonly CorrectionFinding[], origin: CorrectionOrigin, tally: CorrectionTally, state: { released: boolean }, omitted = 0): Promise<PassCorrection> {
    const { input } = context;
    /* What the caps cut from the gap is told to the lead as "recorded as left out": it is recorded here, in the run's coordination record and as a decision. */
    if (omitted > 0) {
      tally.omitted = (tally.omitted ?? 0) + omitted;
      this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): ${omitted} further unit(s) of the gap were left out of the turn by the caps and are not corrected now` });
    }
    const nothing = (why: string, code: string): PassCorrection => {
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
      return { id: flow.id, objective: flow.objective, specFile: flow.specFile, sessionOpen: live.get(flow.id)!.session !== undefined, candidates: cited.map((c) => c.id), seedFiles: [...new Set(cited.flatMap((c) => c.seeds.map((seed) => seed.file)))], ...(spec !== undefined ? { spec } : {}) };
    }));
    const askLead = async (request: AssembledPrompt, again: boolean): Promise<string> => {
      try {
        const answer = await lead.ask(request.text, turnOpts(request, Math.min(input.settings.planBudgetMs, this.room(input) ?? input.settings.planBudgetMs)));
        if (answer.timedOut) this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): the lead ran out of its time${again ? "; its first answer stands" : "; each flow is sent its own findings"}` });
        else return answer.output;
      } catch (err) {
        if (isRunDeadlineError(err)) throw err;
        this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): the lead's turn failed (${err instanceof Error ? err.message : String(err)})${again ? "; its first answer stands" : "; each flow is sent its own findings"}` });
      }
      return "";
    };
    const output = await askLead(assembleLeadCorrection(this.deps.redaction, under, findings, origin, omitted), false);
    tally.turns += 1;
    let admission = admitLeadCorrection(this.deps.redaction, output, under, findings, origin);
    for (const r of admission.refused) this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): ${r.flowId ? `flow ${r.flowId} ` : ""}${r.finding ? `finding ${r.finding} ` : ""}not taken: ${r.reason}` });
    /* An order the orchestrator refused leaves findings with no flow: the lead is told why once, in its open session, and its re-answer is admitted as any answer. */
    const roomAgain = this.room(input);
    if (admission.refused.length > 0 && admission.unrouted.length > 0 && !state.released && !input.signal?.aborted && (roomAgain === undefined || roomAgain >= MIN_FLOW_MS)) {
      this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): ${admission.refused.length} part(s) of the answer not admitted; asking the lead once more with the reasons` });
      const again = await askLead(assembleRefusedCorrection(admission.refused, findings.length), true);
      tally.turns += 1;
      const second = admitLeadCorrection(this.deps.redaction, again, under, findings, origin);
      if (second.readable && second.unrouted.length <= admission.unrouted.length) {
        admission = second;
        for (const r of second.refused) this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): ${r.flowId ? `flow ${r.flowId} ` : ""}${r.finding ? `finding ${r.finding} ` : ""}not taken after the second asking: ${r.reason}` });
      } else this.record(input, { kind: "lead-decision", origin, reason: `correction (${origin}): the lead's second answer did not improve on the first; the first stands` });
    }
    tally.rebutted += admission.rebuttals.length;
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
    await this.settle(results, live, new Map());
    const specs = [...new Set([...slots.map((slot) => slot.flowId), ...maintenance.map((m) => m.flow.id)].flatMap((id) => (live.get(id)?.taken ? [live.get(id)!.flow.specFile] : [])))];
    /* The findings of a maintenance flow that put nothing in the working copy were corrected by nobody. */
    const idle = maintenance.filter((m) => !live.get(m.flow.id)?.taken);
    const left = [...unrouted.filter((i) => !maintained.has(i)), ...idle.flatMap((m) => m.indices)].sort((a, b) => a - b);
    tally.unrouted += left.length;
    /* A finding about a file no use case of the change is seeded by has no flow to own it, and the record says so. */
    const seedless = left.filter((i) => seedsNoCandidate(findings[i]!, input.candidates ?? []));
    this.leftUnrouted(input, origin, seedless, "the file they name seeds no use case of the change, so no flow owns them and none can be opened", "no-seed-use-case");
    this.leftUnrouted(input, origin, left.filter((i) => !seedless.includes(i)), "no flow took them and no cold author is run for them", "no-flow-took");
    const finalUnrouted = left;
    this.record(input, { kind: "lead-decision", origin, ...routingSummary(findings, under, orders, untaken, maintenance, idle, left, seedless), reason: `correction (${origin}): ${findings.length} finding(s) routed` });
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
      const owners = (input.candidates ?? []).filter((c) => c.existingSpecs.some((file) => file === spec || file.endsWith(`/${spec}`)));
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
    engineLog.error(`[qa] correction (${origin}): ${indices.length} finding(s) left unrouted (${which}): ${reason}`);
  }

  /* One flow's correction: its workspace brought up to the working copy, then the findings and the lead's instruction to its sidekick. */
  private async amend(entry: LiveFlow, order: CorrectionOrder, origin: CorrectionOrigin, timeoutMs: number, context: FlowContext, signal: AbortSignal): Promise<FlowReport> {
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
    return this.revise(entry, { flowId: order.flowId, action: order.action, instruction }, timeoutMs, context, signal);
  }

  /* What the run can still spend on flows and the lead's turns: what is left of it less what it keeps for what follows. Undefined: no deadline. */
  private room(input: CoordinateInput): number | undefined {
    const left = this.remaining(input);
    return left === undefined ? undefined : left - this.reserve(left);
  }

  private remaining(input: CoordinateInput): number | undefined {
    return (input.deadline ?? this.deps.deadline)?.remainingMs();
  }

  private reserve(remaining: number): number {
    return Math.max(MIN_RESERVE_MS, Math.floor(remaining * RESERVE_SHARE));
  }

  /* The flows the run can author with `remaining` of its time (the reserve kept) and the app's ceiling; undefined when nothing bounds them. */
  private capacity(input: CoordinateInput, parallel: number, remaining: number | undefined): number | undefined {
    return flowCapacity({
      maxParallel: parallel,
      flowBudgetMs: input.settings.flowBudgetMs.opencode,
      ...(remaining !== undefined ? { remainingMs: remaining, reserveMs: this.reserve(remaining) } : { reserveMs: 0 }),
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

  private record(input: CoordinateInput, event: Omit<CoordinationTelemetryEvent, "runId" | "app" | "at" | "kind" | "action"> & { kind: "proposal" | "delegation" | "escalation" | "lead-decision"; action?: "direct" | "delegate" | "escalate-sidekick" | "abort-human" }): void {
    this.deps.telemetry?.record({ runId: input.runId, app: input.app, at: this.now(), ...event });
  }
}

/*
 * How a correction turn's findings ended, as the structured attributes of its summary event: the count per route (a finding the lead
 * rebutted is in none) and why the unrouted ones were left, as distinct codes.
 */
function routingSummary(findings: readonly CorrectionFinding[], under: readonly FlowUnderCorrection[], orders: readonly CorrectionOrder[], untaken: readonly number[], maintenance: ReadonlyArray<{ flow: AdmittedFlow; indices: number[] }>, idle: ReadonlyArray<{ indices: number[] }>, left: readonly number[], seedless: readonly number[]): Pick<CoordinationTelemetryEvent, "findings" | "routes" | "unroutedReasons"> {
  const ordered = new Set(orders.flatMap((o) => o.indices));
  const opened = new Set(maintenance.flatMap((m) => m.indices));
  const stranded = new Set(idle.flatMap((m) => m.indices));
  const unrouted = new Set(left);
  const routes = { spec: 0, candidate: 0, lead: 0, candidateFlow: 0, unrouted: 0 };
  const reasons = new Set<string>();
  findings.forEach((finding, i) => {
    if (unrouted.has(i)) {
      routes.unrouted += 1;
      reasons.add(seedless.includes(i) ? "no-seed-use-case" : stranded.has(i) ? "maintenance-flow-empty" : untaken.includes(i) ? "flow-unavailable" : "no-flow-took");
    } else if (ordered.has(i)) {
      const by = routeOfFinding(finding, under)?.by;
      if (by === "spec") routes.spec += 1;
      else if (by === "candidate") routes.candidate += 1;
      else routes.lead += 1;
    } else if (opened.has(i)) routes.candidateFlow += 1;
  });
  return { findings: findings.length, routes, ...(reasons.size > 0 ? { unroutedReasons: [...reasons] } : {}) };
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

/* The pages the flow's run_spec calls read empty at a failure point, each once. */
function emptyReadEvidence(redaction: RedactionPort, ledger: readonly FlowLedgerEntry[]): EvidenceRef[] {
  const paths = ledger.flatMap((entry) => (entry.failures ?? []).flatMap((f) => (f.resultCount === 0 && f.path !== undefined ? [f.path] : [])));
  return [...new Set(paths)].map((path) => evidenceFromEmptyRead(redaction, path));
}

const MAX_FACTS_CHARS = 2_000;

/* The options of a lead turn: its time, and the sizes and hashes of the sections its prompt was assembled from, so the transport's trace can split the turn. */
function turnOpts(assembled: AssembledPrompt, timeoutMs: number): { timeoutMs: number; sectionSizes: Record<string, number>; sectionHashes?: Record<string, string> } {
  return { timeoutMs, sectionSizes: assembled.sectionSizes, ...(assembled.sectionHashes ? { sectionHashes: assembled.sectionHashes } : {}) };
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
