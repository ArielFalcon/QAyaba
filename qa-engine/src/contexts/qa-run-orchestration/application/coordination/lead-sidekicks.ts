/*
 * The lead/sidekick mode of one run: the lead is asked for a plan; a plan of independent flows is authored by sidekicks in
 * parallel, each in a workspace of its own and each closing its own run_spec loop; what each flow wrote comes back by the one rule
 * of the workspace; and the flows are added up the way a generation ends. Whatever cannot be coordinated goes back to the lead as
 * one piece of work, with the reason recorded: no plan, no time, nobody to author with, a plan that cannot be admitted, flows
 * that finished nothing. A flow climbs the escalation ladder on what the orchestrator saw of its run_spec calls, never on the
 * sidekick's word: a sidekick that asks for the lead, or that makes no progress between attempts, is handed back.
 * Nothing here decides a verdict: it returns what a generation would, and the run reads it as it reads any generation.
 */

import { posix } from "node:path";
import { PROBE_REL_DIR } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { CoordinationGateSignal, CoordinationSettings, PlanningLimits } from "@kernel/coordination.ts";
import { COORDINATION_MODE } from "@kernel/coordination.ts";
import { isRunDeadlineError } from "../../../../shared-kernel/run-deadline.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowLoopHandle, PlanOutput } from "../ports/index.ts";
import type { DelegationWorkspace, DelegationWorkspacePort, DelegationWorkspaceRequest, WorkspaceChange } from "../ports/delegation-workspace.port.ts";
import { createDelegationBrief } from "./delegation-brief.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { classifyDelegationFailure } from "./delegation-failure-class.ts";
import type { CoordinationTelemetryPort } from "./coordination-telemetry.ts";
import type { AgentCapability } from "./agent-capability.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import { FanOutDispatcher, FLOW_RESULT, type TimerPort } from "./fan-out-dispatcher.ts";
import { aggregateFlowOutcomes, FLOW_OUTCOME, type AggregatedFlows, type FlowOutcome } from "./flow-outcomes.ts";
import { admitLeadPlan, LEAD_PLAN_KIND, type AdmittedFlow, type AdmittedPlan } from "./lead-plan.ts";
import { buildProgressSnapshot, routeOrchestration, type ProgressSnapshot } from "./orchestration-router.ts";
import { resolveSidekickModel } from "./resolve-sidekick-model.ts";
import { SIDEKICK_AUTHORING, sidekickAuthoring, sidekickDeniedTools, type SidekickAuthoringMode } from "./sidekick-authoring.ts";
import type { SidekickExecutor } from "./sidekick-executor.ts";

/* Less than this of a flow's time left and a second attempt is not started; less than this of the run and a plan is not asked for. */
export const MIN_FLOW_MS = 60_000;
/* What a run keeps for what follows the flows (validation, execution, the reviewer): a quarter of what is left, and never less than this. */
export const MIN_RESERVE_MS = 120_000;
export const RESERVE_SHARE = 0.25;

export interface LeadSidekicksDeps {
  sidekick: Pick<SidekickExecutor, "execute">;
  workspaces: DelegationWorkspacePort;
  timers: TimerPort;
  telemetry?: CoordinationTelemetryPort;
  now?: () => number;
  /* The model the second attempt of a flow runs with; absent: the same as the first. */
  escalatedModel?: string;
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
  /* What the sidekicks would author with: whether the app has a login, and the runtime the sidekick role is assigned to. */
  facts: { hasLogin: boolean; provider: "opencode" | "codex" | undefined };
  closedLoop?: ClosedLoopHandle;
  agentBrowser?: AgentBrowserHandle;
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
    const before = (input.deadline ?? this.deps.deadline)?.remainingMs();
    if (before !== undefined && before < settings.planBudgetMs + MIN_RESERVE_MS + MIN_FLOW_MS * 2) {
      return single("too little of the run is left to plan and author in parallel", { authoring: authoringName });
    }

    await this.sweep().catch((err: unknown) => console.error(`[qa] sweeping the delegation workspaces failed (the run goes on): ${err instanceof Error ? err.message : String(err)}`));
    const planned = await input.plan({ maxFlows: settings.maxFlows, maxParallel: parallel, budgetMs: settings.planBudgetMs });
    if (planned.timedOut) return single("the planning turn ran out of its time", { authoring: authoringName });
    if (planned.noopReason !== undefined) {
      this.record(input, { kind: "proposal", action: "direct", reason: `plan: noop (${planned.noopReason})` });
      return { action: "noop", reason: planned.noopReason, signal: { ...base, plan: LEAD_PLAN_KIND.NOOP, authoring: authoringName } };
    }

    const remaining = (input.deadline ?? this.deps.deadline)?.remainingMs();
    const loop = input.closedLoop?.limits;
    const admitted = admitLeadPlan(
      planned.plan,
      {
        maxFlows: settings.maxFlows,
        maxParallel: parallel,
        flowBudgetMs: settings.flowBudgetMs.opencode,
        ...(remaining !== undefined ? { remainingMs: remaining } : {}),
        reserveMs: remaining === undefined ? 0 : Math.max(MIN_RESERVE_MS, Math.floor(remaining * RESERVE_SHARE)),
        minFlowMs: MIN_FLOW_MS,
        ...(loop ? { runSpecCalls: loop.maxCalls, runSpecDevWrites: loop.maxDevWrites } : {}),
        ...(input.agentBrowser ? { browserCalls: input.agentBrowser.limits.maxCalls } : {}),
      },
      { specRelDir: input.specRelDir, specFileFor: this.deps.specFileFor },
    );
    this.record(input, { kind: "proposal", action: admitted.kind === LEAD_PLAN_KIND.FANOUT ? "delegate" : "direct", reason: describePlan(admitted) });
    if (admitted.kind === LEAD_PLAN_KIND.NOOP) return { action: "noop", reason: admitted.reason, signal: { ...base, plan: LEAD_PLAN_KIND.NOOP, authoring: authoringName } };
    if (admitted.kind === LEAD_PLAN_KIND.SINGLE) {
      return single(admitted.downgrade ?? "the plan is one piece of work", { plan: LEAD_PLAN_KIND.SINGLE, authoring: authoringName });
    }

    const context: FlowContext = { input, mode: authoring.mode };
    const results = await this.dispatcher.run(
      admitted.flows,
      { maxParallel: admitted.parallel, ...(input.signal ? { signal: input.signal } : {}) },
      (flow, signal) => this.runFlow(flow, context, signal),
    );
    const outcomes: FlowOutcome[] = [];
    const proposals: FlowProposals[] = [];
    for (const result of results) {
      switch (result.status) {
        case FLOW_RESULT.SETTLED:
          outcomes.push(result.value.outcome);
          if (result.value.proposals && result.value.proposals.total > 0) proposals.push(result.value.proposals);
          break;
        case FLOW_RESULT.TIMED_OUT:
          outcomes.push({ id: result.id, kind: FLOW_OUTCOME.TIMED_OUT });
          break;
        case FLOW_RESULT.ABORTED:
          outcomes.push({ id: result.id, kind: FLOW_OUTCOME.FAILED, reason: "the run was cancelled" });
          break;
        case FLOW_RESULT.THREW:
          /* The run's own time spent ends the run, not a flow. */
          if (isRunDeadlineError(result.error)) throw result.error;
          console.error(`[qa] flow ${result.id} failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
          outcomes.push({ id: result.id, kind: FLOW_OUTCOME.FAILED, reason: "the sidekick's session failed" });
          break;
      }
    }

    const aggregated = aggregateFlowOutcomes(outcomes);
    const signal: CoordinationGateSignal = {
      ...base,
      plan: LEAD_PLAN_KIND.FANOUT,
      flows: admitted.flows.length,
      delivered: outcomes.filter((o) => o.kind === FLOW_OUTCOME.DELIVERED).length,
      incomplete: aggregated.incompleteFlows.length,
      authoring: authoringName,
    };
    for (const p of proposals) this.deps.log?.(`coordination: flow ${p.flowId} changed ${p.total} file(s) it was not given to write; they are proposals and were not applied`);

    /* The last rung of the ladder: flows that finished nothing and decided nothing hand the change back to the lead, while the run has time for it. */
    const left = (input.deadline ?? this.deps.deadline)?.remainingMs();
    if (aggregated.end === GENERATION_END.UNDECIDED_EMPTY && (left === undefined || left > MIN_RESERVE_MS + MIN_FLOW_MS)) {
      this.record(input, { kind: "escalation", action: "lead-takeover", reason: `no flow finished or decided (${aggregated.note ?? "nothing to add up"})` });
      this.deps.log?.("coordination: no flow finished or decided; the lead takes the change over");
      return { action: "single", signal: { ...signal, takeover: true, downgrade: "no flow finished or decided" } };
    }
    return { action: "fanout", aggregated, proposals, signal };
  }

  /* One flow: a workspace, a loop, up to two attempts, and what came of it. The workspace and the loop go however the flow ends. */
  private async runFlow(flow: AdmittedFlow, context: FlowContext, signal: AbortSignal): Promise<FlowReport> {
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
    let loop: FlowLoopHandle | undefined;
    try {
      const probePath = `${PROBE_REL_DIR}/${posix.basename(flow.specFile)}`;
      if (input.closedLoop && flow.runSpecCalls > 0) {
        loop = input.closedLoop.openFlow({
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
      return await this.attempts(flow, context, workspace, request, delegationId, loop, signal);
    } finally {
      if (loop) await loop.close();
      await this.deps.workspaces.dispose(workspace);
    }
  }

  private async attempts(flow: AdmittedFlow, context: FlowContext, workspace: DelegationWorkspace, request: DelegationWorkspaceRequest, delegationId: string, loop: FlowLoopHandle | undefined, signal: AbortSignal): Promise<FlowReport> {
    const { input } = context;
    const started = this.now();
    const capabilities: AgentCapability[] = ["sidekick-standard", "sidekick-escalated"];
    const denyTools = sidekickDeniedTools(context.mode, loop !== undefined);
    let previous: ProgressSnapshot | undefined;
    let feedback: string | undefined;
    let last: DelegationResult | undefined;

    for (const [index, capability] of capabilities.entries()) {
      const attempt = index + 1;
      const left = flow.budgetMs - (this.now() - started);
      if (attempt > 1 && left < MIN_FLOW_MS) break;
      const brief = createDelegationBrief({
        delegationId,
        runId: input.runId,
        objective: flow.objective,
        task: taskOf(flow, loop, context.mode === SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER && input.agentBrowser ? input.agentBrowser.limits.perCallMs : undefined),
        acceptanceCriteria: flow.acceptance,
        scope: { readablePaths: ["."], writablePaths: flow.writablePaths, allowedCommands: [] },
        knownFacts: input.knownFacts ?? [],
        ...(input.devBaseUrl ? { artifactRefs: [{ id: "dev-base-url", path: input.devBaseUrl }] } : {}),
      });
      const model = resolveSidekickModel(capability, this.deps.escalatedModel);
      const startedAttempt = this.now();
      const result = await this.deps.sidekick.execute(brief, {
        cwd: workspace.dir,
        capability,
        ...(model ? { model } : {}),
        signal,
        timeoutMs: Math.max(1, left),
        delegationId,
        denyTools,
        ...(feedback ? { feedback } : {}),
      });
      last = result;
      const eligible = result.status === "completed" || result.status === "completed-with-concerns";
      let copied = false;
      let proposals: FlowProposals | undefined;
      let refusal: string | undefined;
      /* Whether the workspace shows the sidekick changed no file at all: its own list of what it changed is its word, this is what is on disk. */
      let workspaceUntouched = false;
      if (eligible && !signal.aborted) {
        const collected = await this.deps.workspaces.collect(workspace, request);
        copied = collected.copied.length > 0;
        refusal = collected.refused[0] ? `${collected.refused[0].path}: ${collected.refused[0].reason}` : undefined;
        workspaceUntouched = collected.proposalsTotal === 0;
        if (collected.proposalsTotal > 0) proposals = { flowId: flow.id, changes: collected.proposals, total: collected.proposalsTotal };
      }
      const failureClass = classifyDelegationFailure(result.status, result.filesChanged.length, copied ? 1 : 0);
      this.record(input, {
        kind: "delegation",
        action: "delegate",
        capability,
        reason: `flow ${flow.id} attempt ${attempt}: sidekick status=${result.status}${copied ? ", file taken back" : ""}`,
        delegationId,
        attempt,
        durationMs: this.now() - startedAttempt,
        ...(failureClass ? { failureClass } : {}),
      });

      if (copied) {
        return { outcome: { id: flow.id, kind: FLOW_OUTCOME.DELIVERED, specs: [flow.specFile] }, proposals };
      }
      if (eligible && refusal === undefined && workspaceUntouched && result.filesChanged.length === 0 && result.summary.trim() !== "") {
        return { outcome: { id: flow.id, kind: FLOW_OUTCOME.DECLINED, reason: result.summary }, proposals };
      }

      const ledger = loop?.ledger() ?? [];
      const current = buildProgressSnapshot({
        failureClass: result.status,
        failingNames: ledger.map((entry) => entry.status),
        changedFiles: [...new Set(ledger.map((entry) => entry.sha256))],
      });
      const decision = routeOrchestration({
        evidence: [],
        currentCapability: capability,
        ...(previous ? { previous } : {}),
        current,
        budgetExhausted: flow.budgetMs - (this.now() - started) <= 0,
        infraFailure: false,
        sidekickNeedsLead: result.status === "needs-lead",
      });
      previous = current;
      if (decision.action === "escalate-sidekick" || decision.action === "lead-takeover" || decision.action === "abort-human") {
        this.record(input, { kind: "escalation", action: decision.action, capability, reason: `flow ${flow.id}: ${decision.reason}`, delegationId, attempt, progressFingerprint: current.failureFingerprint });
      }
      if (decision.action === "lead-takeover" || decision.action === "abort-human") break;
      if (decision.action !== "escalate-sidekick" && attempt < capabilities.length) {
        this.record(input, { kind: "escalation", action: "escalate-sidekick", capability: capabilities[attempt]!, reason: `flow ${flow.id}: ${decision.reason}; the next attempt runs on the escalated capability`, delegationId, attempt, progressFingerprint: current.failureFingerprint });
      }
      feedback = feedbackOf(result, ledger.at(-1)?.status, refusal);
    }
    const reason = last ? `${last.status}: ${last.summary}` : "no attempt could be made";
    return { outcome: { id: flow.id, kind: last?.status === "needs-lead" ? FLOW_OUTCOME.NEEDS_LEAD : FLOW_OUTCOME.FAILED, reason }, proposals: undefined };
  }

  private record(input: CoordinateInput, event: { kind: "proposal" | "delegation" | "escalation"; action?: "direct" | "delegate" | "lead-takeover" | "escalate-sidekick" | "abort-human"; capability?: AgentCapability; reason: string; delegationId?: string; attempt?: number; durationMs?: number; failureClass?: string; progressFingerprint?: string }): void {
    this.deps.telemetry?.record({ runId: input.runId, app: input.app, at: this.now(), ...event });
  }
}

function describePlan(plan: AdmittedPlan): string {
  if (plan.kind === LEAD_PLAN_KIND.FANOUT) return `plan: fanout of ${plan.flows.length} flow(s), ${plan.parallel} at a time`;
  if (plan.kind === LEAD_PLAN_KIND.NOOP) return `plan: noop (${plan.reason})`;
  return `plan: single${plan.downgrade ? ` (downgraded: ${plan.downgrade})` : ""}`;
}

/* What a sidekick is told to do for one flow. The facts about its tools are the orchestrator's; the rest is the flow's own. */
function taskOf(flow: AdmittedFlow, loop: FlowLoopHandle | undefined, browserCallMs: number | undefined): string {
  return [
    `Write the Playwright E2E spec for ONE flow, as the single file ${flow.writablePaths[0]}. It is the only file you may write.`,
    `Flow: ${flow.id}. It proves: ${flow.objective}`,
    flow.routes.length > 0 ? `Pages it visits: ${flow.routes.join(", ")}` : "",
    loop
      ? `run_spec: at most ${loop.limits.maxCalls} calls, ${Math.round(loop.limits.perCallMs / 1000)} seconds each, ${loop.limits.maxDevWrites} requests that write to DEV in all. It runs ${flow.writablePaths[0]} and no other file. Run it until it passes, then finish.`
      : "You cannot run the spec: verify it by reading the pages and the grounding.",
    browserCallMs !== undefined && flow.browserCalls > 0
      ? `Authenticated browser: at most ${flow.browserCalls} authbrowser_* calls, ${Math.round(browserCallMs / 1000)} seconds each. It reads DEV as the test account and never writes.`
      : "",
    `Finish by emitting the DelegationResult JSON contract from the brief. If this flow needs no test of its own, write no file and say why in summary.`,
  ].filter(Boolean).join("\n");
}

function feedbackOf(result: DelegationResult, lastRun: string | undefined, refusal: string | undefined): string {
  return [
    `Your first attempt did not deliver the spec (status ${result.status}).`,
    result.summary ? `You reported: ${result.summary}` : "",
    lastRun ? `The last run_spec call ended ${lastRun}.` : "No run_spec call of yours was seen.",
    refusal ? `The file could not be taken back: ${refusal}` : "",
    "Fix what is missing, write the file, and report again.",
  ].filter(Boolean).join("\n");
}
