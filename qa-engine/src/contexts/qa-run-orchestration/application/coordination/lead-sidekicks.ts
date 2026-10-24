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

import { posix } from "node:path";
import { PROBE_REL_DIR } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { CoordinationGateSignal, CoordinationSettings, PlanningLimits } from "@kernel/coordination.ts";
import { COORDINATION_MODE } from "@kernel/coordination.ts";
import { formatGeoLocation, type GeoLocation } from "@kernel/geolocation.ts";
import { isRunDeadlineError } from "../../../../shared-kernel/run-deadline.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowFailureFact, FlowGeolocationHandle, FlowLedgerEntry, FlowLoopHandle, GeolocationHandle, LeadSessionHandle, PlanOutput } from "../ports/index.ts";
import type { DelegationWorkspace, DelegationWorkspacePort, DelegationWorkspaceRequest, WorkspaceChange } from "../ports/delegation-workspace.port.ts";
import { createDelegationBrief } from "./delegation-brief.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { classifyDelegationFailure } from "./delegation-failure-class.ts";
import { admitLeadReview, MAX_REVIEW_TURNS, renderLeadReview, REVIEW_ACTION, type FlowUnderReview, type ReviewOrder } from "./lead-review.ts";
import type { CoordinationTelemetryPort } from "./coordination-telemetry.ts";
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
  facts: { hasLogin: boolean; provider: "opencode" | "codex" | undefined; plannerProvider: "opencode" | "codex" | undefined };
  closedLoop?: ClosedLoopHandle;
  agentBrowser?: AgentBrowserHandle;
  /* The run's authoring location, when the app declares one: a flow may name a place and each flow owns its own value. */
  geolocation?: GeolocationHandle;
  devBaseUrl?: string;
  knownFacts?: readonly EvidenceRef[];
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
  /* The change is authored by the lead as one piece of work. */
  | { action: "single"; signal: CoordinationGateSignal }
  /* The lead declared that nothing is worth a test. */
  | { action: "noop"; reason: string; signal: CoordinationGateSignal }
  /* The flows were authored; `aggregated` says how it ended, as a generation would. */
  | { action: "fanout"; aggregated: AggregatedFlows; proposals: FlowProposals[]; signal: CoordinationGateSignal };

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
    const base = { mode: COORDINATION_MODE.LEAD_SIDEKICKS, flows: 0, delivered: 0, incomplete: 0, takeover: false } as const;
    const single = (downgrade: string, extra: Partial<CoordinationGateSignal> = {}): CoordinateResult => {
      this.deps.log?.(`coordination: the change is authored by the lead as one piece of work (${downgrade})`);
      return { action: "single", signal: { ...base, downgrade, ...extra } };
    };

    if (!input.plan) return single("the generation cannot plan");
    /* A plan is a read-only turn, and what keeps it so is a per-prompt tool denial that not every runtime has: on one that has none the lead would plan with its hands free in the run's working copy. */
    if (input.facts.plannerProvider !== "opencode") {
      return single(`the lead plans on ${input.facts.plannerProvider ?? "a runtime the host cannot name"}, which cannot hold the planning turn to read-only; only OpenCode denies the write tools per prompt`);
    }
    const authoring = sidekickAuthoring({
      hasLogin: input.facts.hasLogin,
      provider: input.facts.provider,
      runSpecGranted: input.closedLoop !== undefined,
      browserGranted: input.agentBrowser !== undefined,
    });
    if (authoring.mode === SIDEKICK_AUTHORING.EXCLUDED) return single(`no sidekick: ${authoring.reason}`, { authoring: SIDEKICK_AUTHORING.EXCLUDED });
    const authoringName = authoring.mode;

    const { settings } = input;
    const parallel = Math.min(settings.maxParallel, authoring.maxParallel ?? settings.maxParallel);
    const before = this.remaining(input);
    if (before !== undefined && before < settings.planBudgetMs + MIN_RESERVE_MS + MIN_FLOW_MS * 2) {
      return single("too little of the run is left to plan and author in parallel", { authoring: authoringName });
    }

    await this.sweep().catch((err: unknown) => console.error(`[qa] sweeping the delegation workspaces failed (the run goes on): ${err instanceof Error ? err.message : String(err)}`));
    const locations = input.geolocation?.placeNames() ?? [];
    const planned = await input.plan({
      maxFlows: settings.maxFlows,
      maxParallel: parallel,
      budgetMs: settings.planBudgetMs,
      ...(locations.length > 0 ? { locations } : {}),
    });
    /* The lead's planning session, when the plan kept it: its review of the flows is asked there, and it ends with the pass. */
    try {
      if (planned.timedOut) return single("the planning turn ran out of its time", { authoring: authoringName });
      if (planned.noopReason !== undefined) {
        this.record(input, { kind: "proposal", action: "direct", reason: `plan: noop (${planned.noopReason})` });
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
      if (admitted.kind === LEAD_PLAN_KIND.NOOP) return { action: "noop", reason: admitted.reason, signal: { ...base, plan: LEAD_PLAN_KIND.NOOP, authoring: authoringName } };
      if (admitted.kind === LEAD_PLAN_KIND.SINGLE) {
        return single(admitted.downgrade ?? "the plan is one piece of work", { plan: LEAD_PLAN_KIND.SINGLE, authoring: authoringName });
      }
      return await this.fanOut(input, admitted.flows, admitted.parallel, { mode: authoring.mode, ...(planned.lead ? { lead: planned.lead } : {}) }, { ...base, plan: LEAD_PLAN_KIND.FANOUT, authoring: authoringName });
    } finally {
      await planned.lead?.dispose().catch((err: unknown) => console.error(`[qa] closing the lead's session failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /* The flows of an admitted plan: each authored once, then reviewed by the lead, then added up. Every flow's resources end here, however the pass ends. */
  private async fanOut(input: CoordinateInput, flows: AdmittedFlow[], parallel: number, how: { mode: SidekickAuthoringMode; lead?: LeadSessionHandle }, base: CoordinationGateSignal): Promise<CoordinateResult> {
    const context: FlowContext = { input, mode: how.mode };
    const live = new Map<string, LiveFlow>();
    const reports = new Map<string, FlowReport>();
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
        return { action: "single", signal: { ...signal, takeover: true, downgrade: "no flow finished or decided" } };
      }
      return { action: "fanout", aggregated, proposals, signal };
    } finally {
      for (const entry of live.values()) await this.release(entry);
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
      await session.dispose().catch(() => {});
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
    if (eligible && !signal.aborted && !entry.released) {
      const collected = await this.deps.workspaces.collect(entry.workspace, entry.request);
      copied = collected.copied.length > 0;
      entry.refusal = collected.refused[0] ? `${collected.refused[0].path}: ${collected.refused[0].reason}` : undefined;
      workspaceUntouched = collected.proposalsTotal === 0;
      if (collected.proposalsTotal > 0) proposals = { flowId: flow.id, changes: collected.proposals, total: collected.proposalsTotal };
    }
    const failureClass = classifyDelegationFailure(result.status, result.filesChanged.length, copied ? 1 : 0);
    this.record(input, {
      kind: "delegation",
      action: "delegate",
      capability,
      reason: `flow ${flow.id} turn ${attempt}: sidekick status=${result.status}${copied ? ", file taken back" : ""}`,
      delegationId,
      attempt,
      ...(failureClass ? { failureClass } : {}),
    });

    if (copied) {
      entry.delivered = true;
      return { outcome: { id: flow.id, kind: FLOW_OUTCOME.DELIVERED, specs: [flow.specFile] }, proposals };
    }
    const { loop } = entry;
    const ledger = loop?.ledger() ?? [];
    const lastCall = ledger.at(-1);
    /* What the flow's last run_spec call met, from the facts the orchestrator kept of it. */
    const failure = lastCall?.status === "failed" ? classifyAuthoringFailure(lastCall.failures) : undefined;
    entry.failure = failure;
    /* The app at fault: the spec is right to fail and is never sent back to be made green. The bytes that showed it are taken back as they ran, so the run's own execution reports the defect; with those bytes gone the flow ends on it. */
    if (failure?.kind === AUTHORING_FAILURE.APP_DEFECT && lastCall && loop) {
      const evidence = `app defect: ${failure.reason}`;
      entry.appDefect = failure.reason;
      if (!signal.aborted && !entry.released && (await loop.holds(lastCall.sha256))) {
        const collected = await this.deps.workspaces.collect(entry.workspace, entry.request);
        if (collected.copied.length > 0) {
          entry.delivered = true;
          this.record(input, { kind: "delegation", action: "delegate", capability, reason: `flow ${flow.id}: ${evidence}; the spec that showed it is taken back as it ran`, delegationId, attempt, failureClass: AUTHORING_FAILURE.APP_DEFECT });
          return { outcome: { id: flow.id, kind: FLOW_OUTCOME.DELIVERED, specs: [flow.specFile] }, proposals: collected.proposalsTotal > 0 ? { flowId: flow.id, changes: collected.proposals, total: collected.proposalsTotal } : undefined };
        }
      }
      this.record(input, { kind: "delegation", action: "delegate", capability, reason: `flow ${flow.id}: ${evidence}; the spec that showed it is no longer the sidekick's, and no attempt is made to make it pass`, delegationId, attempt, failureClass: AUTHORING_FAILURE.APP_DEFECT });
      return this.keepDelivered(entry, { outcome: { id: flow.id, kind: FLOW_OUTCOME.FAILED, reason: `${evidence}; the spec that showed it is no longer in the workspace` }, proposals: undefined });
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
      let answer: { output: string; timedOut: boolean };
      try {
        answer = await lead.ask(renderLeadReview(underReview, { turn, maxTurns: MAX_REVIEW_TURNS }), { timeoutMs: Math.min(input.settings.planBudgetMs, room ?? input.settings.planBudgetMs) });
      } catch (err) {
        /* The run's own time spent ends the run; any other failure of the lead's turn leaves the flows as they are. */
        if (isRunDeadlineError(err)) throw err;
        tally.turns += 1;
        this.record(input, { kind: "router", reason: `review turn ${turn}: the lead's turn failed (${err instanceof Error ? err.message : String(err)}); the flows stand as they are` });
        break;
      }
      tally.turns += 1;
      if (answer.timedOut) {
        this.record(input, { kind: "router", reason: `review turn ${turn}: the lead ran out of its time; the flows stand as they are` });
        break;
      }
      const admission = admitLeadReview(answer.output, underReview, { revisionsAllowed: turn < MAX_REVIEW_TURNS });
      if (!admission.readable) {
        this.record(input, { kind: "router", reason: `review turn ${turn}: the lead's answer could not be read; the flows stand as they are` });
        break;
      }
      tally.accepted += admission.accepted.length;
      tally.refused += admission.refused.length;
      for (const r of admission.refused) this.record(input, { kind: "router", reason: `review turn ${turn}: flow ${r.flowId} ${r.action} not taken: ${r.reason}` });
      for (const d of admission.dropped) {
        tally.dropped += 1;
        reports.set(d.flowId, { outcome: { id: d.flowId, kind: FLOW_OUTCOME.DECLINED, reason: `dropped by the lead: ${d.reason}` }, proposals: undefined });
        this.record(input, { kind: "router", reason: `review turn ${turn}: flow ${d.flowId} dropped: ${d.reason}` });
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
        this.record(input, { kind: "router", reason: `review turn ${turn}: flow ${order.flowId} ${order.action}`, delegationId: live.get(order.flowId)!.delegationId });
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
      const result = await entry.session.ask(instruction, { timeoutMs: Math.max(1, timeoutMs) });
      return this.assess(entry, context, result, signal);
    }
    await this.closeSession(entry);
    entry.capability = "sidekick-escalated";
    const result = await this.openSession(entry, context, signal, timeoutMs, instruction);
    return this.assess(entry, context, result, signal);
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
    if (entry.loop) await entry.loop.close().catch(() => {});
    entry.geolocation?.close();
    await this.deps.workspaces.dispose(entry.workspace);
  }

  private record(input: CoordinateInput, event: { kind: "proposal" | "delegation" | "escalation" | "router"; action?: "direct" | "delegate" | "lead-takeover" | "escalate-sidekick" | "abort-human"; capability?: AgentCapability; reason: string; delegationId?: string; attempt?: number; durationMs?: number; failureClass?: string; progressFingerprint?: string }): void {
    this.deps.telemetry?.record({ runId: input.runId, app: input.app, at: this.now(), ...event });
  }
}

function describePlan(plan: AdmittedPlan): string {
  if (plan.kind === LEAD_PLAN_KIND.FANOUT) return `plan: fanout of ${plan.flows.length} flow(s), ${plan.parallel} at a time`;
  if (plan.kind === LEAD_PLAN_KIND.NOOP) return `plan: noop (${plan.reason})`;
  return `plan: single${plan.downgrade ? ` (downgraded: ${plan.downgrade})` : ""}`;
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
