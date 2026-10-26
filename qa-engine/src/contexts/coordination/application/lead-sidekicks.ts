/*
 * The lead/sidekick mode of one run: the lead is asked for a plan; a plan of independent flows is authored by sidekicks in
 * parallel, each in a workspace of its own and each closing its own run_spec loop; what each flow wrote comes back by the one rule
 * of the workspace. The lead then reviews the flows in its planning session: it accepts a flow, sends an instruction to the
 * sidekick that wrote it (whose session, workspace and loop are kept for it), starts a fresh sidekick on it, or drops one that
 * delivered nothing; its answer is admitted against the orchestrator's facts (lead-review.ts). The flows are added up the way a
 * generation ends. Whatever cannot be coordinated goes back to the lead as one piece of work, with the reason recorded: no plan,
 * no time, nobody to author with, a plan that cannot be admitted, flows that finished nothing.
 * Nothing here decides a verdict: it returns what a generation would, and the run reads it as it reads any generation.
 */

import type { AgentProvider } from "@kernel/agent-role.ts";
import { posix } from "node:path";
import { PROBE_REL_DIR } from "@contexts/test-execution/application/index.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { CoordinationGateSignal, CoordinationSettings, PlanningLimits } from "@kernel/coordination.ts";
import { formatGeoLocation, type GeoLocation } from "@kernel/geolocation.ts";
import { isRunDeadlineError } from "../../../shared-kernel/run-deadline.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowFailureFact, FlowGeolocationHandle, FlowLedgerEntry, FlowLoopHandle, GeolocationHandle } from "@contexts/agent-tools/application/index.ts";
import type { LeadSessionHandle, PlanOutput } from "../domain/plan-output.ts";
import type { DelegationWorkspace, DelegationWorkspacePort, DelegationWorkspaceRequest, WorkspaceChange } from "./ports/delegation-workspace.port.ts";
import { createDelegationBrief } from "./delegation-brief.ts";
import { proofsFor } from "./change-proofs.ts";
import type { GraphPage } from "@kernel/change-pages.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { classifyDelegationFailure } from "./delegation-failure-class.ts";
import { admitLeadReview, changePagesOf, MAX_REVIEW_TURNS, renderLeadReview, unvisitedBy, REVIEW_ACTION, type FlowUnderReview, type ReviewOrder } from "./lead-review.ts";
import type { CoordinationTelemetryPort } from "./coordination-telemetry.ts";
import { PLAN_SNAPSHOT_KIND, type PlanSnapshotFlow, type PlanSnapshotKind, type PlanSnapshotPort } from "@kernel/ports/plan-snapshot.port.ts";
import type { AgentCapability } from "./agent-capability.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import { evidenceFromEmptyRead } from "./evidence-from.ts";
import { observationConflictIn } from "./evidence-precedence.ts";
import { AUTHORING_FAILURE, authoringFailureFeedback, classifyAuthoringFailure, type AuthoringFailure } from "./authoring-failure.ts";
import { FanOutDispatcher, FLOW_RESULT, type TimerPort } from "./fan-out-dispatcher.ts";
import { aggregateFlowOutcomes, FLOW_OUTCOME, type AggregatedFlows, type FlowOutcome } from "./flow-outcomes.ts";
import { admitLeadPlan, LEAD_PLAN_KIND, type AdmittedFlow, type AdmittedPlan } from "./lead-plan.ts";
import { resolveSidekickModel } from "./resolve-sidekick-model.ts";
import { SIDEKICK_AUTHORING, sidekickAuthoring, sidekickDeniedTools, type SidekickAuthoringMode } from "./sidekick-authoring.ts";
import type { SidekickExecutor, SidekickSession } from "./sidekick-executor.ts";
import { packPagesFor } from "@contexts/generation/application/index.ts";
import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import { scrub } from "./scrub.ts";
import { CORRECTION_ORIGIN, admitLeadCorrection, correctionPreamble, renderLeadCorrection, type CorrectionOrigin, type CorrectionOrder, type CorrectionRebuttal, type FlowUnderCorrection, type CorrectionFinding } from "./lead-correction.ts";

/* The flow's slice of the Context Pack, as a brief field, or nothing when the pack did not read its pages. */
const pagesOf = (pack: string | undefined, routes: readonly string[]): { pages: string } | undefined => {
  const pages = packPagesFor(pack, routes);
  return pages === undefined ? undefined : { pages };
};

const proofsOf = (proofs: readonly GraphPage[] | undefined, routes: readonly string[]): { proofs: string[] } | undefined => {
  const lines = proofsFor(proofs, routes);
  return lines === undefined ? undefined : { proofs: lines };
};

/* Less than this of a flow's time left and a second attempt is not started; less than this of the run and a plan is not asked for. */
export const MIN_FLOW_MS = 60_000;
/* What a run keeps for what follows the flows (validation, execution, the reviewer): a quarter of what is left, and never less than this. */
export const MIN_RESERVE_MS = 120_000;
export const RESERVE_SHARE = 0.25;

export interface LeadSidekicksDeps {
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
  /* The run's deadline as the agents' turns read it; a call may bring its own. Absent: nothing bounds the run's time. */
  deadline?: { remainingMs(): number | undefined };
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
  facts: { hasLogin: boolean; provider: AgentProvider | undefined; plannerProvider: AgentProvider | undefined };
  closedLoop?: ClosedLoopHandle;
  agentBrowser?: AgentBrowserHandle;
  /* The run's authoring location, when the app declares one: a flow may name a place and each flow owns its own value. */
  geolocation?: GeolocationHandle;
  devBaseUrl?: string;
  knownFacts?: readonly EvidenceRef[];
  /* The run's Context Pack: each flow's brief carries the Live DOM of the pages that flow visits. */
  contextPack?: string;
  /* The pages of the app's map the change is linked to: the planning turn is told them, and those no admitted flow visits are reported. */
  changeRoutes?: readonly string[];
  /* The proof the call graph found for each change page it added: each flow's brief carries those of the pages it visits. */
  changeProofs?: readonly GraphPage[];
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
  /* The change is authored by the lead as one piece of work. `unvisited`: the change pages the admitted plan left unvisited, which the lead's authoring turn is told. */
  | { action: "lead"; signal: CoordinationGateSignal; unvisited?: string[] }
  /* The lead declared that nothing is worth a test. */
  | { action: "noop"; reason: string; signal: CoordinationGateSignal }
  /* The flows were authored; `aggregated` says how it ended, as a generation would. */
  | { action: "fanout"; aggregated: AggregatedFlows; proposals: FlowProposals[]; signal: CoordinationGateSignal; pass?: CoordinatedPass };

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
}

/*
 * A coordinated pass kept open after it delivered: the lead's planning session and every flow's sidekick session, workspace, loop
 * and location, for the corrections that follow: the static gate's, the execution's, the change-coverage's and the reviewer's.
 * Whoever holds it releases it, however the run ends.
 */
export interface CoordinatedPass {
  /* One correction turn over findings of one origin; the reviewer's when none is named. */
  correct(findings: readonly CorrectionFinding[], origin?: CorrectionOrigin): Promise<PassCorrection>;
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
  capability: AgentCapability;
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
    const base = { flows: 0, delivered: 0, incomplete: 0, takeover: false } as const;
    const leadAlone = (downgrade: string, extra: Partial<CoordinationGateSignal> = {}, unvisited?: string[]): CoordinateResult => {
      this.deps.log?.(`coordination: the change is authored by the lead as one piece of work (${downgrade})`);
      return { action: "lead", signal: { ...base, downgrade, ...extra }, ...(unvisited?.length ? { unvisited } : {}) };
    };

    if (!input.plan) return leadAlone("the generation cannot plan");
    /* A plan is a read-only turn, and what keeps it so is a per-prompt tool denial that not every runtime has: on one that has none the lead would plan with its hands free in the run's working copy. */
    if (input.facts.plannerProvider !== "opencode") {
      return leadAlone(`the lead plans on ${input.facts.plannerProvider ?? "a runtime the host cannot name"}, which cannot hold the planning turn to read-only; only OpenCode denies the write tools per prompt`);
    }
    const authoring = sidekickAuthoring({
      hasLogin: input.facts.hasLogin,
      provider: input.facts.provider,
      runSpecGranted: input.closedLoop !== undefined,
      browserGranted: input.agentBrowser !== undefined,
    });
    if (authoring.mode === SIDEKICK_AUTHORING.EXCLUDED) return leadAlone(`no sidekick: ${authoring.reason}`, { authoring: SIDEKICK_AUTHORING.EXCLUDED });
    const authoringName = authoring.mode;

    const { settings } = input;
    const parallel = Math.min(settings.maxParallel, authoring.maxParallel ?? settings.maxParallel);
    const before = this.remaining(input);
    if (before !== undefined && before < settings.planBudgetMs + MIN_RESERVE_MS + MIN_FLOW_MS * 2) {
      return leadAlone("too little of the run is left to plan and author in parallel", { authoring: authoringName });
    }

    await this.sweep().catch((err: unknown) => console.error(`[qa] sweeping the delegation workspaces failed (the run goes on): ${err instanceof Error ? err.message : String(err)}`));
    const locations = input.geolocation?.placeNames() ?? [];
    const planned = await input.plan({
      maxFlows: settings.maxFlows,
      maxParallel: parallel,
      budgetMs: settings.planBudgetMs,
      ...(locations.length > 0 ? { locations } : {}),
      ...(input.changeRoutes?.length ? { changeRoutes: input.changeRoutes } : {}),
    });
    /* The lead's planning session, when the plan kept it: its review of the flows is asked there, and it ends with the pass. */
    let leadHanded = false;
    try {
      if (planned.timedOut) return leadAlone("the planning turn ran out of its time", { authoring: authoringName });
      if (planned.noopReason !== undefined) {
        this.record(input, { kind: "proposal", action: "direct", reason: `plan: noop (${planned.noopReason})` });
        this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.NOOP, [], planned.noopReason);
        return { action: "noop", reason: planned.noopReason, signal: { ...base, plan: LEAD_PLAN_KIND.NOOP, authoring: authoringName } };
      }

      const remaining = this.remaining(input);
      const loop = input.closedLoop?.limits;
      const admitted = admitLeadPlan(
        planned.plan,
        {
          maxFlows: settings.maxFlows,
          maxParallel: parallel,
          flowBudgetMs: settings.flowBudgetMs.opencode,
          ...(remaining !== undefined ? { remainingMs: remaining } : {}),
          reserveMs: remaining === undefined ? 0 : this.reserve(remaining),
          minFlowMs: MIN_FLOW_MS,
          ...(loop ? { runSpecCalls: loop.maxCalls, runSpecDevWrites: loop.maxDevWrites } : {}),
          ...(input.agentBrowser ? { browserCalls: input.agentBrowser.limits.maxCalls } : {}),
        },
        {
          specRelDir: input.specRelDir,
          specFileFor: this.deps.specFileFor,
          ...(input.geolocation ? { places: input.geolocation.facts().places } : {}),
        },
      );
      this.record(input, { kind: "proposal", action: admitted.kind === LEAD_PLAN_KIND.FANOUT ? "delegate" : "direct", reason: describePlan(admitted) });
      if (admitted.kind === LEAD_PLAN_KIND.NOOP) {
        this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.NOOP, [], admitted.reason);
        return { action: "noop", reason: admitted.reason, signal: { ...base, plan: LEAD_PLAN_KIND.NOOP, authoring: authoringName } };
      }
      if (admitted.kind === LEAD_PLAN_KIND.LEAD) {
        this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.LEAD, [], admitted.downgrade);
        /* The lead authors in a turn of its own: it is told the change pages its plan did not visit, as a fan-out's review is. */
        const unvisited = unvisitedBy(input.changeRoutes ?? [], admitted.routes ?? []);
        this.reportUnvisited(input, unvisited);
        return leadAlone(admitted.downgrade ?? "the plan is one piece of work", { plan: LEAD_PLAN_KIND.LEAD, authoring: authoringName }, unvisited);
      }
      this.reportUnvisited(input, this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.FANOUT, admitted.flows));
      const result = await this.fanOut(input, admitted.flows, admitted.parallel, { mode: authoring.mode, ...(planned.lead ? { lead: planned.lead } : {}) }, { ...base, plan: LEAD_PLAN_KIND.FANOUT, authoring: authoringName });
      /* A pass kept open holds the lead's session from here on. */
      if (result.action === "fanout" && result.pass) leadHanded = true;
      return result;
    } finally {
      if (!leadHanded) await planned.lead?.dispose().catch((err: unknown) => console.error(`[qa] closing the lead's session failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /* The flows of an admitted plan: each authored once, then reviewed by the lead, then added up. Every flow's resources end here, however the pass ends. */
  private async fanOut(input: CoordinateInput, flows: AdmittedFlow[], parallel: number, how: { mode: SidekickAuthoringMode; lead?: LeadSessionHandle }, base: CoordinationGateSignal): Promise<CoordinateResult> {
    const context: FlowContext = { input, mode: how.mode };
    const live = new Map<string, LiveFlow>();
    const reports = new Map<string, FlowReport>();
    let handed = false;
    try {
      const results = await this.dispatcher.run(flows, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (flow, signal) => this.author(flow, context, live, signal));
      await this.settle(results, live, reports);

      const tally: ReviewTally = { turns: 0, accepted: 0, revised: 0, replaced: 0, dropped: 0, refused: 0 };
      if (how.lead && !input.signal?.aborted) await this.review(how.lead, flows, parallel, context, live, reports, tally);

      const outcomes = flows.map((flow) => reports.get(flow.id)?.outcome ?? { id: flow.id, kind: FLOW_OUTCOME.FAILED, reason: "no attempt could be made" });
      const proposals = flows.flatMap((flow) => {
        const p = reports.get(flow.id)?.proposals;
        return p && p.total > 0 ? [p] : [];
      });
      const aggregated = aggregateFlowOutcomes(outcomes);
      this.snapshotPlan(input, PLAN_SNAPSHOT_KIND.FANOUT, flows, undefined, outcomes);
      const signal: CoordinationGateSignal = {
        ...base,
        flows: flows.length,
        delivered: outcomes.filter((o) => o.kind === FLOW_OUTCOME.DELIVERED).length,
        incomplete: aggregated.incompleteFlows.length,
        ...(tally.turns > 0 ? { review: tally } : {}),
      };
      for (const p of proposals) this.deps.log?.(`coordination: flow ${p.flowId} changed ${p.total} file(s) it was not given to write; they are proposals and were not applied`);

      /* The last resort: flows that finished nothing and decided nothing hand the change back to the lead, while the run has time for it. */
      const left = this.remaining(input);
      if (aggregated.end === GENERATION_END.UNDECIDED_EMPTY && (left === undefined || left > MIN_RESERVE_MS + MIN_FLOW_MS)) {
        this.record(input, { kind: "escalation", action: "lead-takeover", reason: `no flow finished or decided (${aggregated.note ?? "nothing to add up"})` });
        this.deps.log?.("coordination: no flow finished or decided; the lead takes the change over");
        return { action: "lead", signal: { ...signal, takeover: true, downgrade: "no flow finished or decided" } };
      }
      /* With the lead's session the pass is kept open for the reviewer's corrections; its holder releases it. */
      if (how.lead && !input.signal?.aborted && aggregated.end === GENERATION_END.DELIVERED) {
        handed = true;
        return { action: "fanout", aggregated, proposals, signal, pass: this.passOf(how.lead, flows, parallel, context, live) };
      }
      return { action: "fanout", aggregated, proposals, signal };
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
          console.error(`[qa] flow ${result.id} failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
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
    const entry: LiveFlow = { flow, delegationId, workspace, request, capability: "sidekick-standard", turns: 0, delivered: false, ...(geolocation ? { geolocation } : {}) };
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
    const model = resolveSidekickModel(entry.capability, this.deps.escalatedModel);
    const session = await this.deps.sidekick.open(this.briefOf(entry, context), {
      cwd: entry.workspace.dir,
      capability: entry.capability,
      ...(model ? { model } : {}),
      signal,
      timeoutMs: Math.max(1, timeoutMs),
      delegationId: entry.delegationId,
      denyTools: sidekickDeniedTools(context.mode, entry.loop !== undefined),
      ...(feedback ? { feedback } : {}),
    });
    /* A session that opened after its flow was stopped or released belongs to nobody: it is closed at once. */
    if (signal.aborted || entry.released) {
      await session.dispose().catch((err: unknown) => console.error(`[qa] closing flow ${entry.flow.id}'s late session failed: ${err instanceof Error ? err.message : String(err)}`));
      throw new Error(`flow ${entry.flow.id}'s session opened after the flow was stopped`);
    }
    entry.session = session;
    return session.first;
  }

  private briefOf(entry: LiveFlow, context: FlowContext) {
    const { input } = context;
    const { flow } = entry;
    return createDelegationBrief({
      delegationId: entry.delegationId,
      runId: input.runId,
      objective: flow.objective,
      task: taskOf(flow, entry.loop, context.mode === SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER && input.agentBrowser ? input.agentBrowser.limits.perCallMs : undefined, entry.geolocation),
      acceptanceCriteria: flow.acceptance,
      scope: { readablePaths: ["."], writablePaths: flow.writablePaths, allowedCommands: [] },
      knownFacts: input.knownFacts ?? [],
      ...(pagesOf(input.contextPack, flow.routes) ?? {}),
      ...(proofsOf(input.changeProofs, flow.routes) ?? {}),
      ...(input.devBaseUrl ? { artifactRefs: [{ id: "dev-base-url", path: input.devBaseUrl }] } : {}),
    });
  }

  /* What one turn of a sidekick came to, from what the orchestrator sees: the workspace, the flow's run_spec ledger and the Context Pack's reads. */
  private async assess(entry: LiveFlow, context: FlowContext, result: DelegationResult, signal: AbortSignal): Promise<FlowReport> {
    const { input } = context;
    const { flow, delegationId, capability } = entry;
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
    const failureClass = classifyDelegationFailure(result.status, result.filesChanged.length, copied ? 1 : 0);
    const { loop } = entry;
    const ledger = loop?.ledger() ?? [];
    const lastCall = ledger.at(-1);
    this.record(input, {
      kind: "delegation",
      action: "delegate",
      capability,
      reason: `flow ${flow.id} turn ${attempt}: sidekick status=${result.status}${copied ? ", file taken back" : ""}`,
      delegationId,
      attempt,
      ...(failureClass ? { failureClass } : {}),
      sidekickStatus: result.status,
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
      if (appDefect) this.record(input, { kind: "delegation", action: "delegate", capability, reason: `flow ${flow.id}: ${appDefect}; the spec that showed it is taken back`, delegationId, attempt, failureClass: AUTHORING_FAILURE.APP_DEFECT });
      return { outcome: { id: flow.id, kind: FLOW_OUTCOME.DELIVERED, specs: [flow.specFile] }, proposals };
    }
    if (appDefect) {
      this.record(input, { kind: "delegation", action: "delegate", capability, reason: `flow ${flow.id}: ${appDefect}; the spec that showed it is no longer the sidekick's, and no attempt is made to make it pass`, delegationId, attempt, failureClass: AUTHORING_FAILURE.APP_DEFECT });
      return this.keepDelivered(entry, { outcome: { id: flow.id, kind: FLOW_OUTCOME.FAILED, reason: `${appDefect}; the spec that showed it is no longer in the workspace` }, proposals: undefined });
    }
    /* What the run knows beside what the sidekick says: the pages the Context Pack read with results, and the pages the flow's own run_spec calls read empty. */
    const evidence = [...(input.knownFacts ?? []), ...emptyReadEvidence(ledger)];
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
  private async review(lead: LeadSessionHandle, flows: AdmittedFlow[], parallel: number, context: FlowContext, live: Map<string, LiveFlow>, reports: Map<string, FlowReport>, tally: ReviewTally): Promise<void> {
    const { input } = context;
    for (let turn = 1; turn <= MAX_REVIEW_TURNS; turn++) {
      const room = this.room(input);
      if (room !== undefined && room < MIN_FLOW_MS) break;
      const underReview = await Promise.all(flows.map((flow) => this.underReview(flow, live.get(flow.id), reports.get(flow.id)!, input)));
      const changePages = changePagesOf(input.changeRoutes ?? [], flows.map((flow, i) => ({ routes: flow.routes, review: underReview[i]! })));
      let answer: { output: string; timedOut: boolean };
      try {
        answer = await lead.ask(renderLeadReview(underReview, { turn, maxTurns: MAX_REVIEW_TURNS }, changePages), { timeoutMs: Math.min(input.settings.planBudgetMs, room ?? input.settings.planBudgetMs) });
      } catch (err) {
        /* The run's own time spent ends the run; any other failure of the lead's turn leaves the flows as they are. */
        if (isRunDeadlineError(err)) throw err;
        tally.turns += 1;
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: the lead's turn failed (${err instanceof Error ? err.message : String(err)}); the flows stand as they are` });
        break;
      }
      tally.turns += 1;
      if (answer.timedOut) {
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: the lead ran out of its time; the flows stand as they are` });
        break;
      }
      const admission = admitLeadReview(answer.output, underReview, { revisionsAllowed: turn < MAX_REVIEW_TURNS });
      if (!admission.readable) {
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: the lead's answer could not be read; the flows stand as they are` });
        break;
      }
      tally.accepted += admission.accepted.length;
      tally.refused += admission.refused.length;
      for (const r of admission.refused) this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: flow ${r.flowId} ${r.action} not taken: ${r.reason}` });
      for (const d of admission.dropped) {
        tally.dropped += 1;
        reports.set(d.flowId, { outcome: { id: d.flowId, kind: FLOW_OUTCOME.DECLINED, reason: `dropped by the lead: ${d.reason}` }, proposals: undefined });
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: flow ${d.flowId} dropped: ${d.reason}` });
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
        this.record(input, { kind: "lead-decision", reason: `review turn ${turn}: flow ${order.flowId} ${order.action}`, delegationId: live.get(order.flowId)!.delegationId });
      }
      const results = await this.dispatcher.run(slots, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (slot, signal) => this.revise(live.get(slot.flowId)!, slot, slot.budgetMs, context, signal));
      await this.settle(results, live, reports);
      if (input.signal?.aborted) break;
    }
  }

  /* One revision the lead ordered: its instruction, with the orchestrator's facts, to the sidekick's own session; or to a fresh one, on the escalated capability. */
  private async revise(entry: LiveFlow, order: ReviewOrder, timeoutMs: number, context: FlowContext, signal: AbortSignal): Promise<FlowReport> {
    const instruction = [order.instruction, orchestratorFacts(entry)].filter(Boolean).join("\n");
    if (order.action === REVIEW_ACTION.REVISE && entry.session) {
      const result = await this.untilStopped(entry, entry.session.ask(instruction, { timeoutMs: Math.max(1, timeoutMs) }), signal);
      return this.assess(entry, context, result, signal);
    }
    await this.closeSession(entry);
    entry.capability = "sidekick-escalated";
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

  /* A flow as the lead's review is shown it: the orchestrator's facts first, the sidekick's word beside them. */
  private async underReview(flow: AdmittedFlow, entry: LiveFlow | undefined, report: FlowReport, input: CoordinateInput): Promise<FlowUnderReview> {
    const loop = entry?.loop;
    const ledger = loop?.ledger() ?? [];
    const lastCall = ledger.at(-1);
    const delivered = report.outcome.kind === FLOW_OUTCOME.DELIVERED;
    const spec = delivered && this.deps.readSpec ? await this.deps.readSpec({ mirrorDir: input.mirrorDir, specDir: input.specDir }, flow.specFile).catch(() => undefined) : undefined;
    const lastFailure = lastCall?.status === "failed" ? describeFailure(lastCall.failures) : undefined;
    return {
      id: flow.id,
      objective: flow.objective,
      acceptance: flow.acceptance,
      outcome: report.outcome,
      ...(entry?.last?.summary ? { summary: entry.last.summary } : {}),
      concerns: entry?.last?.concerns ?? [],
      ...(loop ? { runSpec: { calls: ledger.length, maxCalls: loop.limits.maxCalls, ...(lastCall ? { lastStatus: lastCall.status } : {}), ...(lastFailure ? { lastFailure } : {}) } } : {}),
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
    return {
      correct: (findings, origin = CORRECTION_ORIGIN.REVIEW) => this.correct(lead, flows, parallel, context, live, findings, origin, tally, state),
      tally: () => ({ ...tally }),
      release: async () => {
        if (state.released) return;
        state.released = true;
        for (const entry of live.values()) await this.release(entry);
        await lead.dispose().catch((err: unknown) => console.error(`[qa] closing the lead's session failed: ${err instanceof Error ? err.message : String(err)}`));
      },
    };
  }

  /* One correction turn: the lead routes the findings, the orchestrator holds it to its facts, and each flow sent findings is corrected by its sidekick. */
  private async correct(lead: LeadSessionHandle, flows: AdmittedFlow[], parallel: number, context: FlowContext, live: Map<string, LiveFlow>, findings: readonly CorrectionFinding[], origin: CorrectionOrigin, tally: CorrectionTally, state: { released: boolean }): Promise<PassCorrection> {
    const { input } = context;
    const nothing = (why: string): PassCorrection => {
      this.record(input, { kind: "lead-decision", reason: `correction (${origin}): ${why}; the findings stand` });
      return { readable: false, specs: [], rebuttals: [], unrouted: findings.map((_, i) => i) };
    };
    if (state.released) return nothing("the pass was released");
    if (findings.length === 0) return { readable: true, specs: [], rebuttals: [], unrouted: [] };
    const room = this.room(input);
    if (room !== undefined && room < MIN_FLOW_MS) return nothing("too little of the run is left");
    const under: FlowUnderCorrection[] = await Promise.all(flows.filter((flow) => live.has(flow.id)).map(async (flow) => {
      const spec = this.deps.readSpec ? await this.deps.readSpec({ mirrorDir: input.mirrorDir, specDir: input.specDir }, flow.specFile).catch(() => undefined) : undefined;
      return { id: flow.id, objective: flow.objective, specFile: flow.specFile, sessionOpen: live.get(flow.id)!.session !== undefined, ...(spec !== undefined ? { spec } : {}) };
    }));
    let output = "";
    try {
      const answer = await lead.ask(renderLeadCorrection(under, findings, origin), { timeoutMs: Math.min(input.settings.planBudgetMs, room ?? input.settings.planBudgetMs) });
      if (answer.timedOut) this.record(input, { kind: "lead-decision", reason: `correction (${origin}): the lead ran out of its time; each flow is sent its own findings` });
      else output = answer.output;
    } catch (err) {
      if (isRunDeadlineError(err)) throw err;
      this.record(input, { kind: "lead-decision", reason: `correction (${origin}): the lead's turn failed (${err instanceof Error ? err.message : String(err)}); each flow is sent its own findings` });
    }
    tally.turns += 1;
    const admission = admitLeadCorrection(output, under, findings, origin);
    tally.rebutted += admission.rebuttals.length;
    tally.unrouted += admission.unrouted.length;
    for (const r of admission.refused) this.record(input, { kind: "lead-decision", reason: `correction (${origin}): ${r.flowId ? `flow ${r.flowId} ` : ""}${r.finding ? `finding ${r.finding} ` : ""}not taken: ${r.reason}` });
    const after = this.room(input);
    const stopped = state.released || input.signal?.aborted === true || (after !== undefined && after < MIN_FLOW_MS);
    const orders = stopped ? [] : admission.orders.filter((o) => live.has(o.flowId));
    /* A finding the lead sent to a flow that cannot take it now is not lost: it goes to a regeneration, as a finding no flow was sent. */
    const untaken = admission.orders.filter((o) => !orders.includes(o)).flatMap((o) => o.indices);
    tally.unrouted += untaken.length;
    if (untaken.length > 0) this.record(input, { kind: "lead-decision", reason: `correction (${origin}): ${untaken.length} finding(s) the flows could not take go to a regeneration` });
    for (const order of orders) {
      tally.routed += order.findings.length;
      if (order.action === REVIEW_ACTION.REVISE) tally.revised += 1;
      else tally.replaced += 1;
      this.record(input, { kind: "lead-decision", reason: `correction (${origin}): flow ${order.flowId} ${order.action} with ${order.findings.length} finding(s)`, delegationId: live.get(order.flowId)!.delegationId });
    }
    const slots = orders.map((order) => ({ ...order, id: order.flowId, budgetMs: Math.min(live.get(order.flowId)!.flow.budgetMs, after ?? live.get(order.flowId)!.flow.budgetMs) }));
    for (const slot of slots) live.get(slot.flowId)!.taken = false;
    /* A claim is read only from a turn this correction made: a flow whose turn failed keeps the result of an earlier one. */
    const turnsBefore = new Map(slots.map((slot) => [slot.flowId, live.get(slot.flowId)!.turns]));
    const results = await this.dispatcher.run(slots, { maxParallel: parallel, ...(input.signal ? { signal: input.signal } : {}) }, (slot, signal) => this.amend(live.get(slot.flowId)!, slot, origin, slot.budgetMs, context, signal));
    await this.settle(results, live, new Map());
    const specs = slots.flatMap((slot) => (live.get(slot.flowId)?.taken ? [live.get(slot.flowId)!.flow.specFile] : []));
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
      unrouted: [...admission.unrouted, ...untaken],
      ...(claims.length > 0 ? { testCorrect: { cause: claims.every((c) => c.cause === "env") ? "env" : "app", reason: claims.map((c) => c.reason).join("; ") } } : {}),
    };
  }

  /* One flow's correction: its workspace brought up to the working copy, then the findings and the lead's instruction to its sidekick. */
  private async amend(entry: LiveFlow, order: CorrectionOrder, origin: CorrectionOrigin, timeoutMs: number, context: FlowContext, signal: AbortSignal): Promise<FlowReport> {
    await this.deps.workspaces.refresh(entry.workspace, entry.request).catch((err: unknown) => console.error(`[qa] refreshing flow ${entry.flow.id}'s workspace failed (it corrects the bytes it has): ${err instanceof Error ? err.message : String(err)}`));
    const instruction = [
      correctionPreamble(origin),
      ...order.findings.map((finding) => `- ${scrub(finding)}`),
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

  private async closeSession(entry: LiveFlow | undefined): Promise<void> {
    const session = entry?.session;
    if (!entry || !session) return;
    entry.session = undefined;
    await session.dispose().catch((err: unknown) => console.error(`[qa] closing flow ${entry.flow.id}'s session failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /* Everything a flow held, released: its session, its loop, its location and its workspace. Never throws. */
  private async release(entry: LiveFlow): Promise<void> {
    entry.released = true;
    await this.closeSession(entry);
    if (entry.loop) await entry.loop.close().catch((err: unknown) => console.error(`[qa] closing flow ${entry.flow.id}'s run_spec loop failed: ${err instanceof Error ? err.message : String(err)}`));
    entry.geolocation?.close();
    await this.deps.workspaces.dispose(entry.workspace);
  }

  /* Keeps what the run planned, and returns the change pages no flow visits. A flow visits a change page when one of its routes names it (`namesTemplatePage`). */
  private snapshotPlan(input: CoordinateInput, kind: PlanSnapshotKind, flows: readonly AdmittedFlow[], reason?: string, outcomes?: readonly FlowOutcome[]): string[] {
    const changeRoutes = [...(input.changeRoutes ?? [])];
    const snapshotFlows: PlanSnapshotFlow[] = flows.map((flow) => {
      const outcome = outcomes?.find((o) => o.id === flow.id);
      return {
        id: flow.id,
        objective: flow.objective,
        acceptance: [...flow.acceptance],
        routes: [...flow.routes],
        specFile: flow.specFile,
        visits: changeRoutes.filter((route) => flow.routes.some((visited) => namesTemplatePage(route, visited))),
        ...(outcome ? { outcome: { kind: outcome.kind, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}), ...(outcome.specs ? { specs: [...outcome.specs] } : {}) } } : {}),
      };
    });
    const unvisited = unvisitedBy(changeRoutes, flows.flatMap((flow) => flow.routes));
    try {
      this.deps.planSnapshots?.record({ runId: input.runId, kind, ...(reason !== undefined ? { reason } : {}), changeRoutes, unvisited, flows: snapshotFlows, recordedAt: this.now() });
    } catch (err) {
      console.error(`[qa] the run's plan could not be kept (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
    return unvisited;
  }

  private reportUnvisited(input: CoordinateInput, unvisited: readonly string[]): void {
    if (unvisited.length > 0) this.record(input, { kind: "lead-decision", reason: `plan: ${unvisited.length} of ${input.changeRoutes!.length} change page(s) no flow visits: ${unvisited.join(", ")}` });
  }

  private record(input: CoordinateInput, event: { kind: "proposal" | "delegation" | "escalation" | "lead-decision"; action?: "direct" | "delegate" | "lead-takeover" | "escalate-sidekick" | "abort-human"; capability?: AgentCapability; reason: string; delegationId?: string; attempt?: number; durationMs?: number; failureClass?: string; progressFingerprint?: string; sidekickStatus?: string; lastRunSpec?: string }): void {
    this.deps.telemetry?.record({ runId: input.runId, app: input.app, at: this.now(), ...event });
  }
}

function describePlan(plan: AdmittedPlan): string {
  if (plan.kind === LEAD_PLAN_KIND.FANOUT) return `plan: fanout of ${plan.flows.length} flow(s), ${plan.parallel} at a time`;
  if (plan.kind === LEAD_PLAN_KIND.NOOP) return `plan: noop (${plan.reason})`;
  return `plan: lead${plan.downgrade ? ` (downgraded: ${plan.downgrade})` : ""}`;
}

/* What a sidekick is told to do for one flow. The facts about its tools are the orchestrator's; the rest is the flow's own. */
function taskOf(
  flow: AdmittedFlow,
  loop: FlowLoopHandle | undefined,
  browserCallMs: number | undefined,
  geolocation: FlowGeolocationHandle | undefined,
): string {
  const places = geolocation ? Object.keys(geolocation.facts().places).sort() : [];
  const browserUsesLocation = browserCallMs !== undefined && flow.browserCalls > 0 ? " The authenticated browser uses the authoring location." : "";
  return [
    `Write the Playwright E2E spec for ONE flow, as the single file ${flow.writablePaths[0]}. It is the only file you may write.`,
    `Flow: ${flow.id}. It proves: ${flow.objective}`,
    flow.routes.length > 0 ? `Pages it visits: ${flow.routes.join(", ")}` : "",
    geolocation
      ? `Authoring location: ${formatGeoLocation(geolocation.current())}; the app's default is ${formatGeoLocation(geolocation.facts().default)}.${places.length > 0 ? ` Places it declares: ${places.join(", ")}.` : ""}${browserUsesLocation} run_spec and the suite run at the app's default. A spec that depends on a location must call setLocation(context, latitude, longitude) from the suite's fixtures with the coordinates.`
      : "",
    loop
      ? `run_spec: at most ${loop.limits.maxCalls} calls, ${Math.round(loop.limits.perCallMs / 1000)} seconds each, ${loop.limits.maxDevWrites} requests that write to DEV in all. It runs ${flow.writablePaths[0]} and no other file. Run it until it passes, then finish.`
      : "You cannot run the spec: verify it by reading the pages and the grounding.",
    browserCallMs !== undefined && flow.browserCalls > 0
      ? `Authenticated browser: at most ${flow.browserCalls} authbrowser_* calls, ${Math.round(browserCallMs / 1000)} seconds each. It reads DEV as the test account and never writes.`
      : "",
    `Finish by emitting the DelegationResult JSON contract from the brief. If this flow needs no test of its own, write no file and say why in summary.`,
  ].filter(Boolean).join("\n");
}

/* The pages the flow's run_spec calls read empty at a failure point, each once. */
function emptyReadEvidence(ledger: readonly FlowLedgerEntry[]): EvidenceRef[] {
  const paths = ledger.flatMap((entry) => (entry.failures ?? []).flatMap((f) => (f.resultCount === 0 && f.path !== undefined ? [f.path] : [])));
  return [...new Set(paths)].map(evidenceFromEmptyRead);
}

const MAX_FACTS_CHARS = 2_000;

/* What the orchestrator adds to an instruction of the lead's: what it saw of the flow's last run_spec call, the kind of failure it met, and the reads that disagree. */
function orchestratorFacts(entry: LiveFlow): string {
  const lastRun = entry.loop?.ledger().at(-1)?.status;
  const kind = authoringFailureFeedback(entry.failure);
  const facts = [
    entry.loop ? (lastRun ? `- The last run_spec call ended ${lastRun}.` : "- No run_spec call of yours was seen.") : "",
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
