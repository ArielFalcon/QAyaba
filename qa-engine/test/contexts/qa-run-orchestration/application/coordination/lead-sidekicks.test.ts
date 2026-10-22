import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { COORDINATION_MODE, DEFAULT_COORDINATION_SETTINGS, type PlanningLimits } from "@kernel/coordination.ts";
import { MAX_SESSION_PAGES } from "@kernel/agent-browser.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import {
  LeadSidekicks,
  MIN_FLOW_MS,
  type CoordinateInput,
  type LeadSidekicksDeps,
} from "@contexts/qa-run-orchestration/application/coordination/lead-sidekicks.ts";
import type { TimerPort } from "@contexts/qa-run-orchestration/application/coordination/fan-out-dispatcher.ts";
import type { CoordinationTelemetryEvent } from "@contexts/qa-run-orchestration/application/coordination/coordination-telemetry.ts";
import type { DelegationResult } from "@contexts/qa-run-orchestration/application/coordination/delegation-result.ts";
import type { SidekickExecuteOpts } from "@contexts/qa-run-orchestration/application/coordination/sidekick-executor.ts";
import type { DelegationBrief } from "@contexts/qa-run-orchestration/application/coordination/delegation-brief.ts";
import type { DelegationCollection, DelegationWorkspace, DelegationWorkspacePort, DelegationWorkspaceRequest } from "@contexts/qa-run-orchestration/application/ports/delegation-workspace.port.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowLoopHandle, FlowLoopOpenInput, GeolocationHandle, PlanOutput } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { GeoLocation } from "@kernel/geolocation.ts";

class FakeTimers implements TimerPort {
  now = 0;
  private readonly pending = new Map<number, { at: number; fire: () => void }>();
  private next = 1;
  setTimer(ms: number, fire: () => void): () => void {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fire });
    return () => { this.pending.delete(id); };
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending]) if (t.at <= this.now) { this.pending.delete(id); t.fire(); }
  }
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

const FANOUT_PLAN = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total" }, { id: "login", objective: "sign in works" }] };

interface Script {
  /* What each attempt of a flow answers, by flow id; the last entry repeats. */
  answers: Record<string, Array<Partial<DelegationResult> & { throws?: Error; hold?: Promise<void> }>>;
  /* Flows whose file the workspace has when the work is taken back. */
  hasFile: Set<string>;
  proposals: Record<string, number>;
}

interface Rig {
  deps: LeadSidekicksDeps;
  coordinator: LeadSidekicks;
  timers: FakeTimers;
  executed: Array<{ brief: DelegationBrief; opts: SidekickExecuteOpts }>;
  created: string[];
  disposed: string[];
  collected: string[];
  staged: string[];
  swept: number;
  events: CoordinationTelemetryEvent[];
  logs: string[];
  flowLoops: Array<{ input: FlowLoopOpenInput; closed: number; ledger: Array<{ path: string; sha256: string; status: string; devWrites: number }> }>;
  shares: Array<[string, number]>;
  closedLoop: ClosedLoopHandle;
  agentBrowser: AgentBrowserHandle;
  script: Script;
  clock: { now: number };
}

function result(brief: DelegationBrief, over: Partial<DelegationResult> = {}): DelegationResult {
  return {
    delegationId: brief.delegationId, runId: brief.runId, status: "completed", summary: "wrote the spec", filesChanged: brief.scope.writablePaths.map((path) => ({ path })),
    evidence: [], validation: [], assumptions: [], concerns: [], unresolvedQuestions: [], recommendation: "accept", acceptance: [], ...over,
  };
}

function rig(scriptOver: Partial<Script> = {}): Rig {
  const timers = new FakeTimers();
  const clock = { now: 1_000_000 };
  const script: Script = { answers: {}, hasFile: new Set(["cart", "login"]), proposals: {}, ...scriptOver };
  const r = { timers, executed: [], created: [], disposed: [], collected: [], staged: [], swept: 0, events: [], logs: [], flowLoops: [], shares: [], script, clock } as unknown as Rig;
  const flowOf = (delegationId: string): string => delegationId.replace(/^.*-flow-/, "");
  const workspaces: DelegationWorkspacePort = {
    create: async (request: DelegationWorkspaceRequest): Promise<DelegationWorkspace> => {
      r.created.push(request.delegationId);
      return { dir: `/w/${request.delegationId}`, specDir: `/w/${request.delegationId}/e2e`, specRelDir: "e2e", files: 3, cut: false };
    },
    stage: async (_ws, request, path, probe) => { r.staged.push(`${request.delegationId}:${path}->${probe}`); return true; },
    collect: async (_ws, request): Promise<DelegationCollection> => {
      const flow = flowOf(request.delegationId);
      r.collected.push(flow);
      const has = script.hasFile.has(flow);
      const total = script.proposals[flow] ?? 0;
      return { copied: has ? [...request.writablePaths] : [], refused: [], proposals: Array.from({ length: Math.min(total, 5) }, (_, i) => ({ path: `src/p${i}.ts`, kind: "modified" as const, bytes: 1 })), proposalsTotal: total };
    },
    dispose: async (ws) => { r.disposed.push(ws.dir); },
    sweepAll: async () => { r.swept += 1; return 0; },
  };
  const attemptsOf = new Map<string, number>();
  r.deps = {
    sidekick: {
      execute: async (brief, opts) => {
        r.executed.push({ brief, opts });
        const flow = flowOf(brief.delegationId);
        const n = attemptsOf.get(flow) ?? 0;
        attemptsOf.set(flow, n + 1);
        const answers = script.answers[flow] ?? [{}];
        const answer = answers[Math.min(n, answers.length - 1)]!;
        if (answer.hold) await answer.hold;
        if (answer.throws) throw answer.throws;
        const { throws: _t, hold: _h, ...over } = answer;
        return result(brief, over);
      },
    },
    workspaces,
    timers,
    telemetry: { record: (event) => void r.events.push(event) },
    now: () => clock.now,
    escalatedModel: "escalated/model",
    specFileFor: (id) => `flows/${id}.spec.ts`,
    log: (text) => void r.logs.push(text),
  };
  r.coordinator = new LeadSidekicks(r.deps);
  r.closedLoop = {
    limits: { maxCalls: 8, perCallMs: 60_000, maxDevWrites: 12 },
    openFlow: (input) => {
      const entry = { input, closed: 0, ledger: [] as Array<{ path: string; sha256: string; status: string; devWrites: number }> };
      r.flowLoops.push(entry);
      const handle: FlowLoopHandle = {
        limits: { maxCalls: input.limits.maxCalls, perCallMs: 60_000, maxDevWrites: input.limits.maxDevWrites },
        signals: () => ({ calls: entry.ledger.length, devWrites: 0 }),
        ledger: () => entry.ledger,
        isClosed: async () => false,
        close: async () => { entry.closed += 1; },
      };
      return handle;
    },
    sweepProbes: async () => {},
    isClosed: async () => false,
    signals: () => ({ calls: 0, devWrites: 0 }),
    close: async () => {},
  };
  r.agentBrowser = {
    limits: { maxCalls: 60, perCallMs: 30_000, leaseWaitMs: 15_000 },
    grantShare: (id, calls) => void r.shares.push([id, calls]),
    signals: () => ({ calls: 0, blocks: 0, invalidations: 0, renewals: 0 }),
    close: async () => {},
  };
  return r;
}

function input(r: Rig, over: Partial<CoordinateInput> = {}): CoordinateInput {
  return {
    runId: "run-1", app: "shop", objective: "the cart", mirrorDir: "/m", specDir: "/m/e2e", specRelDir: "e2e",
    settings: { ...DEFAULT_COORDINATION_SETTINGS, mode: COORDINATION_MODE.LEAD_SIDEKICKS },
    facts: { hasLogin: true, provider: "opencode", plannerProvider: "opencode" },
    closedLoop: r.closedLoop,
    agentBrowser: r.agentBrowser,
    plan: async () => ({ plan: FANOUT_PLAN, parsed: true, timedOut: false }),
    ...over,
  };
}

test("a generation that cannot plan, a sidekick that cannot author and a run with too little time all leave the change to the lead, before any session is opened", async () => {
  const r = rig();
  let asked = 0;
  const plan = async (): Promise<PlanOutput> => { asked += 1; return { plan: FANOUT_PLAN, parsed: true, timedOut: false }; };

  const noPlan = await r.coordinator.coordinate(input(r, { plan: undefined }));
  assert.equal(noPlan.action, "single");

  const codex = await r.coordinator.coordinate(input(r, { plan, facts: { hasLogin: true, provider: "codex", plannerProvider: "opencode" } }));
  assert.equal(codex.action, "single");
  assert.equal(codex.signal.authoring, "excluded");

  const bare = await r.coordinator.coordinate(input(r, { plan, closedLoop: undefined, agentBrowser: undefined }));
  assert.equal(bare.action, "single", "a login and neither run_spec nor the browser");

  const hurried = await r.coordinator.coordinate(input(r, { plan, deadline: { remainingMs: () => 60_000 } }));
  assert.equal(hurried.action, "single");
  assert.equal(asked, 0, "none of them paid for a planning turn");
  assert.equal(r.executed.length, 0);
  assert.equal(r.created.length, 0);
});

test("a lead on a runtime that cannot hold the planning turn to read-only, or one the host cannot name, is not asked for a plan", async () => {
  const r = rig();
  let asked = 0;
  const plan = async (): Promise<PlanOutput> => { asked += 1; return { plan: FANOUT_PLAN, parsed: true, timedOut: false }; };
  for (const plannerProvider of ["codex", undefined] as const) {
    const outcome = await r.coordinator.coordinate(input(r, { plan, facts: { hasLogin: true, provider: "opencode", plannerProvider } }));
    assert.equal(outcome.action, "single", String(plannerProvider));
    assert.ok(outcome.signal.downgrade && /read-only/.test(outcome.signal.downgrade), "the downgrade says why");
  }
  assert.equal(asked, 0, "no planning turn was paid for");
  assert.equal(r.created.length, 0);
});

test("with the authenticated browser, a plan is never asked for more flows at once than the browser has pages, whatever the app allows", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const settings = { ...DEFAULT_COORDINATION_SETTINGS, mode: COORDINATION_MODE.LEAD_SIDEKICKS, maxParallel: MAX_SESSION_PAGES + 2 };
  await r.coordinator.coordinate(input(r, { settings, plan: async (p) => (seen.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(seen[0]!.maxParallel, MAX_SESSION_PAGES);
});

test("the planning turn is given the limits the plan is held to, and one that ran out of time or gave neither plan nor reason is one piece of work", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const timedOut = await r.coordinator.coordinate(input(r, { plan: async (p) => (seen.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(timedOut.action, "single");
  assert.deepEqual(seen[0], { maxFlows: DEFAULT_COORDINATION_SETTINGS.maxFlows, maxParallel: DEFAULT_COORDINATION_SETTINGS.maxParallel, budgetMs: DEFAULT_COORDINATION_SETTINGS.planBudgetMs });
  const nothing = await r.coordinator.coordinate(input(r, { plan: async () => ({ parsed: true, timedOut: false }) }));
  assert.equal(nothing.action, "single");
  assert.equal(nothing.signal.downgrade && /no-plan|plan/.test(nothing.signal.downgrade), true);
  assert.equal(r.executed.length, 0);
});

test("a lead that declares a no-op, in the plan or beside it, ends the coordination with its reason and no sidekick", async () => {
  const r = rig();
  const declared = await r.coordinator.coordinate(input(r, { plan: async () => ({ noopReason: "docs only", parsed: true, timedOut: false }) }));
  assert.deepEqual([declared.action, declared.action === "noop" ? declared.reason : ""], ["noop", "docs only"]);
  const inPlan = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "noop", reason: "nothing user-visible" }, parsed: true, timedOut: false }) }));
  assert.deepEqual([inPlan.action, inPlan.action === "noop" ? inPlan.reason : ""], ["noop", "nothing user-visible"]);
  assert.equal(r.created.length, 0);
});

test("a plan that is one piece of work, or that cannot be admitted, goes back to the lead with its reason on the signal", async () => {
  const r = rig();
  const single = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "single" }, parsed: true, timedOut: false }) }));
  assert.equal(single.action, "single");
  assert.equal(single.signal.plan, "single");
  const over = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "fanout", flows: [] }, parsed: true, timedOut: false }) }));
  assert.equal(over.action, "single");
  assert.equal(over.signal.downgrade, "empty");
});

test("each flow is authored in a workspace of its own by a sidekick that may write that flow's file and no other, and what is delivered is added up", async () => {
  const r = rig();
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(outcome.aggregated.end, GENERATION_END.DELIVERED);
  assert.deepEqual(outcome.aggregated.specs.sort(), ["flows/cart.spec.ts", "flows/login.spec.ts"]);
  assert.deepEqual(outcome.aggregated.incompleteFlows, []);
  assert.deepEqual([...r.created].sort(), ["run-1-flow-cart", "run-1-flow-login"]);
  for (const { brief, opts } of r.executed) {
    assert.equal(opts.cwd, `/w/${brief.delegationId}`, "the sidekick's session opens in its workspace");
    assert.equal(opts.delegationId, brief.delegationId);
    assert.deepEqual(brief.scope.writablePaths, [`e2e/flows/${brief.delegationId.replace("run-1-flow-", "")}.spec.ts`]);
  }
  assert.deepEqual([...r.disposed].sort(), ["/w/run-1-flow-cart", "/w/run-1-flow-login"]);
  assert.equal(outcome.signal.flows, 2);
  assert.equal(outcome.signal.delivered, 2);
  assert.equal(outcome.signal.plan, "fanout");
});

test("a flow is given its own run_spec loop, staged at the probe path of its file, and the browser's share, and both end with the flow", async () => {
  const r = rig();
  await r.coordinator.coordinate(input(r));
  assert.equal(r.flowLoops.length, 2);
  const cart = r.flowLoops.find((l) => l.input.flowId === "cart")!;
  assert.equal(cart.input.specFile, "flows/cart.spec.ts");
  assert.equal(cart.input.limits.maxCalls, 4, "the run's eight calls shared between two flows");
  assert.equal(cart.input.limits.maxDevWrites, 6);
  assert.equal(await cart.input.stage(), ".qa-probe/cart.spec.ts");
  assert.deepEqual(r.staged, ["run-1-flow-cart:e2e/flows/cart.spec.ts->.qa-probe/cart.spec.ts"]);
  assert.ok(r.flowLoops.every((l) => l.closed === 1));
  assert.deepEqual([...r.shares].sort(), [["run-1-flow-cart", 30], ["run-1-flow-login", 30]]);
});

test("a sidekick is told its tool budgets in the task: the run_spec share of its flow and the browser's", async () => {
  const r = rig();
  await r.coordinator.coordinate(input(r));
  const task = r.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!.brief.task;
  assert.match(task, /run_spec: at most 4 calls/);
  assert.match(task, /at most 30 authbrowser_\* calls/);
  assert.match(task, /e2e\/flows\/cart\.spec\.ts/);
  const bare = rig();
  await bare.coordinator.coordinate(input(bare, { closedLoop: undefined }));
  assert.match(bare.executed[0]!.brief.task, /cannot run the spec/);
});

test("the tools a sidekick is denied are the code-navigation server and the plain browser, and run_spec only when its flow has no loop", async () => {
  const withLoop = rig();
  await withLoop.coordinator.coordinate(input(withLoop));
  for (const { opts } of withLoop.executed) {
    assert.ok(opts.denyTools?.includes("serena*"));
    assert.ok(opts.denyTools?.includes("playwright*"));
    assert.equal(opts.denyTools?.includes("run_spec"), false);
  }
  const noLoop = rig();
  await noLoop.coordinator.coordinate(input(noLoop, { closedLoop: undefined }));
  assert.ok(noLoop.executed.every(({ opts }) => opts.denyTools?.includes("run_spec")));
  assert.equal(noLoop.shares.length, 2, "the browser's share is still given");
});

test("an app with no login is authored one flow at a time, with the plain browser left to the sidekick", async () => {
  const r = rig();
  let running = 0;
  let peak = 0;
  const gate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
  const execute = r.deps.sidekick.execute;
  r.deps.sidekick.execute = async (brief, opts) => { running += 1; peak = Math.max(peak, running); await gate(); try { return await execute(brief, opts); } finally { running -= 1; } };
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { facts: { hasLogin: false, provider: "opencode", plannerProvider: "opencode" }, agentBrowser: undefined }));
  assert.equal(outcome.action, "fanout");
  assert.equal(peak, 1);
  assert.ok(r.executed.every(({ opts }) => !opts.denyTools?.includes("playwright*")));
  assert.equal(outcome.signal.authoring, "unauthenticated-browser");
});

test("no more flows are authored at once than the settings allow", async () => {
  const r = rig({ hasFile: new Set(["a", "b", "c", "d"]) });
  let running = 0;
  let peak = 0;
  const execute = r.deps.sidekick.execute;
  r.deps.sidekick.execute = async (brief, opts) => { running += 1; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 2)); try { return await execute(brief, opts); } finally { running -= 1; } };
  const flows = ["a", "b", "c", "d"].map((id) => ({ id, objective: `flow ${id}` }));
  await new LeadSidekicks(r.deps).coordinate(input(r, { plan: async () => ({ plan: { kind: "fanout", flows }, parsed: true, timedOut: false }), settings: { ...DEFAULT_COORDINATION_SETTINGS, maxParallel: 2 } }));
  assert.equal(peak, 2);
});

test("a flow whose sidekick did not deliver is taken back from nothing, tried again with the escalated model and the reason, and handed to the lead when that does not help", async () => {
  const r = rig({ answers: { cart: [{ status: "failed", summary: "no selector found", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(outcome.aggregated.end, GENERATION_END.DELIVERED, "the other flow delivered");
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => [f.id, f.kind]), [["cart", "failed"]]);
  const cartRuns = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
  assert.deepEqual(cartRuns.map((e) => e.opts.capability), ["sidekick-standard", "sidekick-escalated"]);
  assert.equal(cartRuns[0]!.opts.model, undefined);
  assert.equal(cartRuns[1]!.opts.model, "escalated/model");
  assert.match(cartRuns[1]!.opts.feedback ?? "", /no selector found/);
  assert.equal(r.collected.includes("cart"), false, "nothing is taken back from a sidekick that did not deliver");
  assert.ok(r.events.some((e) => e.kind === "escalation" && e.delegationId === "run-1-flow-cart"));
});

test("a sidekick that asks for the lead is handed back at once, without a second attempt", async () => {
  const r = rig({ answers: { cart: [{ status: "needs-lead", summary: "needs the login decision", filesChanged: [], unresolvedQuestions: ["which login?"] }] }, hasFile: new Set(["login"]) });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => [f.id, f.kind]), [["cart", "needs-lead"]]);
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1);
  assert.ok(r.events.some((e) => e.kind === "escalation" && e.action === "lead-takeover"));
});

test("a flow that made no progress between its attempts, by what the orchestrator saw of its run_spec calls, goes to the lead after the second", async () => {
  const r = rig({ answers: { cart: [{ status: "blocked", summary: "stuck", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    const entry = r.flowLoops.at(-1)!;
    entry.ledger.push({ path: flowInput.specFile, sha256: "same-bytes", status: "failed", devWrites: 0 });
    return handle;
  })(r.closedLoop.openFlow);
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  const cartRuns = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
  assert.equal(cartRuns.length, 2);
  assert.ok(r.events.some((e) => e.kind === "escalation" && e.action === "escalate-sidekick"));
  assert.ok(r.events.some((e) => e.kind === "escalation" && e.action === "lead-takeover"));
});

test("a second attempt is not started when the flow has too little time left", async () => {
  const r = rig({ answers: { cart: [{ status: "failed", summary: "slow", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  const execute = r.deps.sidekick.execute;
  r.deps.sidekick.execute = async (brief, opts) => { r.clock.now += 10 * 60_000; return execute(brief, opts); };
  await new LeadSidekicks(r.deps).coordinate(input(r, { settings: { ...DEFAULT_COORDINATION_SETTINGS, flowBudgetMs: { opencode: 10 * 60_000 + MIN_FLOW_MS - 1, codex: 1_200_000 } } }));
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1);
});

test("flows that all finished nothing hand the change back to the lead while the run has time, and end the run on no decision when it has not", async () => {
  const failing = { answers: { cart: [{ status: "failed" as const, summary: "x", filesChanged: [] }], login: [{ status: "failed" as const, summary: "y", filesChanged: [] }] }, hasFile: new Set<string>() };
  const roomy = rig(failing);
  const back = await roomy.coordinator.coordinate(input(roomy));
  assert.equal(back.action, "single");
  assert.equal(back.signal.takeover, true);
  assert.ok(roomy.events.some((e) => e.kind === "escalation" && e.action === "lead-takeover" && e.delegationId === undefined));

  const tight = rig(failing);
  /* Time enough to plan and to admit the flows; by the time they are added up there is none for the lead to take over. */
  let asked = 0;
  const ended = await tight.coordinator.coordinate(input(tight, { deadline: { remainingMs: () => (++asked <= 2 ? 3_600_000 : 100_000) } }));
  assert.equal(ended.action, "fanout");
  assert.equal(ended.action === "fanout" ? ended.aggregated.end : "", GENERATION_END.UNDECIDED_EMPTY);
});

test("flows that all declined, each with a reason, are a declared no-op of the run", async () => {
  const r = rig({ answers: { cart: [{ summary: "already covered by flows/x.spec.ts", filesChanged: [] }], login: [{ summary: "nothing to assert", filesChanged: [] }] }, hasFile: new Set() });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(outcome.aggregated.end, GENERATION_END.DECLARED_NOOP);
  assert.match(outcome.aggregated.note ?? "", /already covered/);
});

test("a sidekick that says it changed nothing but left changes in its workspace has not declined the flow", async () => {
  const r = rig({
    answers: { cart: [{ summary: "nothing to assert", filesChanged: [] }], login: [{}] },
    hasFile: new Set(["login"]),
    proposals: { cart: 2 },
  });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => f.id), ["cart"], "its word is not taken over what the workspace shows");
});

test("a sidekick that wrote nothing for a flow and says why declines it, with the workspace showing no change", async () => {
  const r = rig({
    answers: { cart: [{ summary: "nothing to assert", filesChanged: [] }], login: [{}] },
    hasFile: new Set(["login"]),
  });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => f.id), []);
});

test("a flow that runs out of its time is stopped and nothing is taken back from it; with nothing delivered the run ends on its time budget", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const r = rig({ answers: { cart: [{ hold }], login: [{ hold }] } });
  const pending = r.coordinator.coordinate(input(r, { settings: { ...DEFAULT_COORDINATION_SETTINGS, flowBudgetMs: { opencode: 100_000, codex: 100_000 } } }));
  await settle();
  r.timers.advance(100_000);
  await settle();
  r.timers.advance(DEFAULT_ABORT_GRACE);
  const outcome = await pending;
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(outcome.aggregated.end, GENERATION_END.TIME_BUDGET);
  assert.deepEqual(r.collected, []);
  release();
  await settle();
  assert.equal(r.disposed.length, 2, "the workspaces go once the sessions wind down");
});

test("a sidekick whose session fails is that flow's failure; the others are untouched", async () => {
  const r = rig({ answers: { cart: [{ throws: new Error("provider down") }] }, hasFile: new Set(["login"]) });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(outcome.aggregated.end, GENERATION_END.DELIVERED);
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => f.id), ["cart"]);
  assert.ok(r.disposed.includes("/w/run-1-flow-cart"), "the failed flow's workspace is removed too");
});

test("the end of the run's own time is not a flow's failure: it ends the run", async () => {
  const r = rig({ answers: { cart: [{ throws: new RunDeadlineExceededError(60_000, "diff", "sidekick", "mid-turn") }] } });
  await assert.rejects(r.coordinator.coordinate(input(r)), RunDeadlineExceededError);
  assert.equal(r.disposed.length, 2);
});

test("what else a sidekick changed is reported as proposals, counted, and never applied", async () => {
  const r = rig({ proposals: { cart: 7 } });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.proposals.map((p) => [p.flowId, p.total, p.changes.length]), [["cart", 7, 5]]);
  assert.ok(r.logs.some((l) => /cart/.test(l) && /7/.test(l)));
});

test("nothing is taken back, and no loop or workspace is left, when the run is cancelled", async () => {
  const controller = new AbortController();
  const hold = new Promise<void>((resolve) => setTimeout(resolve, 5));
  const r = rig({ answers: { cart: [{ hold }], login: [{ hold }] } });
  const pending = r.coordinator.coordinate(input(r, { signal: controller.signal }));
  await settle();
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.action === "fanout" ? outcome.aggregated.specs.length : 0, 0);
  assert.equal(r.flowLoops.every((l) => l.closed === 1), true);
  assert.equal(r.disposed.length, 2);
});

test("workspaces a crashed run left are swept before a plan is asked for", async () => {
  const r = rig();
  await r.coordinator.coordinate(input(r));
  assert.equal(r.swept, 1);
  assert.equal(await r.coordinator.sweep(), 0);
});

test("the plan, every attempt and every step up the ladder are recorded for the run", async () => {
  const r = rig({ answers: { cart: [{ status: "failed", summary: "x", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  await r.coordinator.coordinate(input(r));
  const kinds = r.events.map((e) => e.kind);
  assert.ok(kinds.includes("proposal"));
  assert.equal(kinds.filter((k) => k === "delegation").length, 3, "two attempts of cart, one of login");
  assert.ok(r.events.every((e) => e.runId === "run-1" && e.app === "shop"));
});

const DEFAULT_ABORT_GRACE = 10_000;

test("a plan's location opens the flow there, the sidekick's task states it, and the flow's own value is closed with the flow", async () => {
  const r = rig();
  const madrid = { latitude: 40.4168, longitude: -3.7038 };
  const barcelona = { latitude: 41.3874, longitude: 2.1686 };
  const places = { barcelona };
  const opened: Array<{ delegationId: string; initial: GeoLocation | undefined }> = [];
  const closed: string[] = [];
  const geolocation: GeolocationHandle = {
    default: madrid,
    facts: () => ({ default: madrid, current: madrid, places, scope: "run" }),
    placeNames: () => ["barcelona"],
    forSession: () => madrid,
    openFlow: (delegationId, initial) => {
      opened.push({ delegationId, initial });
      const current = initial ?? madrid;
      return {
        facts: () => ({ default: madrid, current, places, scope: "flow" }),
        current: () => current,
        close: () => void closed.push(delegationId),
      };
    },
    close: () => {},
  };
  const plan = async () => ({
    plan: { kind: "fanout", flows: [{ id: "cart", objective: "the cart", location: "barcelona" }, { id: "login", objective: "sign in" }] },
    parsed: true,
    timedOut: false,
  });
  const outcome = await r.coordinator.coordinate(input(r, { geolocation, plan }));
  assert.equal(outcome.action, "fanout");
  assert.deepEqual(opened.sort((a, b) => a.delegationId.localeCompare(b.delegationId)), [
    { delegationId: "run-1-flow-cart", initial: barcelona },
    { delegationId: "run-1-flow-login", initial: undefined },
  ]);
  const cart = r.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!;
  assert.match(cart.brief.task, /41\.3874/);
  assert.match(cart.brief.task, /setLocation/);
  assert.match(cart.brief.task, /barcelona/);
  assert.deepEqual(closed.sort(), ["run-1-flow-cart", "run-1-flow-login"]);
});
