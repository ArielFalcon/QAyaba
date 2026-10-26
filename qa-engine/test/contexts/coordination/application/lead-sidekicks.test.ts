import { CORRECTION_ORIGIN } from "@contexts/coordination/application/lead-correction.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { DEFAULT_COORDINATION_SETTINGS, type PlanningLimits } from "@kernel/coordination.ts";
import { MAX_SESSION_PAGES } from "@kernel/agent-browser.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import {
  LeadSidekicks,
  MIN_FLOW_MS,
  type CoordinateInput,
  type LeadSidekicksDeps,
} from "@contexts/coordination/application/lead-sidekicks.ts";
import type { TimerPort } from "@contexts/coordination/application/fan-out-dispatcher.ts";
import type { CoordinationTelemetryEvent } from "@contexts/coordination/application/coordination-telemetry.ts";
import type { PlanSnapshot } from "@kernel/ports/plan-snapshot.port.ts";
import type { DelegationResult } from "@contexts/coordination/application/delegation-result.ts";
import type { SidekickExecuteOpts } from "@contexts/coordination/application/sidekick-executor.ts";
import type { DelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { DelegationCollection, DelegationWorkspace, DelegationWorkspaceRequest } from "@contexts/coordination/domain/delegation-workspace.ts";
import type { DelegationWorkspacePort } from "@contexts/coordination/application/ports/delegation-workspace.port.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowLedgerEntry, FlowLoopHandle, FlowLoopOpenInput, GeolocationHandle } from "@contexts/agent-tools/application/index.ts";
import type { PlanOutput } from "@kernel/plan-output.ts";
import type { GeoLocation } from "@kernel/geolocation.ts";

import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

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
  /* What each turn of a flow answers, by flow id; the last entry repeats. `writes` puts the flow's file in its workspace. */
  answers: Record<string, Array<Partial<DelegationResult> & { throws?: Error; hold?: Promise<void>; writes?: boolean }>>;
  /* Flows whose file the workspace has when the work is taken back. */
  hasFile: Set<string>;
  proposals: Record<string, number>;
}

interface Rig {
  deps: LeadSidekicksDeps;
  coordinator: LeadSidekicks;
  timers: FakeTimers;
  /* Every sidekick turn: a session opened on the brief, or a follow-up asked in an open one (`asked`). */
  executed: Array<{ brief: DelegationBrief; opts: SidekickExecuteOpts; asked?: boolean; session: number }>;
  refreshed: string[];
  sessionsOpened: number;
  sessionsDisposed: number[];
  created: string[];
  disposed: string[];
  collected: string[];
  staged: string[];
  swept: number;
  events: CoordinationTelemetryEvent[];
  plans: PlanSnapshot[];
  logs: string[];
  flowLoops: Array<{ input: FlowLoopOpenInput; closed: number; ledger: FlowLedgerEntry[] }>;
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
  const r = { timers, executed: [], sessionsOpened: 0, sessionsDisposed: [], created: [], disposed: [], refreshed: [], collected: [], staged: [], swept: 0, events: [], plans: [], logs: [], flowLoops: [], shares: [], script, clock } as unknown as Rig;
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
    refresh: async (_ws, request) => { r.refreshed.push(request.delegationId); return [...request.writablePaths]; },
    dispose: async (ws) => { r.disposed.push(ws.dir); },
    sweepAll: async () => { r.swept += 1; return 0; },
  };
  const attemptsOf = new Map<string, number>();
  const answerOf = async (brief: DelegationBrief): Promise<DelegationResult> => {
    const flow = flowOf(brief.delegationId);
    const n = attemptsOf.get(flow) ?? 0;
    attemptsOf.set(flow, n + 1);
    const answers = script.answers[flow] ?? [{}];
    const answer = answers[Math.min(n, answers.length - 1)]!;
    if (answer.hold) await answer.hold;
    if (answer.throws) throw answer.throws;
    const { throws: _t, hold: _h, writes, ...over } = answer;
    if (writes) script.hasFile.add(flow);
    return result(brief, over);
  };
  r.deps = {
    redaction: new PatternRedactionAdapter(),
    sidekick: {
      open: async (brief, opts) => {
        const session = ++r.sessionsOpened;
        r.executed.push({ brief, opts, session });
        const first = await answerOf(brief);
        let gone = false;
        return {
          first,
          ask: async (instruction) => {
            r.executed.push({ brief, opts: { ...opts, feedback: instruction }, asked: true, session });
            return answerOf(brief);
          },
          dispose: async () => { if (!gone) { gone = true; r.sessionsDisposed.push(session); } },
        };
      },
    },
    workspaces,
    timers,
    telemetry: { record: (event) => void r.events.push(event) },
    planSnapshots: { record: (snapshot) => void r.plans.push(snapshot) },
    now: () => clock.now,
    escalatedModel: "escalated/model",
    specFileFor: (id) => `flows/${id}.spec.ts`,
    log: (text) => void r.logs.push(text),
  };
  r.coordinator = new LeadSidekicks(r.deps);
  r.closedLoop = {
    limits: { maxCalls: 8, perCallMs: 60_000, maxDevWrites: 12 },
    openFlow: (input) => {
      const entry: { input: FlowLoopOpenInput; closed: number; ledger: FlowLedgerEntry[] } = { input, closed: 0, ledger: [] };
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
    settings: DEFAULT_COORDINATION_SETTINGS,
    facts: { hasLogin: true, provider: "opencode", plannerProvider: "opencode" },
    closedLoop: r.closedLoop,
    agentBrowser: r.agentBrowser,
    plan: async () => ({ plan: FANOUT_PLAN, parsed: true, timedOut: false }),
    ...over,
  };
}

/* A lead whose planning session answers its review turns with these answers in order (the last repeats), and records what it was asked. */
function leadWith(answers: unknown[][], plan: Record<string, unknown> = FANOUT_PLAN): { plan: CoordinateInput["plan"]; asked: string[]; disposed: () => number } {
  const asked: string[] = [];
  let disposed = 0;
  return {
    asked,
    disposed: () => disposed,
    plan: async () => ({
      plan,
      parsed: true,
      timedOut: false,
      lead: {
        ask: async (text: string) => {
          asked.push(text);
          const review = answers[Math.min(asked.length - 1, answers.length - 1)]!;
          return { output: JSON.stringify({ review }), timedOut: false };
        },
        dispose: async () => { disposed += 1; },
      },
    }),
  };
}

test("a generation that cannot plan, a sidekick that cannot author and a run with too little time all leave the change to the lead, before any session is opened", async () => {
  const r = rig();
  let asked = 0;
  const plan = async (): Promise<PlanOutput> => { asked += 1; return { plan: FANOUT_PLAN, parsed: true, timedOut: false }; };

  const noPlan = await r.coordinator.coordinate(input(r, { plan: undefined }));
  assert.equal(noPlan.action, "lead");

  const unnamed = await r.coordinator.coordinate(input(r, { plan, facts: { hasLogin: true, provider: undefined, plannerProvider: "opencode" } }));
  assert.equal(unnamed.action, "lead");
  assert.equal(unnamed.signal.authoring, "excluded");

  const bare = await r.coordinator.coordinate(input(r, { plan, closedLoop: undefined, agentBrowser: undefined }));
  assert.equal(bare.action, "lead", "a login and neither run_spec nor the browser");

  const hurried = await r.coordinator.coordinate(input(r, { plan, deadline: { remainingMs: () => 60_000 } }));
  assert.equal(hurried.action, "lead");
  assert.equal(asked, 0, "none of them paid for a planning turn");
  assert.equal(r.executed.length, 0);
  assert.equal(r.created.length, 0);
});

test("a lead on a runtime the host cannot name is not asked for a plan", async () => {
  const r = rig();
  let asked = 0;
  const plan = async (): Promise<PlanOutput> => { asked += 1; return { plan: FANOUT_PLAN, parsed: true, timedOut: false }; };
  for (const plannerProvider of [undefined] as const) {
    const outcome = await r.coordinator.coordinate(input(r, { plan, facts: { hasLogin: true, provider: "opencode", plannerProvider } }));
    assert.equal(outcome.action, "lead", String(plannerProvider));
    assert.ok(outcome.signal.downgrade && /read-only/.test(outcome.signal.downgrade), "the downgrade says why");
  }
  assert.equal(asked, 0, "no planning turn was paid for");
  assert.equal(r.created.length, 0);
});

test("with the authenticated browser, a plan is never asked for more flows at once than the browser has pages, whatever the app allows", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const settings = { ...DEFAULT_COORDINATION_SETTINGS, maxParallel: MAX_SESSION_PAGES + 2 };
  await r.coordinator.coordinate(input(r, { settings, plan: async (p) => (seen.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(seen[0]!.maxParallel, MAX_SESSION_PAGES);
});

test("the planning turn is told the pages the change is linked to, and the pages no admitted flow visits are reported", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", routes: ["/cart"] }, { id: "login", objective: "sign in works", routes: ["/shops/madrid"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { changeRoutes: ["/cart", "/shops/:city", "/orders"], plan: async (p) => (seen.push(p), { plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.deepEqual(seen[0]?.changeRoutes, ["/cart", "/shops/:city", "/orders"]);
  const reported = r.events.filter((e) => /change page/.test(e.reason ?? ""));
  assert.equal(reported.length, 1);
  assert.match(reported[0]!.reason, /1 of 3 .*\/orders/);
  assert.doesNotMatch(reported[0]!.reason, /\/shops/, "a template a flow visits a page of counts as visited");
});

test("the run keeps the plan it admitted, the change pages each flow visits and how each flow ended", async () => {
  const r = rig({ hasFile: new Set(["cart"]) });
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", acceptance: ["the total adds the lines"], routes: ["/cart"] }, { id: "login", objective: "sign in works", routes: ["/login"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { changeRoutes: ["/cart", "/orders"], plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const last = r.plans.at(-1)!;
  assert.equal(last.runId, "run-1");
  assert.equal(last.kind, "fanout");
  assert.deepEqual(last.changeRoutes, ["/cart", "/orders"]);
  assert.deepEqual(last.unvisited, ["/orders"]);
  const cart = last.flows.find((f) => f.id === "cart")!;
  assert.deepEqual({ objective: cart.objective, acceptance: cart.acceptance, routes: cart.routes, specFile: cart.specFile, visits: cart.visits }, { objective: "the cart total", acceptance: ["the total adds the lines"], routes: ["/cart"], specFile: "flows/cart.spec.ts", visits: ["/cart"] });
  assert.equal(cart.outcome?.kind, "delivered");
  assert.deepEqual(cart.outcome?.specs, ["flows/cart.spec.ts"]);
  const login = last.flows.find((f) => f.id === "login")!;
  assert.deepEqual(login.visits, []);
  assert.ok(login.outcome && login.outcome.kind !== "delivered", "a flow that wrote nothing did not deliver");
});

test("a plan that is a no-op or one piece of work is kept with why", async () => {
  const noop = rig();
  await noop.coordinator.coordinate(input(noop, { changeRoutes: ["/cart"], plan: async () => ({ parsed: true, timedOut: false, noopReason: "only a comment changed" }) }));
  assert.deepEqual(noop.plans.map((p) => [p.kind, p.reason, p.flows.length, p.unvisited]), [["noop", "only a comment changed", 0, ["/cart"]]]);
  const lead = rig();
  await lead.coordinator.coordinate(input(lead, { plan: async () => ({ plan: { kind: "lead" }, parsed: true, timedOut: false }) }));
  assert.deepEqual(lead.plans.map((p) => p.kind), ["lead"]);
});

test("a plan of one flow leaves the change to the lead with the change pages that flow does not visit", async () => {
  const r = rig();
  const plan = { kind: "fanout", flows: [{ id: "detail", objective: "the detail page", routes: ["/shops/madrid/:slug"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { changeRoutes: ["/shops/:province/:slug", "/shops/:province/:slug/menu"], plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  assert.equal(outcome.action, "lead");
  assert.deepEqual(outcome.action === "lead" ? outcome.unvisited : undefined, ["/shops/:province/:slug/menu"]);
  const reported = r.events.filter((e) => /change page/.test(e.reason ?? ""));
  assert.equal(reported.length, 1);
  assert.match(reported[0]!.reason, /1 of 2 change page\(s\) no flow visits: \/shops\/:province\/:slug\/menu$/);
});

test("a plan the lead authors alone leaves it every change page to visit, and a run with no change pages names none", async () => {
  const lead = rig();
  const alone = await lead.coordinator.coordinate(input(lead, { changeRoutes: ["/cart"], plan: async () => ({ plan: { kind: "lead" }, parsed: true, timedOut: false }) }));
  assert.deepEqual(alone.action === "lead" ? alone.unvisited : null, ["/cart"]);
  const bare = rig();
  const none = await bare.coordinator.coordinate(input(bare, { plan: async () => ({ plan: { kind: "lead" }, parsed: true, timedOut: false }) }));
  assert.equal(none.action === "lead" ? none.unvisited : null, undefined);
});

test("the lead's review names the change pages no flow visits and those no flow covers with a spec that passed run_spec", async () => {
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", routes: ["/cart"] }, { id: "login", objective: "sign in works", routes: ["/login"] }] };
  const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }]], plan);
  const r = rig();
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "b", status: flowInput.flowId === "cart" ? "passed" : "failed", devWrites: 0 });
    return { ...handle, isClosed: async () => flowInput.flowId === "cart" };
  })(r.closedLoop.openFlow);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { changeRoutes: ["/cart", "/login", "/orders"], plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  /* The flow blocks name no route: every change page is listed once, and a page the review flags is named a second time. */
  const first = lead.asked[0]!;
  const times = (page: string): number => first.split(page).length - 1;
  assert.equal(times("/orders"), 2, "the page no flow visits");
  assert.equal(times("/login"), 2, "the page whose only flow has not passed");
  assert.equal(times("/cart"), 1, "a page a passing flow covers is not flagged");
});

test("a flow that names a change page by its template, whatever its parameters are called, visits it", async () => {
  const r = rig();
  const plan = { kind: "fanout", flows: [{ id: "detail", objective: "the detail page", routes: ["/shops/:province/:shopSlug"] }, { id: "menu", objective: "the menu page", routes: ["/shops/[province]/[slug]/menu"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { changeRoutes: ["/shops/:province/:slug", "/shops/:province/:slug/menu", "/shops/:province"], plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const reported = r.events.filter((e) => /change page/.test(e.reason ?? ""));
  assert.equal(reported.length, 1);
  assert.match(reported[0]!.reason, /1 of 3 change page\(s\) no flow visits: \/shops\/:province$/);
});

test("the planning turn is given the limits the plan is held to, and one that ran out of time or gave neither plan nor reason is one piece of work", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const timedOut = await r.coordinator.coordinate(input(r, { plan: async (p) => (seen.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(timedOut.action, "lead");
  assert.deepEqual(seen[0], { maxFlows: DEFAULT_COORDINATION_SETTINGS.maxFlows, maxParallel: DEFAULT_COORDINATION_SETTINGS.maxParallel, budgetMs: DEFAULT_COORDINATION_SETTINGS.planBudgetMs });
  const nothing = await r.coordinator.coordinate(input(r, { plan: async () => ({ parsed: true, timedOut: false }) }));
  assert.equal(nothing.action, "lead");
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
  const alone = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "lead" }, parsed: true, timedOut: false }) }));
  assert.equal(alone.action, "lead");
  assert.equal(alone.signal.plan, "lead");
  const over = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "fanout", flows: [] }, parsed: true, timedOut: false }) }));
  assert.equal(over.action, "lead");
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
  const open = r.deps.sidekick.open;
  r.deps.sidekick.open = async (brief, opts) => { running += 1; peak = Math.max(peak, running); await gate(); try { return await open(brief, opts); } finally { running -= 1; } };
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
  const open = r.deps.sidekick.open;
  r.deps.sidekick.open = async (brief, opts) => { running += 1; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 2)); try { return await open(brief, opts); } finally { running -= 1; } };
  const flows = ["a", "b", "c", "d"].map((id) => ({ id, objective: `flow ${id}` }));
  await new LeadSidekicks(r.deps).coordinate(input(r, { plan: async () => ({ plan: { kind: "fanout", flows }, parsed: true, timedOut: false }), settings: { ...DEFAULT_COORDINATION_SETTINGS, maxParallel: 2 } }));
  assert.equal(peak, 2);
});

test("a flow whose sidekick did not deliver is not tried again on its own: without the lead's review it ends with the sidekick's reason", async () => {
  const r = rig({ answers: { cart: [{ status: "failed", summary: "no selector found", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(outcome.aggregated.end, GENERATION_END.DELIVERED, "the other flow delivered");
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => [f.id, f.kind]), [["cart", "failed"]]);
  assert.match(outcome.aggregated.incompleteFlows[0]!.reason ?? "", /no selector found/);
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1);
  assert.equal(outcome.aggregated.specs.includes("flows/cart.spec.ts"), false, "a sidekick that wrote nothing delivers nothing");
});

for (const ended of [
  { status: "needs-lead" as const, summary: "could not verify the edit" },
  { status: "failed" as const, summary: "the sidekick's answer could not be read" },
]) {
  test(`a spec a sidekick wrote is taken back though its turn ended ${ended.status}: the run's own checks judge it, not the sidekick's word`, async () => {
    const r = rig({ answers: { cart: [{ ...ended, filesChanged: [], writes: true }] }, hasFile: new Set(["login"]) });
    const outcome = await r.coordinator.coordinate(input(r));
    assert.equal(outcome.action, "fanout");
    if (outcome.action !== "fanout") return;
    assert.ok(outcome.aggregated.specs.includes("flows/cart.spec.ts"), "the written spec reaches the working copy");
    assert.deepEqual(outcome.aggregated.incompleteFlows, []);
    assert.ok(r.events.some((e) => /flow cart turn 1: sidekick status=.*file taken back/.test(e.reason ?? "")));
  });
}

test("a sidekick that asks for the lead is handed back with its question", async () => {
  const r = rig({ answers: { cart: [{ status: "needs-lead", summary: "needs the login decision", filesChanged: [], unresolvedQuestions: ["which login?"] }] }, hasFile: new Set(["login"]) });
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => [f.id, f.kind]), [["cart", "needs-lead"]]);
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1);
});

test("the lead reviews every flow in its planning session: what it asked for, what came of it, the run_spec facts and the spec delivered", async () => {
  const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }]]);
  const r = rig();
  r.deps.readSpec = async (_root, file) => `// ${file}\ntest('works', async () => {});`;
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(outcome.action, "fanout");
  assert.equal(lead.asked.length, 1);
  for (const expected of ["`cart`", "the cart total", "`login`", "sign in works", "// flows/cart.spec.ts", "Outcome: delivered", "run_spec: not available"]) assert.ok(lead.asked[0]!.includes(expected), expected);
  assert.deepEqual(outcome.signal.review, { turns: 1, accepted: 2, revised: 0, replaced: 0, dropped: 0, refused: 0 });
  assert.equal(lead.disposed(), 1, "the lead's session ends with the pass");
});

test("a revise reaches the same sidekick session with the lead's instruction and the orchestrator's facts, and the lead judges the result again", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "Assert the total row, not the count." }], [{ flow: "cart", action: "accept" }]]);
  const r = rig({ answers: { cart: [{ status: "failed", summary: "no selector found", filesChanged: [] }, { writes: true }] }, hasFile: new Set(["login"]) });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  const cart = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
  assert.equal(cart.length, 2);
  assert.equal(cart[1]!.asked, true, "the follow-up was asked in the session that did the work");
  assert.equal(cart[1]!.session, cart[0]!.session);
  assert.match(cart[1]!.opts.feedback ?? "", /Assert the total row, not the count\./);
  assert.deepEqual(outcome.aggregated.incompleteFlows, []);
  assert.equal(lead.asked.length, 2, "the revision was reviewed");
  assert.equal(outcome.signal.review?.revised, 1);
  assert.deepEqual([...r.sessionsDisposed].sort(), [1, 2], "every sidekick session ends with the pass, once");
});

test("a replace starts a fresh sidekick on the escalated model with the brief and the lead's instruction, and ends the old session", async () => {
  const lead = leadWith([[{ flow: "cart", action: "replace", instruction: "Start from the cart page, not the home page." }], []]);
  const r = rig({ answers: { cart: [{ status: "blocked", summary: "stuck", filesChanged: [] }, { writes: true }] }, hasFile: new Set(["login"]) });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  const cart = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
  assert.equal(cart.length, 2);
  assert.equal(cart[1]!.asked, undefined, "a new session");
  assert.notEqual(cart[1]!.session, cart[0]!.session);
  assert.equal(cart[1]!.opts.capability, "sidekick-escalated");
  assert.equal(cart[1]!.opts.model, "escalated/model");
  assert.match(cart[1]!.opts.feedback ?? "", /Start from the cart page/);
  assert.ok(r.sessionsDisposed.includes(cart[0]!.session), "the stuck session was ended");
  assert.equal(outcome.action === "fanout" ? outcome.aggregated.incompleteFlows.length : -1, 0);
});

test("an accept of a spec that has not passed run_spec on its current bytes is sent back to the same sidekick with the failure the orchestrator saw", async () => {
  const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }], []]);
  const r = rig();
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    if (flowInput.flowId === "cart") r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "b", status: "failed", devWrites: 0, failures: [{ detail: "Expected: 3 Received: 0", path: "/cart" }] });
    else r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "b", status: "passed", devWrites: 0 });
    return { ...handle, isClosed: async () => flowInput.flowId !== "cart" };
  })(r.closedLoop.openFlow);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  const cart = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
  assert.equal(cart.length, 2);
  assert.equal(cart[1]!.asked, true);
  assert.match(cart[1]!.opts.feedback ?? "", /Expected: 3 Received: 0/);
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-login").length, 1, "a passing spec is accepted as it is");
  assert.equal(outcome.signal.review?.accepted, 1);
});

test("each turn of a flow records what the sidekick reported beside how its flow's last run_spec call ended", async () => {
  const r = rig({ answers: { cart: [{ status: "failed" as const, summary: "gave up", filesChanged: [], writes: true }] }, hasFile: new Set(["login"]) });
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    if (flowInput.flowId === "cart") r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "b", status: "passed", devWrites: 0 });
    return handle;
  })(r.closedLoop.openFlow);
  await r.coordinator.coordinate(input(r));
  const turn = (flow: string) => r.events.find((e) => e.kind === "delegation" && e.delegationId === `run-1-flow-${flow}`);
  assert.equal(turn("cart")?.sidekickStatus, "failed");
  assert.equal(turn("cart")?.lastRunSpec, "passed");
  assert.ok(turn("login")?.sidekickStatus);
  assert.equal(turn("login")?.lastRunSpec, undefined, "a flow that never called run_spec has no last call");
});

test("a flow that delivered nothing may be dropped by the lead with its reason, which settles it", async () => {
  const lead = leadWith([[{ flow: "cart", action: "drop", reason: "the change does not touch the cart" }, { flow: "login", action: "accept" }]]);
  const failing = { answers: { cart: [{ status: "failed" as const, summary: "x", filesChanged: [] }] }, hasFile: new Set(["login"]) };
  const r = rig(failing);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.aggregated.incompleteFlows, [], "a dropped flow is decided, not unfinished");
  assert.equal(outcome.signal.review?.dropped, 1);
});

test("a review that cannot be read, or that runs out of its time, leaves the flows as they are", async () => {
  for (const answer of [{ output: "looks fine to me", timedOut: false }, { output: "", timedOut: true }]) {
    const r = rig({ answers: { cart: [{ status: "failed", summary: "x", filesChanged: [] }] }, hasFile: new Set(["login"]) });
    const plan = async (): Promise<PlanOutput> => ({ plan: FANOUT_PLAN, parsed: true, timedOut: false, lead: { ask: async () => answer, dispose: async () => {} } });
    const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan }));
    assert.equal(outcome.action === "fanout" ? outcome.aggregated.incompleteFlows.length : -1, 1);
    assert.equal(r.executed.length, 2, "nothing was asked again");
    assert.equal(outcome.signal.review?.turns, 1);
  }
});

test("a review turn that fails leaves the flows as they are: what was delivered stays delivered", async () => {
  const r = rig();
  const plan = async (): Promise<PlanOutput> => ({ plan: FANOUT_PLAN, parsed: true, timedOut: false, lead: { ask: async () => { throw new Error("provider down"); }, dispose: async () => {} } });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(outcome.aggregated.specs.length, 2);
  assert.equal(outcome.signal.review?.turns, 1);
  assert.equal(r.disposed.length, 2);
});

test("a sidekick session that opens after its flow ran out of time is closed at once, never left behind", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const lead = leadWith([[{ flow: "cart", action: "replace", instruction: "again" }], []]);
  const r = rig({ answers: { cart: [{ status: "failed", summary: "x", filesChanged: [] }, { hold, writes: true }] }, hasFile: new Set(["login"]) });
  const pending = new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, settings: { ...DEFAULT_COORDINATION_SETTINGS, flowBudgetMs: { opencode: 100_000 } } }));
  for (let i = 0; i < 20; i++) await settle();
  r.timers.advance(100_000);
  await settle();
  r.timers.advance(DEFAULT_ABORT_GRACE);
  const outcome = await pending;
  if (outcome.action === "fanout") await outcome.pass?.release();
  release();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(r.sessionsOpened, 3);
  assert.equal(r.sessionsDisposed.length, 3, "the late session was closed too");
  assert.equal(r.collected.filter((f) => f === "cart").length, 1, "only the first turn's workspace is read: nothing is taken back from a flow after its pass ended");
});

test("the lead is never asked to review when the run has no room left for it", async () => {
  const lead = leadWith([[{ flow: "cart", action: "accept" }]]);
  const r = rig();
  let calls = 0;
  const done = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, deadline: { remainingMs: () => (++calls <= 2 ? 3_600_000 : MIN_FLOW_MS) } }));
  if (done.action === "fanout") await done.pass?.release();
  assert.equal(lead.asked.length, 0);
  assert.equal(lead.disposed(), 1);
});

test("the lead's session ends however the plan comes out: a no-op, one piece of work, or a plan that cannot be admitted", async () => {
  for (const planned of [{ kind: "noop", reason: "nothing" }, { kind: "lead" }, { kind: "fanout", flows: [] }]) {
    let disposed = 0;
    const r = rig();
    const plan = async (): Promise<PlanOutput> => ({ plan: planned, parsed: true, timedOut: false, lead: { ask: async () => ({ output: "", timedOut: false }), dispose: async () => { disposed += 1; } } });
    await new LeadSidekicks(r.deps).coordinate(input(r, { plan }));
    assert.equal(disposed, 1, JSON.stringify(planned));
  }
});

test("flows that all finished nothing hand the change back to the lead while the run has time, and end the run on no decision when it has not", async () => {
  const failing = { answers: { cart: [{ status: "failed" as const, summary: "x", filesChanged: [] }], login: [{ status: "failed" as const, summary: "y", filesChanged: [] }] }, hasFile: new Set<string>() };
  const roomy = rig(failing);
  const back = await roomy.coordinator.coordinate(input(roomy));
  assert.equal(back.action, "lead");
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
  const pending = r.coordinator.coordinate(input(r, { settings: { ...DEFAULT_COORDINATION_SETTINGS, flowBudgetMs: { opencode: 100_000 } } }));
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

test("the plan, every sidekick turn and every review decision are recorded for the run", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "try the cart page" }], []]);
  const r = rig({ answers: { cart: [{ status: "failed", summary: "x", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  const kinds = r.events.map((e) => e.kind);
  assert.ok(kinds.includes("proposal"));
  assert.equal(kinds.filter((k) => k === "delegation").length, 3, "two turns of cart, one of login");
  assert.ok(r.events.some((e) => e.kind === "lead-decision" && /cart revise/.test(e.reason)));
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

test("a sidekick whose run_spec read empty a page the Context Pack read with results is not taken at its word: its decline is no decision, and a revision carries both reads", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "The shops are there; assert them." }], []]);
  const r = rig({ answers: { cart: [{ summary: "DEV shows no shops, nothing to assert", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    if (flowInput.flowId === "cart") r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "bytes", status: "failed", devWrites: 0, failures: [{ path: "/shops/madrid", resultCount: 0 }] });
    return handle;
  })(r.closedLoop.openFlow);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, confirmedDataRoutes: [{ path: "/shops/madrid", resultCount: 3 }] }));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => [f.id, f.kind]), [["cart", "failed"]], "an empty read the pack contradicts is no decline");
  assert.match(outcome.aggregated.incompleteFlows[0]!.reason ?? "", /observation conflict/);
  const cart = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
  assert.equal(cart.length, 2);
  assert.match(cart[1]!.opts.feedback ?? "", /3 results/);
  assert.match(cart[1]!.opts.feedback ?? "", /\/shops\/madrid/);
});

test("a sidekick that declines with no empty read of a page the Context Pack read with results still declines", async () => {
  const r = rig({ answers: { cart: [{ summary: "nothing to assert", filesChanged: [] }], login: [{}] }, hasFile: new Set(["login"]) });
  const outcome = await r.coordinator.coordinate(input(r, { confirmedDataRoutes: [{ path: "/shops/madrid", resultCount: 3 }] }));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => f.id), []);
});

/* A cart flow whose sidekick reported a failure after one run_spec call that failed with these facts. */
function failedCartWith(failures: FlowLedgerEntry["failures"]): Rig {
  const r = rig({ answers: { cart: [{ status: "failed", summary: "the spec does not pass", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    const entry = r.flowLoops.at(-1)!;
    if (flowInput.flowId === "cart") entry.ledger.push({ path: flowInput.specFile, sha256: "ran-bytes", status: "failed", devWrites: 0, failures });
    return handle;
  })(r.closedLoop.openFlow);
  return r;
}

test("a run_spec failure that shows the app at fault is never sent back to be made green: the spec that showed it is taken back", async () => {
  const r = failedCartWith([{ detail: "expect(locator).toBeVisible() failed", httpStatus: 503 }]);
  r.script.hasFile.add("cart");
  const outcome = await r.coordinator.coordinate(input(r));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1, "no second turn");
  assert.ok(r.collected.includes("cart"));
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => f.id), [], "the flow is delivered, so the run's own execution can report the defect");
  assert.ok(r.events.some((e) => e.delegationId === "run-1-flow-cart" && /app defect/.test(e.reason) && /503/.test(e.reason)));
});

test("an uncaught page error is app evidence too, and with the bytes that showed it gone the flow ends on it, never sent back by the lead", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "make it pass" }], []]);
  const r = failedCartWith([{ detail: "x", runtimeErrors: [{ type: "pageerror", text: "Cannot read properties of undefined" }] }]);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1);
  assert.equal(outcome.aggregated.specs.includes("flows/cart.spec.ts"), false);
  const cart = outcome.aggregated.incompleteFlows.find((f) => f.id === "cart");
  assert.equal(cart?.kind, "failed");
  assert.match(cart?.reason ?? "", /app defect/);
});

test("a revision is told what kind of failure the flow's last run_spec call met, beside the lead's instruction", async () => {
  const cases: Array<[FlowLedgerEntry["failures"], RegExp]> = [
    [[{ detail: "Error: element(s) not found", unsettled: true }], /still loading/],
    [[{ detail: "Error: element(s) not found" }], /not in the page's tree/],
    [[{ detail: "Expected: 3\nReceived: 0" }], /never from what the page shows/],
  ];
  for (const [failures, expected] of cases) {
    const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "fix the locator" }], []]);
    const r = failedCartWith(failures);
    await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
    const cart = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
    assert.equal(cart.length, 2);
    assert.match(cart[1]!.opts.feedback ?? "", expected);
    assert.match(cart[1]!.opts.feedback ?? "", /fix the locator/);
  }
});

test("each sidekick's brief carries the Live DOM of its own flow's pages from the Context Pack, and none of another flow's", async () => {
  const r = rig();
  const contextPack = [`### ${PACK_HEADINGS.liveDom}`, "route /cart:", "  button \"Checkout\"", "route /login:", "  textbox \"Email\""].join("\n");
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", routes: ["/cart"] }, { id: "login", objective: "sign in works", routes: ["/nowhere"] }] };
  await r.coordinator.coordinate(input(r, { contextPack, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  const brief = (flow: string) => r.executed.find((e) => e.brief.delegationId === `run-1-flow-${flow}`)!.brief;
  assert.ok(brief("cart").pages?.includes("button \"Checkout\""));
  assert.ok(!brief("cart").pages?.includes("Email"));
  assert.equal(brief("login").pages, undefined, "a flow whose pages the pack did not read gets no slice");
});

test("each sidekick's brief carries the call graph's proof for the change pages its flow visits, and none of another flow's", async () => {
  const r = rig();
  const changeProofs = [
    { route: "/shops/:city", proof: ["src/util/format.ts::formatMoney", "src/shops/list.page.ts::ShopList", "page /shops/:city"] },
    { route: "/orders", proof: ["src/util/format.ts::formatMoney", "src/orders/orders.page.ts::Orders", "page /orders"] },
  ];
  const plan = { kind: "fanout", flows: [{ id: "shops", objective: "the shop list", routes: ["/shops/madrid"] }, { id: "login", objective: "sign in works", routes: ["/login"] }] };
  await r.coordinator.coordinate(input(r, { changeProofs, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  const brief = (flow: string) => r.executed.find((e) => e.brief.delegationId === `run-1-flow-${flow}`)!.brief;
  assert.deepEqual(brief("shops").proofs, ["/shops/:city: src/util/format.ts::formatMoney > src/shops/list.page.ts::ShopList > page /shops/:city"]);
  assert.equal(brief("login").proofs, undefined, "a flow that visits no proven page carries no proof");
});

/* A lead whose planning session answers each turn with these raw outputs in order (the last repeats). */
function leadAnswering(outputs: string[]): { plan: CoordinateInput["plan"]; asked: string[]; disposed: () => number } {
  const asked: string[] = [];
  let disposed = 0;
  return {
    asked,
    disposed: () => disposed,
    plan: async () => ({
      plan: FANOUT_PLAN,
      parsed: true,
      timedOut: false,
      lead: {
        ask: async (text: string) => {
          asked.push(text);
          return { output: outputs[Math.min(asked.length - 1, outputs.length - 1)]!, timedOut: false };
        },
        dispose: async () => { disposed += 1; },
      },
    }),
  };
}

const ACCEPT_ALL = JSON.stringify({ review: [{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }] });

test("a pass that delivered with the lead's session is kept open, and its release ends every session, workspace and the lead's session once", async () => {
  const lead = leadAnswering([ACCEPT_ALL]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  assert.equal(outcome.action, "fanout");
  if (outcome.action !== "fanout") return;
  assert.ok(outcome.pass, "the pass is handed to the run");
  assert.equal(lead.disposed(), 0);
  assert.deepEqual(r.disposed, [], "the workspaces outlive the coordination");
  assert.deepEqual(r.sessionsDisposed, [], "the sidekick sessions outlive the coordination");
  await outcome.pass!.release();
  await outcome.pass!.release();
  assert.equal(lead.disposed(), 1);
  assert.deepEqual([...r.disposed].sort(), ["/w/run-1-flow-cart", "/w/run-1-flow-login"]);
  assert.equal(r.sessionsDisposed.length, 2);
});

test("a plan without the lead's session hands no pass, and everything ends with the coordination", async () => {
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r));
  assert.equal(outcome.action === "fanout" ? outcome.pass : undefined, undefined);
  assert.equal(r.disposed.length, 2);
});

test("the reviewer's findings are routed by the lead in its planning session and corrected by the same sidekick, on its refreshed workspace", async () => {
  const correction = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", instruction: "assert the total, not the heading" }] });
  const lead = leadAnswering([ACCEPT_ALL, correction]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([{ text: "the total is never asserted", spec: "e2e/flows/cart.spec.ts" }]);
  assert.match(lead.asked[1]!, /the total is never asserted/);
  const asked = r.executed.find((e) => e.asked && e.brief.delegationId === "run-1-flow-cart")!;
  assert.match(asked.opts.feedback!, /the total is never asserted/);
  assert.match(asked.opts.feedback!, /assert the total, not the heading/);
  assert.equal(r.executed.filter((e) => e.asked).every((e) => e.session === r.executed.find((x) => !x.asked && x.brief.delegationId === e.brief.delegationId)!.session), true, "the same session");
  assert.deepEqual(r.refreshed, ["run-1-flow-cart"]);
  assert.deepEqual(corrected.specs, ["flows/cart.spec.ts"]);
  assert.deepEqual(corrected.unrouted, []);
  assert.equal(outcome.pass!.tally().revised, 1);
  await outcome.pass!.release();
});

test("the lead's rebuttal comes back for the run to check, and a finding on a flow goes to it even when the lead's answer cannot be read", async () => {
  const rebut = JSON.stringify({ rebuttals: [{ finding: 1, basis: "execution", ref: "cart › total", reason: "the total is asserted" }] });
  const r = rig();
  const lead = leadAnswering([ACCEPT_ALL, rebut, "not json"]);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const first = await outcome.pass!.correct([{ text: "the total is never asserted", spec: "e2e/flows/cart.spec.ts" }]);
  assert.deepEqual(first.rebuttals, [{ finding: "the total is never asserted", basis: "execution", ref: "cart › total", reason: "the total is asserted" }]);
  assert.deepEqual(first.specs, [], "a rebutted finding is sent to nobody");
  const second = await outcome.pass!.correct([{ text: "the login asserts only the URL", spec: "e2e/flows/login.spec.ts" }, { text: "a loose finding" }]);
  assert.equal(second.readable, false);
  assert.deepEqual(second.specs, ["flows/login.spec.ts"]);
  assert.deepEqual(second.unrouted, [1], "the loose finding, by its position");
  await outcome.pass!.release();
  const late = await outcome.pass!.correct([{ text: "anything", spec: "e2e/flows/cart.spec.ts" }]);
  assert.deepEqual([late.specs, late.unrouted], [[], [0]], "a released pass corrects nothing");
});

test("a pass whose flows delivered nothing is not kept, even with the lead's session: everything ends with the coordination", async () => {
  const lead = leadAnswering([JSON.stringify({ review: [] })]);
  const r = rig({ hasFile: new Set(), answers: { cart: [{ status: "failed", summary: "x", filesChanged: [] }], login: [{ status: "failed", summary: "x", filesChanged: [] }] } });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, deadline: { remainingMs: () => 1_000_000 } }));
  assert.equal(outcome.action === "fanout" ? outcome.pass : undefined, undefined);
  assert.equal(lead.disposed(), 1);
  assert.equal(r.disposed.length, 2);
});

test("a run stopped while a kept sidekick session answers a revision closes that session and ends the coordination", async () => {
  const controller = new AbortController();
  const never = new Promise<void>(() => {});
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "assert the total" }], []]);
  const r = rig({ answers: { cart: [{ status: "failed", summary: "x", filesChanged: [] }, { hold: never }] }, hasFile: new Set(["login"]) });
  const pending = new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, signal: controller.signal }));
  for (let i = 0; i < 50 && !r.executed.some((e) => e.asked); i++) await settle();
  assert.ok(r.executed.some((e) => e.asked), "the revision was asked");
  controller.abort();
  const outcome = await pending;
  if (outcome.action === "fanout") await outcome.pass?.release();
  const cart = r.executed.find((e) => !e.asked && e.brief.delegationId === "run-1-flow-cart")!;
  assert.ok(r.sessionsDisposed.includes(cart.session), "the session answering the revision is closed");
});

test("findings the lead sends to a flow when too little of the run is left for it come back unrouted", async () => {
  let left = 3_600_000;
  const outputs = [ACCEPT_ALL, JSON.stringify({ corrections: [{ flow: "cart", action: "revise", instruction: "assert the total" }] })];
  let turn = 0;
  const plan: CoordinateInput["plan"] = async () => ({
    plan: FANOUT_PLAN, parsed: true, timedOut: false,
    lead: {
      ask: async () => {
        const output = outputs[Math.min(turn++, outputs.length - 1)]!;
        if (turn === 2) left = MIN_FLOW_MS - 1;
        return { output, timedOut: false };
      },
      dispose: async () => {},
    },
  });
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan, closedLoop: undefined, deadline: { remainingMs: () => left } }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([{ text: "the total is never asserted", spec: "e2e/flows/cart.spec.ts" }]);
  await outcome.pass!.release();
  assert.deepEqual(corrected.specs, []);
  assert.deepEqual(corrected.unrouted, [0]);
  assert.equal(r.executed.some((e) => e.asked), false, "no sidekick was asked");
  assert.equal(outcome.pass!.tally().unrouted, 1);
});

test("a sidekick that holds its failing test right changes nothing and its claim comes back; beside a change, or on another origin, it does not", async () => {
  const route = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", instruction: "fix the count" }] });
  const claim = { cause: "app" as const, reason: "DEV returns 0 restaurants for a position the pack read 3 at" };
  const r = rig({ answers: { cart: [{}, { testCorrect: claim }] } });
  const lead = leadAnswering([ACCEPT_ALL, route, route]);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  r.script.hasFile.delete("cart");
  const failing = [{ text: "test \"count\" in flows/cart.spec.ts failed: expected 3", spec: "flows/cart.spec.ts" }];
  const untouched = await outcome.pass!.correct(failing, CORRECTION_ORIGIN.EXECUTION);
  assert.deepEqual(untouched.specs, []);
  assert.deepEqual(untouched.testCorrect, claim);
  const asked = r.executed.filter((e) => e.asked && e.brief.delegationId === "run-1-flow-cart").at(-1)!;
  assert.match(asked.opts.feedback!, /"testCorrect"/, "the sidekick is told how to claim it");
  r.script.hasFile.add("cart");
  const changed = await outcome.pass!.correct(failing, CORRECTION_ORIGIN.EXECUTION);
  assert.deepEqual(changed.specs, ["flows/cart.spec.ts"]);
  assert.equal(changed.testCorrect, undefined, "a claim beside a change is not one");
  await outcome.pass!.release();
});

test("a correction hands back the source of every spec it took, as the working copy holds it", async () => {
  const route = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", instruction: "assert the total" }] });
  const r = rig();
  r.deps.readSpec = async (_root, file) => `// ${file} as corrected`;
  const lead = leadAnswering([ACCEPT_ALL, route]);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([{ text: "the total is never asserted", spec: "flows/cart.spec.ts" }], CORRECTION_ORIGIN.EXECUTION);
  assert.deepEqual(corrected.specs, ["flows/cart.spec.ts"]);
  assert.deepEqual(corrected.specSources, ["// flows/cart.spec.ts as corrected"]);
  await outcome.pass!.release();
});
