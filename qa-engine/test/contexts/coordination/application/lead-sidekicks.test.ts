import { pageCandidate, pageCandidates } from "../../../support/use-case-candidate.ts";
import { PLAN_DOWNGRADE, MIN_RUN_SPEC_DEV_WRITES_PER_FLOW } from "@contexts/coordination/application/lead-plan.ts";
import { AUTHORING_REFUSAL } from "@kernel/coordination.ts";
import { UNREADABLE_ANSWER } from "@kernel/unreadable-answer.ts";
import { CORRECTION_ORIGIN } from "@contexts/coordination/application/lead-correction.ts";
import { test } from "node:test";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import assert from "node:assert/strict";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { DEFAULT_COORDINATION_SETTINGS, type PlanningLimits } from "@kernel/coordination.ts";
import { MAX_SESSION_PAGES } from "@kernel/agent-browser.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { ContextBudget } from "@kernel/context-budget.ts";
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
import { readDelegationResult } from "@contexts/coordination/application/delegation-reading.ts";
import type { SidekickExecuteOpts } from "@contexts/coordination/application/sidekick-executor.ts";
import type { DelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { DelegationCollection, DelegationWorkspace, DelegationWorkspaceRequest } from "@contexts/coordination/domain/delegation-workspace.ts";
import type { DelegationWorkspacePort } from "@contexts/coordination/application/ports/delegation-workspace.port.ts";
import type { AgentBrowserHandle, ClosedLoopHandle, FlowLedgerEntry, FlowLoopHandle, FlowLoopOpenInput, GeolocationHandle } from "@contexts/agent-tools/application/index.ts";
import type { LeadTurnOpts, PlanOutput } from "@kernel/plan-output.ts";
import { sha256Hex } from "@kernel/content-hash.ts";
import { AGENT_TOOL, SIDEKICK_KIND, sidekickKindSpec } from "@contexts/coordination/application/sidekick-kinds.ts";
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

/* A lead that cannot be asked for a plan again: no test here asks it to explore. */
const noPlanAnswer = async (): Promise<{ parsed: boolean; timedOut: boolean }> => ({ parsed: false, timedOut: false });

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

const FANOUT_PLAN = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total" }, { id: "login", objective: "sign in works" }] };

interface Script {
  /* What each turn of a flow answers, by flow id; the last entry repeats. `writes` puts the flow's file in its workspace. */
  answers: Record<string, Array<Partial<DelegationResult> & { throws?: Error; hold?: Promise<void>; writes?: boolean; stoppable?: true }>>;
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
    evidence: [], concerns: [], unresolvedQuestions: [], recommendation: "accept", acceptance: [], ...over,
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
    const { throws: _t, hold: _h, writes, stoppable: _s, ...over } = answer;
    if (writes) script.hasFile.add(flow);
    return result(brief, over);
  };
  r.deps = {
    redaction: new PatternRedactionAdapter(),
    sidekick: {
      open: async (brief, opts) => {
        const session = ++r.sessionsOpened;
        r.executed.push({ brief, opts, session });
        /* A turn marked stoppable ends when its flow is stopped, as the executor's does for a holder that asked to keep the stopped session: the session is returned idle, its first result a failure. */
        const stopped = opts.keepStopped && opts.signal && script.answers[flowOf(brief.delegationId)]?.[0]?.stoppable
          ? new Promise<"stopped">((resolve) => opts.signal!.addEventListener("abort", () => resolve("stopped"), { once: true }))
          : undefined;
        const answered = answerOf(brief);
        const first = stopped && (await Promise.race([answered, stopped])) === "stopped" ? result(brief, { status: "failed", summary: "The turn was stopped before the sidekick answered.", filesChanged: [] }) : await answered;
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
        runWritesLeft: () => r.closedLoop.limits.maxDevWrites,
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
    readsOf: () => [],
    signals: () => ({ calls: 0, blocks: 0, invalidations: 0, renewals: 0 }),
    close: async () => {},
  };
  return r;
}

function input(r: Rig, over: Partial<CoordinateInput> = {}): CoordinateInput {
  return {
    runId: "run-1", app: "shop", objective: "the cart", mirrorDir: "/m", specDir: "/m/e2e", specRelDir: "e2e",
    settings: DEFAULT_COORDINATION_SETTINGS,
    facts: { hasLogin: true },
    closedLoop: r.closedLoop,
    agentBrowser: r.agentBrowser,
    plan: async () => ({ plan: FANOUT_PLAN, parsed: true, timedOut: false }),
    ...over,
  };
}

/* A lead whose planning session answers its review turns with these answers in order (the last repeats), and records what it was asked. */
function leadWith(answers: unknown[][], plan: Record<string, unknown> = FANOUT_PLAN): { plan: CoordinateInput["plan"]; asked: string[]; turnOpts: LeadTurnOpts[]; disposed: () => number } {
  const asked: string[] = [];
  const turnOpts: LeadTurnOpts[] = [];
  let disposed = 0;
  return {
    asked,
    turnOpts,
    disposed: () => disposed,
    plan: async () => ({
      plan,
      parsed: true,
      timedOut: false,
      lead: {
        askForPlan: noPlanAnswer,
        ask: async (text: string, opts: LeadTurnOpts) => {
          asked.push(text);
          turnOpts.push(opts);
          const review = answers[Math.min(asked.length - 1, answers.length - 1)]!;
          return { output: JSON.stringify({ review }), timedOut: false };
        },
        dispose: async () => { disposed += 1; },
      },
    }),
  };
}

test("a generation that cannot plan, a login with no grant to author with and a run with too little time are refused with their own reason, before any session is opened", async () => {
  const r = rig();
  let asked = 0;
  const plan = async (): Promise<PlanOutput> => { asked += 1; return { plan: FANOUT_PLAN, parsed: true, timedOut: false }; };
  const refusalOf = (result: Awaited<ReturnType<typeof r.coordinator.coordinate>>): string | undefined => (result.action === "refused" ? result.refusal : undefined);

  const noPlan = await r.coordinator.coordinate(input(r, { plan: undefined }));
  assert.equal(refusalOf(noPlan), AUTHORING_REFUSAL.CANNOT_PLAN);
  assert.equal(noPlan.signal.refusal, AUTHORING_REFUSAL.CANNOT_PLAN);

  const bare = await r.coordinator.coordinate(input(r, { plan, closedLoop: undefined, agentBrowser: undefined }));
  assert.equal(refusalOf(bare), AUTHORING_REFUSAL.NO_AUTHOR_GRANT, "a login and neither run_spec nor the browser");
  assert.equal(bare.signal.authoring, "excluded");

  const hurried = await r.coordinator.coordinate(input(r, { plan, deadline: { remainingMs: () => 60_000 } }));
  assert.equal(refusalOf(hurried), AUTHORING_REFUSAL.NO_TIME);
  assert.equal(asked, 0, "none of them paid for a planning turn");
  assert.equal(r.executed.length, 0);
  assert.equal(r.created.length, 0);
});

test("with the authenticated browser, a plan is never asked for more flows at once than the browser has pages, whatever the app allows", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const settings = { ...DEFAULT_COORDINATION_SETTINGS, maxParallel: MAX_SESSION_PAGES + 2 };
  await r.coordinator.coordinate(input(r, { settings, plan: async (p) => (seen.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(seen[0]!.maxParallel, MAX_SESSION_PAGES);
});

test("the planning turn is told the use cases the change makes testable, and those the plan leaves unplanned are reported", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", routes: ["/cart"] }, { id: "login", objective: "sign in works", routes: ["/shops/madrid"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/cart", "/shops/:city", "/orders"]), plan: async (p) => (seen.push(p), { plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.deepEqual(seen[0]?.candidates?.map((c) => c.id), ["uc-/cart", "uc-/shops/:city", "uc-/orders"]);
  const reported = r.events.filter((e) => /unplanned/.test(e.reason ?? ""));
  assert.equal(reported.length, 1);
  assert.match(reported[0]!.reason, /1 use case.*uc-\/orders/);
  assert.doesNotMatch(reported[0]!.reason, /shops/, "a template a flow visits a page of counts as covered");
});

test("a page the change reaches only through an operation it changed is a change page of the plan", async () => {
  const r = rig({ hasFile: new Set(["cart"]) });
  const operation: UseCaseCandidate = {
    id: "uc-GET /api/orders",
    entry: { kind: "operation", repo: "org/api", verb: "GET", path: "/api/orders" },
    tier: "direct", basis: "contract", evidence: ["org/api: GET /api/orders"], seeds: [], confidence: 1,
    reachability: "via-page", pages: ["/orders"], existingSpecs: [],
  };
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", routes: ["/cart"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { candidates: [...pageCandidates(["/cart"]), operation], plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const last = r.plans.at(-1)!;
  assert.deepEqual(last.changeRoutes, ["/cart", "/orders"]);
  assert.deepEqual(last.unvisited, ["/orders"]);
});

test("the run keeps the plan it admitted, the change pages each flow visits and how each flow ended", async () => {
  const r = rig({ hasFile: new Set(["cart"]) });
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", acceptance: ["the total adds the lines"], routes: ["/cart"] }, { id: "login", objective: "sign in works", routes: ["/login"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/cart", "/orders"]), plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const last = r.plans.at(-1)!;
  assert.equal(last.runId, "run-1");
  assert.equal(last.kind, "fanout");
  assert.deepEqual(last.changeRoutes, ["/cart", "/orders"]);
  assert.deepEqual(last.unvisited, ["/orders"]);
  assert.deepEqual(last.candidates.map((c) => [c.id, c.state]), [["uc-/cart", "planned"], ["uc-/orders", "unplanned"]]);
  assert.deepEqual(last.candidates.map((c) => c.pages), [["/cart"], ["/orders"]], "the snapshot keeps the pages that reach each candidate");
  const cart = last.flows.find((f) => f.id === "cart")!;
  assert.deepEqual({ objective: cart.objective, acceptance: cart.acceptance, routes: cart.routes, specFile: cart.specFile, visits: cart.visits }, { objective: "the cart total", acceptance: ["the total adds the lines"], routes: ["/cart"], specFile: "flows/cart.spec.ts", visits: ["/cart"] });
  assert.equal(cart.outcome?.kind, "delivered");
  assert.deepEqual(cart.outcome?.specs, ["flows/cart.spec.ts"]);
  const login = last.flows.find((f) => f.id === "login")!;
  assert.deepEqual(login.visits, []);
  assert.ok(login.outcome && login.outcome.kind !== "delivered", "a flow that wrote nothing did not deliver");
});

test("a plan that is a no-op or is rejected is kept with why", async () => {
  const noop = rig();
  await noop.coordinator.coordinate(input(noop, { candidates: pageCandidates(["/cart"]), plan: async () => ({ parsed: true, timedOut: false, noopReason: "only a comment changed" }) }));
  assert.deepEqual(noop.plans.map((p) => [p.kind, p.reason, p.flows.length, p.unvisited, p.candidates]), [["noop", "only a comment changed", 0, ["/cart"], []]]);
  const lead = rig();
  await lead.coordinator.coordinate(input(lead, { plan: async () => ({ plan: { kind: "lead" }, parsed: true, timedOut: false }) }));
  assert.deepEqual(lead.plans.map((p) => [p.kind, p.reason]), [["rejected", PLAN_DOWNGRADE.MALFORMED]]);
});

test("a plan of one flow opens exactly one sidekick session and the lead reviews it", async () => {
  const r = rig({ hasFile: new Set(["detail"]) });
  const plan = { kind: "fanout", flows: [{ id: "detail", objective: "the detail page", routes: ["/shops/madrid/:slug"] }] };
  const lead = leadWith([[{ flow: "detail", action: "accept" }]], plan);
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/shops/:province/:slug", "/shops/:province/:slug/menu"]), plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(outcome.action, "fanout");
  assert.equal(r.sessionsOpened, 1);
  assert.ok(lead.asked.length >= 1, "the lead reviewed the flow");
  assert.equal(outcome.signal.flows, 1);
  assert.equal(outcome.signal.delivered, 1);
  const reported = r.events.filter((e) => /unplanned/.test(e.reason ?? ""));
  assert.equal(reported.length, 1);
  assert.match(reported[0]!.reason, /1 use case.*uc-\/shops\/:province\/:slug\/menu$/);
});

test("a plan of kind lead is rejected as malformed and names no use case", async () => {
  const lead = rig();
  const outcome = await lead.coordinator.coordinate(input(lead, { candidates: pageCandidates(["/cart"]), plan: async () => ({ plan: { kind: "lead" }, parsed: true, timedOut: false }) }));
  assert.equal(outcome.action === "refused" ? outcome.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.MALFORMED}`);
  assert.equal(lead.events.filter((e) => /unplanned/.test(e.reason ?? "")).length, 0);
});

test("the lead's review names the use cases no flow covers and those no flow covers with a spec that passed run_spec", async () => {
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", routes: ["/cart"] }, { id: "login", objective: "sign in works", routes: ["/login"] }] };
  const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }]], plan);
  const r = rig();
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "b", status: flowInput.flowId === "cart" ? "passed" : "failed", devWrites: 0 });
    return { ...handle, isClosed: async () => flowInput.flowId === "cart" };
  })(r.closedLoop.openFlow);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { candidates: pageCandidates(["/cart", "/login", "/orders"]), plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  /* The flow blocks carry routes only in their objective: a use case is named in the review only when it is flagged. */
  const first = lead.asked[0]!;
  assert.ok(first.includes("uc-/orders"), "the use case no flow covers");
  assert.ok(first.includes("uc-/login"), "the use case whose only flow has not passed");
  assert.ok(!first.includes("uc-/cart"), "a use case a passing flow covers is not flagged");
});

test("a flow that names a candidate page by its template, whatever its parameters are called, covers it", async () => {
  const r = rig();
  const plan = { kind: "fanout", flows: [{ id: "detail", objective: "the detail page", routes: ["/shops/:province/:shopSlug"] }, { id: "menu", objective: "the menu page", routes: ["/shops/[province]/[slug]/menu"] }] };
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/shops/:province/:slug", "/shops/:province/:slug/menu", "/shops/:province"]), plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const reported = r.events.filter((e) => /unplanned/.test(e.reason ?? ""));
  assert.equal(reported.length, 1);
  assert.match(reported[0]!.reason, /1 use case.*uc-\/shops\/:province$/);
});

test("the planning turn is given the limits the plan is held to, and one that ran out of time or gave neither plan nor reason is refused", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  const timedOut = await r.coordinator.coordinate(input(r, { plan: async (p) => (seen.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(timedOut.action === "refused" ? timedOut.refusal : undefined, AUTHORING_REFUSAL.PLAN_TIMED_OUT);
  assert.deepEqual(seen[0], { maxParallel: DEFAULT_COORDINATION_SETTINGS.maxParallel, flowBudgetMs: DEFAULT_COORDINATION_SETTINGS.flowBudgetMs.opencode, budgetMs: DEFAULT_COORDINATION_SETTINGS.planBudgetMs });
  const nothing = await r.coordinator.coordinate(input(r, { plan: async () => ({ parsed: true, timedOut: false }) }));
  assert.equal(nothing.action === "refused" ? nothing.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.NO_PLAN}`);
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

test("a plan that cannot be admitted is refused with its reason on the signal", async () => {
  const r = rig();
  const alone = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "lead" }, parsed: true, timedOut: false }) }));
  assert.equal(alone.action === "refused" ? alone.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.MALFORMED}`);
  assert.equal(alone.signal.refusal, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.MALFORMED}`);
  const over = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "fanout", flows: [] }, parsed: true, timedOut: false }) }));
  assert.equal(over.action === "refused" ? over.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.EMPTY}`);
});

test("a plan of no flows whose use cases are all dropped with a reason is the lead's declared no-op, its reasons named; one with no reasoned drop is still refused", async () => {
  const r = rig();
  const dropped = [{ candidate: "uc-aaaa1111", basis: "already-covered", reason: "already proven by the existing spec flows/gate.spec.ts" }, { candidate: "uc-bbbb2222", basis: "needs-unavailable-state", reason: "not observable on the web build" }];
  const declared = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "fanout", flows: [], dropped }, parsed: true, timedOut: false }) }));
  assert.equal(declared.action, "noop");
  for (const drop of dropped) assert.ok(declared.action === "noop" && declared.reason.includes(drop.candidate) && declared.reason.includes(drop.reason), drop.candidate);
  assert.equal(r.created.length, 0);
  const unreasoned = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: { kind: "fanout", flows: [], dropped: [{ candidate: "uc-aaaa1111" }] }, parsed: true, timedOut: false }) }));
  assert.equal(unreasoned.action === "refused" ? unreasoned.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.EMPTY}`);
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
  assert.equal(cart.input.limits.maxCalls, 8, "a flow's eight minutes run eight calls of a minute");
  assert.equal(cart.input.limits.maxDevWrites, 6);
  assert.equal(await cart.input.stage(), ".qa-probe/cart.spec.ts");
  assert.deepEqual(r.staged, ["run-1-flow-cart:e2e/flows/cart.spec.ts->.qa-probe/cart.spec.ts"]);
  assert.ok(r.flowLoops.every((l) => l.closed === 1));
  /* A flow's 8 minutes run 16 browser calls of 30 seconds. */
  assert.deepEqual([...r.shares].sort(), [["run-1-flow-cart", 16], ["run-1-flow-login", 16]]);
});

test("a sidekick is told its tool budgets in the task: the run_spec share of its flow and the browser's", async () => {
  const r = rig();
  await r.coordinator.coordinate(input(r));
  const task = r.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!.brief.task;
  assert.match(task, /run_spec: at most 8 calls/);
  assert.match(task, /up to 6 requests that write to DEV while the run's shared cap lasts \(12 left now\)/);
  assert.match(task, /at most 16 authbrowser_\* calls/);
  assert.match(task, /e2e\/flows\/cart\.spec\.ts/);
  const bare = rig();
  await bare.coordinator.coordinate(input(bare, { closedLoop: undefined }));
  assert.match(bare.executed[0]!.brief.task, /cannot run the spec/);
});

test("an app that allows no writes to DEV gives its flows no run_spec loop, and their briefs and the run's decisions say so", async () => {
  const r = rig();
  r.closedLoop.limits = { ...r.closedLoop.limits, maxDevWrites: 0 };
  await r.coordinator.coordinate(input(r));
  assert.equal(r.flowLoops.length, 0);
  const task = r.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!.brief.task;
  assert.match(task, /the app allows no requests that write to DEV/);
  assert.ok(r.events.some((e) => e.flowId === "cart" && /the app allows no requests that write to DEV/.test(e.reason)));
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
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { facts: { hasLogin: false }, agentBrowser: undefined }));
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

test("a sidekick answer that could not be read is recorded as unreadable, not as a reported failure", async () => {
  const r = rig({ answers: { cart: [{ status: "failed", summary: "sidekick output was not a valid DelegationResult", filesChanged: [], readMiss: "unreadable" }] }, hasFile: new Set(["login"]) });
  await r.coordinator.coordinate(input(r));
  const turn = r.events.find((e) => /flow cart turn 1/.test(e.reason ?? ""));
  assert.equal(turn?.failureClass, UNREADABLE_ANSWER);
  assert.equal(turn?.sidekickStatus, UNREADABLE_ANSWER);
  const reported = rig({ answers: { cart: [{ status: "failed", summary: "no selector found", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  await reported.coordinator.coordinate(input(reported));
  const said = reported.events.find((e) => /flow cart turn 1/.test(e.reason ?? ""));
  assert.equal(said?.failureClass, "failed");
  assert.equal(said?.sidekickStatus, "failed");
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
  assert.equal(cart[1]!.opts.kind, "author");

  assert.equal(cart[1]!.opts.model, "escalated/model");
  assert.match(cart[1]!.opts.feedback ?? "", /Start from the cart page/);
  assert.ok(r.sessionsDisposed.includes(cart[0]!.session), "the stuck session was ended");
  assert.equal(outcome.action === "fanout" ? outcome.aggregated.incompleteFlows.length : -1, 0);
});

test("a replace whose brief is over the escalated model's known window is not sent, and the spec the flow already delivered stays delivered", async () => {
  const lead = leadWith([[{ flow: "cart", action: "replace", instruction: "again" }], []]);
  const r = rig();
  /* The standard model's window is unknown (sent, fail open); the escalated one's is far too small for any brief. */
  const windows = { windowTokens: (_role: string, model?: string) => (model === "escalated/model" ? 10 : undefined) };
  const noRoom = { forRole: () => ({ growthTokensPerStep: 0, steps: 0, basis: "cold-start" as const, samples: 0 }) };
  const outcome = await new LeadSidekicks({ ...r.deps, contextBudget: new ContextBudget(windows, noRoom) }).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail(`fanout expected, got ${outcome.action}`);
  await outcome.pass?.release();
  assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1, "the replacement was never sent");
  assert.deepEqual(outcome.aggregated.specs.sort(), ["flows/cart.spec.ts", "flows/login.spec.ts"]);
  assert.deepEqual(outcome.aggregated.incompleteFlows, []);
  assert.ok(r.events.some((e) => e.flowId === "cart" && e.overWindow?.includes("cart")));
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

test("a flow whose run_spec is refused for writes is not sent back to pass it: the lead is told, and its accept stands", async () => {
  for (const spent of ["flow", "run"] as const) {
    const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }], []]);
    const r = rig();
    r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
      const handle = original(flowInput)!;
      if (flowInput.flowId !== "cart") return { ...handle, isClosed: async () => true };
      r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "b", status: "failed", devWrites: flowInput.limits.maxDevWrites, failures: [{ detail: "Expected: 3 Received: 0", path: "/cart" }] });
      return spent === "flow"
        ? { ...handle, signals: () => ({ calls: 1, devWrites: flowInput.limits.maxDevWrites }) }
        : { ...handle, runWritesLeft: () => 0 };
    })(r.closedLoop.openFlow);
    const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
    if (outcome.action === "fanout") await outcome.pass?.release();
    assert.equal(r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart").length, 1, `${spent}: the flow is not sent back`);
    assert.match(lead.asked[0] ?? "", /refused for writes/, `${spent}: the review states it`);
    assert.equal(outcome.action === "fanout" ? outcome.signal.review?.accepted : -1, 2, `${spent}: both accepts stand`);
  }
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
    const plan = async (): Promise<PlanOutput> => ({ plan: FANOUT_PLAN, parsed: true, timedOut: false, lead: { askForPlan: noPlanAnswer, ask: async () => answer, dispose: async () => {} } });
    const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan }));
    assert.equal(outcome.action === "fanout" ? outcome.aggregated.incompleteFlows.length : -1, 1);
    assert.equal(r.executed.length, 2, "nothing was asked again");
    assert.equal(outcome.signal.review?.turns, 1);
  }
});

test("a review turn that fails leaves the flows as they are: what was delivered stays delivered", async () => {
  const r = rig();
  const plan = async (): Promise<PlanOutput> => ({ plan: FANOUT_PLAN, parsed: true, timedOut: false, lead: { askForPlan: noPlanAnswer, ask: async () => { throw new Error("provider down"); }, dispose: async () => {} } });
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

test("a flow that ran out of its time keeps its idle sidekick session for the lead's review, which revises it in place, and the pass release deletes it", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "finish the cart total" }], []]);
  const r = rig({ answers: { cart: [{ stoppable: true, hold: new Promise<void>(() => {}) }, { writes: true }] } });
  const pending = new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, settings: { ...DEFAULT_COORDINATION_SETTINGS, flowBudgetMs: { opencode: 100_000 } } }));
  for (let i = 0; i < 20; i++) await settle();
  r.timers.advance(100_000);
  await settle();
  r.timers.advance(DEFAULT_ABORT_GRACE);
  const outcome = await pending;
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const sessionOf = (flow: string): number => r.executed.find((e) => !e.asked && e.brief.delegationId === `run-1-flow-${flow}`)!.session;
  const revised = r.executed.find((e) => e.asked && e.brief.delegationId === "run-1-flow-cart");
  assert.equal(revised?.session, sessionOf("cart"), "the lead's revision reached the flow's own session, not a fresh one");
  assert.equal(r.sessionsOpened, 2);
  assert.equal(r.events.some((e) => e.kind === "lead-decision" && e.overrideReason === "session-gone"), false);
  assert.deepEqual(r.sessionsDisposed, [], "the session outlives the flow's time and the review");
  await outcome.pass!.release();
  assert.deepEqual([...r.sessionsDisposed].sort(), [1, 2], "the pass's release deletes it, once");
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

test("the lead's session ends however the plan comes out: a no-op or a plan that cannot be admitted", async () => {
  for (const planned of [{ kind: "noop", reason: "nothing" }, { kind: "lead" }, { kind: "fanout", flows: [] }]) {
    let disposed = 0;
    const r = rig();
    const plan = async (): Promise<PlanOutput> => ({ plan: planned, parsed: true, timedOut: false, lead: { askForPlan: noPlanAnswer, ask: async () => ({ output: "", timedOut: false }), dispose: async () => { disposed += 1; } } });
    await new LeadSidekicks(r.deps).coordinate(input(r, { plan }));
    assert.equal(disposed, 1, JSON.stringify(planned));
  }
});

test("flows that all finished nothing end the coordination on no decision, with time to spare or not, and the lead authors nothing", async () => {
  const failing = { answers: { cart: [{ status: "failed" as const, summary: "x", filesChanged: [] }], login: [{ status: "failed" as const, summary: "y", filesChanged: [] }] }, hasFile: new Set<string>() };
  const roomy = rig(failing);
  const back = await roomy.coordinator.coordinate(input(roomy));
  assert.equal(back.action, "fanout");
  assert.equal(back.action === "fanout" ? back.aggregated.end : "", GENERATION_END.UNDECIDED_EMPTY);
  assert.equal(roomy.events.some((e) => e.kind === "escalation" && e.delegationId === undefined), false, "the lead does not take the change over");

  const tight = rig(failing);
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
  /* The sidekicks' turns are held until after the abort, so the cancel always lands while they are running. */
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const r = rig({ answers: { cart: [{ hold }], login: [{ hold }] } });
  const pending = r.coordinator.coordinate(input(r, { signal: controller.signal }));
  await settle();
  controller.abort();
  release();
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

test("each sidekick's brief carries the run's harness facts and the specs the suite holds, and none of either when the run has none", async () => {
  const plan = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", routes: ["/cart"] }] };
  const harnessFacts = { fixtures: { file: "fixtures.ts", exports: ["test", "expect"] } };
  const existingSpecs = ["flows/home.spec.ts — flow: home, objective: landing"];
  const withFacts = rig();
  await withFacts.coordinator.coordinate(input(withFacts, { harnessFacts, existingSpecs, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  const brief = withFacts.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!.brief;
  assert.deepEqual(brief.harnessFacts, harnessFacts);
  assert.deepEqual(brief.suite, existingSpecs);
  const bare = rig();
  await bare.coordinator.coordinate(input(bare, { plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  const bareBrief = bare.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!.brief;
  assert.equal(bareBrief.harnessFacts, undefined);
  assert.equal(bareBrief.suite, undefined);
});

test("each sidekick's brief carries the evidence for the candidate pages its flow visits, the facts of its own pages and the tools its turn grants", async () => {
  const r = rig();
  const candidates = [
    pageCandidate("/shops/:city", ["src/util/format.ts::formatMoney", "src/shops/list.page.ts::ShopList", "page /shops/:city"]),
    pageCandidate("/orders", ["src/util/format.ts::formatMoney", "src/orders/orders.page.ts::Orders", "page /orders"]),
  ];
  const confirmedDataRoutes = [{ path: "/shops/madrid", resultCount: 3 }, { path: "/orders", resultCount: 2 }];
  const plan = { kind: "fanout", flows: [{ id: "shops", objective: "the shop list", routes: ["/shops/madrid"] }, { id: "login", objective: "sign in works", routes: ["/login"] }] };
  await r.coordinator.coordinate(input(r, { candidates, confirmedDataRoutes, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  const brief = (flow: string) => r.executed.find((e) => e.brief.delegationId === `run-1-flow-${flow}`)!.brief;
  assert.deepEqual(brief("shops").candidates?.map((c) => c.evidence), [["src/util/format.ts::formatMoney", "src/shops/list.page.ts::ShopList", "page /shops/:city"]]);
  assert.equal(brief("login").candidates, undefined, "a flow that visits no candidate page carries none");
  assert.deepEqual(brief("shops").knownFacts.map((f) => f.dataRef), ["/shops/madrid"]);
  assert.deepEqual(brief("login").knownFacts, [], "another flow's page is not this flow's fact");
  assert.deepEqual(brief("shops").tools, ["read", "write", "run_spec", "authbrowser"]);
});

test("a flow's brief preloads its changed code while it fits the author's window, names the rest by file and range, and hands the fit to the turn", async () => {
  const diff = (hunks: number): string => ["diff --git a/src/cart.ts b/src/cart.ts", "--- a/src/cart.ts", "+++ b/src/cart.ts", ...Array.from({ length: hunks }, (_, i) => [`@@ -${1 + i * 50},1 +${1 + i * 50},41 @@`, " keep", ...Array.from({ length: 40 }, (_, j) => `+  total${i} += item${j}.price * quantity;`)]).flat()].join("\n");
  const candidates = [pageCandidate("/cart", ["page /cart"], { seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 1_000 } }] })];
  const plan = planOf([{ ...cartFlow, candidates: ["uc-/cart"] }]);
  const windowed = (windowTokens: number | undefined) => new ContextBudget({ windowTokens: () => windowTokens }, { forRole: () => ({ growthTokensPerStep: 0, steps: 0, basis: "cold-start", samples: 0 }) });
  const briefWith = async (windowTokens: number | undefined) => {
    const r = rig();
    r.coordinator = new LeadSidekicks({ ...r.deps, contextBudget: windowed(windowTokens) });
    const outcome = await r.coordinator.coordinate(input(r, { candidates, change: { diffs: [diff(6)] }, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
    if (outcome.action === "fanout") await outcome.pass?.release();
    return r.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!;
  };
  const open = await briefWith(undefined);
  assert.equal(open.brief.change?.hunks.length, 6, "an unknown window preloads every owned hunk");
  assert.equal(open.opts.contextFit?.outcome, "unknown");
  const tight = await briefWith(2_000);
  assert.ok(tight.brief.change!.hunks.length < 6 && tight.brief.change!.hunks.length > 0);
  assert.equal(tight.brief.change!.references.filter((ref) => /^src\/cart\.ts:\d+-\d+ /.test(ref)).length, 6 - tight.brief.change!.hunks.length);
  assert.equal(tight.opts.contextFit?.outcome, "fits");
});

test("a flow's brief over the author's window gives its suite listing up to the window before the flow is called over-window, and the turn is handed the fit rule", async () => {
  const existingSpecs = Array.from({ length: 200 }, (_, i) => `flows/area-${i % 4}/flow-${i}.spec.ts — flow: f${i}, objective: ${"checks the page. ".repeat(20)}`);
  const plan = planOf([cartFlow]);
  const noRoom = { forRole: () => ({ growthTokensPerStep: 0, steps: 0, basis: "cold-start" as const, samples: 0 }) };
  const run = async (windowTokens: number) => {
    const r = rig();
    r.coordinator = new LeadSidekicks({ ...r.deps, contextBudget: new ContextBudget({ windowTokens: () => windowTokens }, noRoom) });
    const outcome = await r.coordinator.coordinate(input(r, { existingSpecs, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
    if (outcome.action === "fanout") await outcome.pass?.release();
    return r.executed.find((e) => e.brief.delegationId === "run-1-flow-cart");
  };
  const whole = await run(10_000_000);
  assert.ok(whole && whole.opts.fit !== undefined, "the turn is handed the fit rule");
  const wholeTokens = whole.opts.contextFit!.promptTokens;

  const tight = await run(Math.floor(wholeTokens * 0.6));
  assert.ok(tight, "the brief is sent: its suite listing gave way instead of the flow being dropped");
  assert.equal(tight.opts.contextFit?.outcome, "fits");
  assert.ok(tight.opts.contextFit!.promptTokens < wholeTokens, "the fit it was judged by is that of the brief as it is rendered");
});

test("every flow of a large plan gets its loop and the calls its own time can run, while the run's DEV-write cap stays what it was", async () => {
  const run = async (count: number) => {
    const r = rig({ hasFile: new Set() });
    const devWritesCap = r.closedLoop.limits.maxDevWrites;
    const flows = Array.from({ length: count }, (_, i) => ({ id: `f${i}`, objective: `flow ${i}` }));
    const outcome = await r.coordinator.coordinate(input(r, { plan: async () => ({ plan: planOf(flows), parsed: true, timedOut: false }) }));
    if (outcome.action === "fanout") await outcome.pass?.release();
    return { r, devWritesCap };
  };
  const flowMs = DEFAULT_COORDINATION_SETTINGS.flowBudgetMs.opencode;
  for (const count of [2, 10]) {
    const { r, devWritesCap } = await run(count);
    /* 12 writes: a share of 6 each for 2 flows; for 10 flows each keeps the minimum of 2, and the run's one ledger refuses writes past 12. */
    assert.equal(r.flowLoops.length, count, `${count} flows: every flow gets its loop`);
    assert.ok(r.flowLoops.every((l) => l.input.limits.maxDevWrites === Math.max(Math.floor(devWritesCap / count), Math.min(devWritesCap, MIN_RUN_SPEC_DEV_WRITES_PER_FLOW))), `${count} flows: each its share`);
    assert.ok(r.flowLoops.every((l) => l.input.limits.maxCalls === Math.floor(flowMs / r.closedLoop.limits.perCallMs)), `${count} flows: run_spec by each flow's time`);
    assert.ok(r.shares.every(([, calls]) => calls === Math.floor(flowMs / r.agentBrowser.limits.perCallMs)), `${count} flows: browser by each flow's time`);
    assert.ok(r.shares.reduce((sum, [, calls]) => sum + calls, 0) > r.agentBrowser.limits.maxCalls || count < 10, "the grants add up past the browser's own total");
    assert.equal(r.closedLoop.limits.maxDevWrites, devWritesCap, "the run's DEV-write cap is not raised");
  }
});

test("a flow whose brief is over the author's known window even with all its change named by reference is not sent, and is recorded as an undelivered flow", async () => {
  const diff = ["diff --git a/src/cart.ts b/src/cart.ts", "--- a/src/cart.ts", "+++ b/src/cart.ts", ...Array.from({ length: 60 }, (_, i) => [`@@ -${1 + i * 10},1 +${1 + i * 10},2 @@`, " keep", `+  total${i} += price;`]).flat()].join("\n");
  const candidates = [pageCandidate("/cart", ["page /cart"], { seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 1_000 } }] })];
  const plan = planOf([{ ...cartFlow, candidates: ["uc-/cart"] }, loginFlow]);
  const noRoom = { forRole: () => ({ growthTokensPerStep: 0, steps: 0, basis: "cold-start" as const, samples: 0 }) };
  const run = async (windowTokens: number) => {
    const r = rig();
    r.coordinator = new LeadSidekicks({ ...r.deps, contextBudget: new ContextBudget({ windowTokens: () => windowTokens }, noRoom) });
    const outcome = await r.coordinator.coordinate(input(r, { candidates, change: { diffs: [diff] }, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
    if (outcome.action === "fanout") await outcome.pass?.release();
    return { r, outcome };
  };
  /* The login flow's brief carries no change, so it is the same brief under any window: the window is set just above it. */
  const wide = await run(10_000_000);
  const loginTokens = wide.r.executed.find((e) => e.brief.delegationId === "run-1-flow-login")!.opts.contextFit!.promptTokens;
  const { r, outcome } = await run(loginTokens + 10);

  assert.deepEqual(r.executed.map((e) => e.brief.delegationId), ["run-1-flow-login"], "the cart flow's brief is never sent");
  if (outcome.action !== "fanout") return assert.fail(`fanout expected, got ${outcome.action}`);
  assert.equal(outcome.aggregated.end, GENERATION_END.DELIVERED, "one flow over the window does not end the run by itself");
  assert.deepEqual(outcome.aggregated.incompleteFlows.map((f) => [f.id, f.kind]), [["cart", "over-window"]]);
  assert.deepEqual(outcome.signal.overWindow, ["cart"]);
  assert.equal(outcome.signal.incomplete, 1);
  const recorded = r.events.find((e) => e.kind === "lead-decision" && e.flowId === "cart" && e.contextFit !== undefined);
  assert.ok(recorded, "the decision is recorded with its numbers");
  assert.equal(recorded!.contextFit!.windowTokens, loginTokens + 10);
  assert.equal(recorded!.contextFit!.workingRoomTokens, 0);
  assert.ok(recorded!.contextFit!.promptTokens > loginTokens + 10);
  assert.ok(r.disposed.includes("/w/run-1-flow-cart"), "what the flow held is released");
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
        askForPlan: noPlanAnswer,
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
      askForPlan: noPlanAnswer,
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

const LOOSE_ARMS = [{ text: "decision arm src/a.ts:4 if: the else" }, { text: "decision arm src/a.ts:9 ?: the right branch" }];
const OUT_OF_RANGE_ORDER = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [5, 6], instruction: "cover the arms" }] });
const VALID_ORDER = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [1, 2], instruction: "cover the arms" }] });

test("an order that names no finding goes back to the lead once with the reason, and the re-answer is admitted as any answer", async () => {
  const lead = leadAnswering([ACCEPT_ALL, OUT_OF_RANGE_ORDER, VALID_ORDER]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct(LOOSE_ARMS, CORRECTION_ORIGIN.COVERAGE);
  await outcome.pass!.release();
  assert.equal(lead.asked.length, 3, "the correction turn and the one re-ask");
  assert.match(lead.asked[2]!, /not admitted/);
  assert.match(lead.asked[2]!, /the order names no finding the flow is to correct/);
  assert.match(lead.asked[2]!, /1\.\.2/, "it says which numbers are findings");
  assert.deepEqual(corrected.specs, ["flows/cart.spec.ts"]);
  assert.deepEqual(corrected.unrouted, []);
  const asked = r.executed.find((e) => e.asked && e.brief.delegationId === "run-1-flow-cart")!;
  assert.match(asked.opts.feedback!, /decision arm src\/a\.ts:4/);
  assert.match(asked.opts.feedback!, /decision arm src\/a\.ts:9/);
});

test("an order the re-answer still gets refused is recorded, asked about once only, and its findings are left unrouted with no cold regeneration", async () => {
  const lead = leadAnswering([ACCEPT_ALL, OUT_OF_RANGE_ORDER, OUT_OF_RANGE_ORDER]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct(LOOSE_ARMS, CORRECTION_ORIGIN.COVERAGE);
  await outcome.pass!.release();
  assert.equal(lead.asked.length, 3, "never a second re-ask");
  assert.deepEqual(corrected.specs, []);
  assert.deepEqual(corrected.unrouted, [0, 1]);
  assert.equal(r.executed.some((e) => e.asked), false, "no sidekick was asked");
  assert.ok(r.events.some((e) => /not taken: the order names no finding/.test(e.reason ?? "")), "the refusal is on the record");
  assert.ok(r.events.some((e) => /left unrouted/.test(e.reason ?? "")), "the unrouted findings are on the record");
  assert.equal(outcome.pass!.tally().unrouted, 2, "counted once, not once per asking");
});

test("an answer that is admitted at once is not asked about again", async () => {
  const lead = leadAnswering([ACCEPT_ALL, VALID_ORDER]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  await outcome.pass!.correct(LOOSE_ARMS, CORRECTION_ORIGIN.COVERAGE);
  await outcome.pass!.release();
  assert.equal(lead.asked.length, 2);
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

/* ---- exploration: the lead asks read-only sidekicks before it plans ---- */

interface ExploreRig {
  /* The explore sessions opened, with the brief and options each was opened with. */
  opened: Array<{ brief: DelegationBrief; opts: SidekickExecuteOpts }>;
  graphShares: Array<[string, number]>;
  /* What the lead was asked in the same session after the exploration. */
  askedForPlan: string[];
  disposedLead: () => number;
  plan: CoordinateInput["plan"];
  input(over?: Partial<CoordinateInput>): CoordinateInput;
}

const finding = (kind: string, ref: string, claim: string) => ({ claim, kind, ref, evidence: "read it" });

/* A rig whose explore sidekicks answer with `answers` (by question id) and whose lead asks to explore first, then answers `after` in its own session. */
function exploring(r: Rig, request: unknown[], answers: Record<string, unknown>, after: { plan?: Record<string, unknown>; explore?: unknown[]; noopReason?: string } = { plan: FANOUT_PLAN }): ExploreRig {
  const opened: ExploreRig["opened"] = [];
  const author = r.deps.sidekick;
  r.deps.sidekick = {
    open: async (brief, opts) => {
      if (opts.kind !== "explore") return author.open(brief, opts);
      opened.push({ brief, opts });
      const id = brief.delegationId.replace(/^.*-explore-/, "");
      return {
        first: { ...result(brief, { filesChanged: [] }), exploration: answers[id] as never },
        ask: async () => result(brief),
        dispose: async () => {},
      };
    },
  };
  const askedForPlan: string[] = [];
  let disposed = 0;
  const graphShares: Array<[string, number]> = [];
  const lead = {
    ask: async () => ({ output: "", timedOut: false }),
    askForPlan: async (text: string) => { askedForPlan.push(text); return { ...after, parsed: true, timedOut: false }; },
    dispose: async () => { disposed += 1; },
  };
  const plan: CoordinateInput["plan"] = async () => ({ explore: request, parsed: true, timedOut: false, lead });
  const codeGraph = { limits: { maxCalls: 40, maxFiles: 8, maxAnswerChars: 8000 }, signals: () => ({ calls: 0, refused: 0, failed: 0 }), grantShare: (id: string, calls: number) => void graphShares.push([id, calls]), close: () => {} };
  const contextPack = [`### ${PACK_HEADINGS.liveDom}`, "route /cart:", "  button \"Checkout\""].join("\n");
  return { opened, graphShares, askedForPlan, disposedLead: () => disposed, plan, input: (over = {}) => input(r, { plan, codeGraph, contextPack, closedLoop: undefined, ...over }) };
}

const CART_QUESTION = { id: "cart", question: "what does the cart page show?", routes: ["/cart"] };

test("an explore request runs read-only sidekicks, returns verified findings to the same lead session and then admits the plan", async () => {
  const r = rig();
  r.agentBrowser.readsOf = (id) => (id === "run-1-explore-profile" ? ["/profile"] : []);
  const x = exploring(
    r,
    [CART_QUESTION, { id: "profile", question: "is there a profile page?" }],
    {
      cart: { id: "cart", status: "answered", findings: [finding("page", "/cart", "the cart lists a checkout button"), finding("page", "/admin", "an admin page exists")] },
      profile: { id: "profile", status: "answered", findings: [finding("page", "/profile", "the profile page opens")] },
    },
  );
  const outcome = await new LeadSidekicks(r.deps).coordinate(x.input());
  assert.equal(outcome.action, "fanout", "the plan the lead gave after the exploration is admitted");
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.deepEqual(x.opened.map((o) => o.brief.delegationId).sort(), ["run-1-explore-cart", "run-1-explore-profile"]);
  assert.ok(x.opened.every((o) => o.opts.kind === "explore" && o.opts.cwd === "/m"), "explore sessions work in the run's working copy, not in a workspace of their own");
  assert.equal(x.askedForPlan.length, 1, "the same lead session is asked once");
  const told = x.askedForPlan[0]!;
  assert.match(told, /\[verified by the orchestrator\][^\n]*the cart lists a checkout button/);
  assert.match(told, /\[CLAIM, not verified\][^\n]*an admin page exists/);
  assert.match(told, /\[verified by the orchestrator\][^\n]*the profile page opens/, "a page the sidekick's own browser showed is verified");
  assert.deepEqual(r.shares.filter(([id]) => id.includes("-explore-")).map(([id]) => id).sort(), ["run-1-explore-cart", "run-1-explore-profile"]);
  assert.deepEqual(x.graphShares.map(([id]) => id).sort(), ["run-1-explore-cart", "run-1-explore-profile"]);
  const spent = r.shares.filter(([id]) => id.includes("-explore-")).reduce((sum, [, calls]) => sum + calls, 0);
  assert.ok(spent <= r.agentBrowser.limits.maxCalls / 2, "exploration leaves most of the run's browser calls to the authors");
  const explores = r.events.filter((e) => e.sidekickKind === "explore" && e.kind === "delegation");
  assert.equal(explores.length, 2, "each explore session is counted in the telemetry");
});

test("a run cancelled during exploration asks the lead nothing more and starts no author", async () => {
  const r = rig();
  const controller = new AbortController();
  const x = exploring(r, [CART_QUESTION], { cart: { id: "cart", status: "answered", findings: [] } });
  const open = r.deps.sidekick.open;
  r.deps.sidekick.open = async (brief, opts) => { if (opts.kind === "explore") controller.abort(); return open(brief, opts); };
  const outcome = await new LeadSidekicks(r.deps).coordinate(x.input({ signal: controller.signal }));
  assert.equal(x.askedForPlan.length, 0, "no turn is spent on a cancelled run");
  assert.equal(outcome.action, "refused");
  assert.equal(r.sessionsOpened, 0);
  assert.equal(x.disposedLead(), 1);
});

test("a second explore request is not admitted: the plan is refused with the reason and no author is started", async () => {
  const r = rig();
  const x = exploring(r, [CART_QUESTION], { cart: { id: "cart", status: "answered", findings: [] } }, { explore: [CART_QUESTION] });
  const outcome = await new LeadSidekicks(r.deps).coordinate(x.input());
  assert.equal(outcome.action === "refused" ? outcome.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.MALFORMED}`);
  assert.equal(x.opened.length, 1, "one round only");
  assert.equal(r.sessionsOpened, 0);
  assert.equal(x.disposedLead(), 1, "the lead's session is closed");
});

test("a request that is not admitted runs no explorer and is refused as malformed", async () => {
  const r = rig();
  const x = exploring(r, Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, question: "what?" })), {});
  const outcome = await new LeadSidekicks(r.deps).coordinate(x.input());
  assert.equal(outcome.action === "refused" ? outcome.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.MALFORMED}`);
  assert.equal(x.opened.length, 0);
  assert.equal(x.askedForPlan.length, 0);
});

test("explore sidekicks never receive a writable path, a run_spec loop or a workspace of their own", async () => {
  const r = rig();
  const x = exploring(r, [CART_QUESTION], { cart: { id: "cart", status: "answered", findings: [] } });
  const outcome = await new LeadSidekicks(r.deps).coordinate(x.input({ closedLoop: r.closedLoop }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const explore = x.opened[0]!;
  assert.deepEqual(explore.brief.scope.writablePaths, []);
  assert.ok(!r.created.some((id) => id.includes("-explore-")), "no delegation workspace was made for it");
  assert.ok(!r.flowLoops.some((l) => l.input.delegationId.includes("-explore-")), "no run_spec loop was opened for it");
  assert.equal(explore.opts.denyTools, undefined);
  assert.ok(!sidekickKindSpec(SIDEKICK_KIND.EXPLORE).tools.some((tool) => tool === AGENT_TOOL.WRITE || tool === AGENT_TOOL.RUN_SPEC));
});

test("a plan answered directly runs exactly as before: no explorer, no extra ask, no exploration time", async () => {
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { closedLoop: undefined }));
  assert.equal(outcome.action, "fanout");
  assert.ok(r.executed.every((e) => e.opts.kind === "author"));
  assert.equal(r.events.filter((e) => e.sidekickKind === "explore").length, 0);
});

test("an exploration that has no time left is not run, and the lead is told so and must plan", async () => {
  const r = rig();
  const x = exploring(r, [CART_QUESTION], {});
  let calls = 0;
  const deadline = { remainingMs: () => (calls++ === 0 ? 3_600_000 : 140_000) };
  await new LeadSidekicks(r.deps).coordinate(x.input({ deadline }));
  assert.equal(x.opened.length, 0);
  assert.match(x.askedForPlan[0]!, /No exploration ran: too little of the run is left to explore/);
});


/* A lead that answers the plan turn with `first`, and each later plan turn with the next of `again`; it records the text of every plan turn it was asked. */
function leadReplanning(first: Record<string, unknown>, again: Array<Record<string, unknown> | undefined>): { plan: CoordinateInput["plan"]; replans: string[]; reviews: string[] } {
  const replans: string[] = [];
  const reviews: string[] = [];
  return {
    replans,
    reviews,
    plan: async () => ({
      plan: first,
      parsed: true,
      timedOut: false,
      lead: {
        askForPlan: async (text: string) => {
          replans.push(text);
          const plan = again[Math.min(replans.length - 1, again.length - 1)];
          return { parsed: plan !== undefined, timedOut: false, ...(plan ? { plan } : {}) };
        },
        ask: async (text: string) => { reviews.push(text); return { output: ACCEPT_ALL, timedOut: false }; },
        dispose: async () => {},
      },
    }),
  };
}

const planOf = (flows: unknown[], dropped?: unknown[]): Record<string, unknown> => ({ kind: "fanout", flows, ...(dropped ? { dropped } : {}) });
const cartFlow = { id: "cart", objective: "the cart total", routes: ["/cart"] };
const loginFlow = { id: "login", objective: "sign in works", routes: ["/login"] };

test("a plan that answers for every direct candidate is admitted with no second plan turn", async () => {
  const r = rig();
  const lead = leadReplanning(planOf([{ ...cartFlow, candidates: ["uc-/cart"] }, { ...loginFlow, routes: [], candidates: ["uc-/login"] }]), [undefined]);
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/cart", "/login"]), plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(lead.replans.length, 0);
  assert.deepEqual(r.plans[0]!.candidates.map((c) => c.state), ["planned", "planned"]);
});

test("a plan that leaves one direct candidate unmentioned asks the lead once more with that id, and the second plan that covers it is admitted", async () => {
  const r = rig();
  const lead = leadReplanning(planOf([cartFlow]), [planOf([cartFlow, loginFlow])]);
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/cart", "/login"]), plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(lead.replans.length, 1);
  assert.ok(lead.replans[0]!.includes("uc-/login") && !lead.replans[0]!.includes("uc-/cart"));
  assert.deepEqual(r.plans.at(-1)!.flows.map((f) => f.id), ["cart", "login"]);
  assert.deepEqual(r.plans.at(-1)!.candidates.map((c) => [c.id, c.state]), [["uc-/cart", "planned"], ["uc-/login", "planned"]]);
  assert.equal(r.events.filter((e) => /unplanned/.test(e.reason ?? "")).length, 0);
});

test("a candidate dropped with a basis and a reason is admitted and kept as dropped; a drop without a reason, or without a basis, is unresolved", async () => {
  const withReason = rig();
  const dropping = leadReplanning(planOf([cartFlow], [{ candidate: "uc-/login", basis: "no-observable-change", reason: "only a log line changed" }]), [undefined]);
  const done = await withReason.coordinator.coordinate(input(withReason, { candidates: pageCandidates(["/cart", "/login"]), plan: dropping.plan }));
  if (done.action === "fanout") await done.pass?.release();
  assert.equal(dropping.replans.length, 0);
  assert.deepEqual(withReason.plans[0]!.candidates.map((c) => [c.id, c.state, c.reason]), [["uc-/cart", "planned", undefined], ["uc-/login", "dropped", "no-observable-change: only a log line changed"]]);

  const unbased = rig();
  const loose = leadReplanning(planOf([cartFlow], [{ candidate: "uc-/login", reason: "only a stylesheet changed" }]), [undefined]);
  const third = await unbased.coordinator.coordinate(input(unbased, { candidates: pageCandidates(["/cart", "/login"]), plan: loose.plan }));
  if (third.action === "fanout") await third.pass?.release();
  assert.equal(loose.replans.length, 1, "a reason with no basis the contract names is asked again");

  const without = rig();
  const silent = leadReplanning(planOf([cartFlow], [{ candidate: "uc-/login", basis: "no-observable-change", reason: "" }]), [undefined]);
  const second = await without.coordinator.coordinate(input(without, { candidates: pageCandidates(["/cart", "/login"]), plan: silent.plan }));
  if (second.action === "fanout") await second.pass?.release();
  assert.equal(silent.replans.length, 1);
});

test("after the second plan still leaves a candidate unresolved, the plan is admitted, the candidate is recorded unplanned, the lead is not asked again and every review turn names it", async () => {
  const r = rig();
  const lead = leadReplanning(planOf([cartFlow]), [planOf([cartFlow])]);
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/cart", "/login"]), plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(outcome.action, "fanout");
  assert.equal(lead.replans.length, 1);
  assert.deepEqual(r.plans.at(-1)!.candidates.map((c) => [c.id, c.state]), [["uc-/cart", "planned"], ["uc-/login", "unplanned"]]);
  assert.equal(r.events.filter((e) => /unplanned/.test(e.reason ?? "")).length, 1);
  assert.ok(lead.reviews.length > 0 && lead.reviews.every((text) => text.includes("uc-/login")));
});

test("a second answer that is not a plan of flows leaves the first plan standing", async () => {
  const r = rig();
  const lead = leadReplanning(planOf([cartFlow]), [{ kind: "noop", reason: "nothing to test" }]);
  const outcome = await r.coordinator.coordinate(input(r, { candidates: pageCandidates(["/cart", "/login"]), plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(outcome.action, "fanout");
  assert.deepEqual(r.plans.at(-1)!.flows.map((f) => f.id), ["cart"]);
  assert.equal(r.plans.at(-1)!.candidates.find((c) => c.id === "uc-/login")?.state, "unplanned");
});

test("indirect and backend-only candidates never trigger a second plan turn", async () => {
  const r = rig();
  const lead = leadReplanning(planOf([cartFlow]), [undefined]);
  const candidates = [pageCandidate("/cart"), pageCandidate("/deep", ["x"], { tier: "indirect" }), pageCandidate("/api/x", ["x"], { entry: { kind: "operation", repo: "org/api", verb: "GET", path: "/api/x" }, reachability: "backend-only" })];
  const outcome = await r.coordinator.coordinate(input(r, { candidates, plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(lead.replans.length, 0);
});

test("a plan against a run with no candidates is admitted untouched and records none", async () => {
  const r = rig();
  const lead = leadReplanning(planOf([cartFlow]), [undefined]);
  const outcome = await r.coordinator.coordinate(input(r, { plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(lead.replans.length, 0);
  assert.deepEqual(r.plans[0]!.candidates, []);
});

test("a flow's brief carries the use cases it cites with the changed code, and the plan snapshot keeps what its sidekick claimed beside the flow's outcome", async () => {
  const r = rig({ answers: { cart: [{ candidates: [{ id: "uc-/cart", status: "covered", spec: "the total" }] } as Partial<DelegationResult>] } });
  const diff = ["diff --git a/src/cart.ts b/src/cart.ts", "--- a/src/cart.ts", "+++ b/src/cart.ts", "@@ -3,2 +3,3 @@", " keep", "+const total = 1;", " keep"].join("\n");
  const candidates = [pageCandidate("/cart", ["src/cart.ts::total", "page /cart"], { seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 9 } }] }), pageCandidate("/login")];
  const plan = planOf([{ ...cartFlow, candidates: ["uc-/cart"] }, { ...loginFlow, routes: [] }]);
  const outcome = await r.coordinator.coordinate(input(r, { candidates, change: { diffs: [diff], subject: "feat(cart): total" }, plan: async () => ({ plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const brief = (flow: string) => r.executed.find((e) => e.brief.delegationId === `run-1-flow-${flow}`)!.brief;
  assert.deepEqual(brief("cart").candidates?.map((c) => c.id), ["uc-/cart"]);
  assert.ok(brief("cart").change?.hunks[0]?.text.includes("+const total = 1;"));
  assert.equal(brief("login").candidates, undefined, "a flow that cites and visits no use case carries none");
  const cartFlowSnapshot = r.plans.at(-1)!.flows.find((f) => f.id === "cart")!;
  assert.deepEqual(cartFlowSnapshot.candidates, [{ id: "uc-/cart", claimed: "covered" }]);
  assert.equal(cartFlowSnapshot.outcome?.kind, "delivered");
});

test("the change's decision listing reaches the planning turn and the brief of the flow whose hunk holds the decision", async () => {
  const r = rig();
  const diff = ["diff --git a/src/cart.ts b/src/cart.ts", "--- a/src/cart.ts", "+++ b/src/cart.ts", "@@ -3,2 +3,3 @@", " keep", "+const total = n > 0 ? n : 0;", " keep"].join("\n");
  const decisions = [{ file: "src/cart.ts", line: 4, kind: "conditional" as const, arms: [{ label: "true", line: 4 }, { label: "false", line: 4 }] }];
  const candidates = [pageCandidate("/cart", ["src/cart.ts::total", "page /cart"], { seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 9 } }] })];
  const seen: PlanningLimits[] = [];
  const plan = planOf([{ ...cartFlow, candidates: ["uc-/cart"] }]);
  const outcome = await r.coordinator.coordinate(input(r, { candidates, change: { diffs: [diff], decisions }, plan: async (p) => (seen.push(p), { plan, parsed: true, timedOut: false }) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.deepEqual(seen[0]!.decisions, decisions);
  const brief = r.executed.find((e) => e.brief.delegationId === "run-1-flow-cart")!.brief;
  assert.deepEqual(brief.change?.decisions, decisions);
});

test("a flow's briefs carry no candidates when the run derived none", async () => {
  const r = rig();
  await r.coordinator.coordinate(input(r));
  assert.ok(r.executed.every((e) => !("candidates" in e.brief)));
});

test("a plan that cannot be admitted goes back to the lead once with the reason; an admissible answer is planned, another is refused with the first reason", async () => {
  const leadAnswering = (second: Record<string, unknown>) => {
    const asked: string[] = [];
    const lead = {
      ask: async () => ({ output: "", timedOut: false }),
      askForPlan: async (text: string) => { asked.push(text); return { ...second, parsed: true, timedOut: false }; },
      dispose: async () => {},
    };
    return { asked, plan: async (): Promise<PlanOutput> => ({ plan: { kind: "fanout", flows: [] }, parsed: true, timedOut: false, lead }) };
  };

  const fixed = leadAnswering({ plan: FANOUT_PLAN });
  const r = rig();
  const planned = await r.coordinator.coordinate(input(r, { plan: fixed.plan }));
  assert.equal(planned.action, "fanout");
  if (planned.action === "fanout") await planned.pass?.release();
  assert.equal(fixed.asked.length, 1);
  assert.ok(fixed.asked[0]!.includes(PLAN_DOWNGRADE.EMPTY), "the lead is told why its plan was not admitted");

  const declined = leadAnswering({ noopReason: "the suite already proves it" });
  const noop = await rig().coordinator.coordinate(input(rig(), { plan: declined.plan }));
  assert.deepEqual([noop.action, noop.action === "noop" ? noop.reason : ""], ["noop", "the suite already proves it"]);

  const again = leadAnswering({ plan: { kind: "lead" } });
  const r3 = rig();
  const refused = await r3.coordinator.coordinate(input(r3, { plan: again.plan }));
  assert.equal(refused.action === "refused" ? refused.refusal : undefined, `${AUTHORING_REFUSAL.PLAN_REJECTED}:${PLAN_DOWNGRADE.EMPTY}`);
  assert.equal(again.asked.length, 1, "once, never twice");
});

const NO_ORDERS = JSON.stringify({ corrections: [] });
const OLD_SPEC_ID = "maint-flows-old";
const oldSpecRig = (extra: Partial<Script> = {}): Rig => rig({ hasFile: new Set(["cart", "login", OLD_SPEC_ID]), ...extra });
const opened = (r: Rig, id: string) => r.executed.filter((e) => !e.asked && e.brief.delegationId === `run-1-flow-${id}`);

test("findings that name a spec no flow of the plan authored open one maintenance flow for it, whose sidekick may write that spec and no other", async () => {
  const lead = leadAnswering([ACCEPT_ALL, NO_ORDERS]);
  const r = oldSpecRig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const findings = [
    { text: "the static gate refused the spec: e2e/flows/old.spec.ts(3,1): error TS2304: Cannot find name 'row'." },
    { text: "test \"old total\" in flows/old.spec.ts failed: expected 3 received 0", spec: "flows/old.spec.ts" },
    { text: "a loose finding that names no spec" },
  ];
  const corrected = await outcome.pass!.correct(findings, CORRECTION_ORIGIN.STATIC_GATE);
  const sessions = opened(r, OLD_SPEC_ID);
  assert.equal(sessions.length, 1, "one maintenance flow for both findings");
  const brief = sessions[0]!.brief;
  assert.deepEqual(brief.scope.writablePaths, ["e2e/flows/old.spec.ts"]);
  assert.match(brief.task, /Cannot find name 'row'/);
  assert.match(brief.task, /expected 3 received 0/);
  assert.doesNotMatch(brief.task, /a loose finding/);
  assert.deepEqual(corrected.specs, ["flows/old.spec.ts"], "what it delivers joins the round");
  assert.deepEqual(corrected.unrouted, [2], "a finding that names no spec stays unrouted");
  assert.equal(outcome.pass!.tally().maintained, 1);
  assert.equal(outcome.pass!.tally().unrouted, 1);
  assert.ok(r.events.some((e) => /maintenance flow/.test(e.reason ?? "")), "it is on the record");
  await outcome.pass!.release();
  assert.ok(r.disposed.includes(`/w/run-1-flow-${OLD_SPEC_ID}`), "its workspace is removed with the pass");
  assert.equal(r.sessionsDisposed.length, 3);
});

test("a maintenance flow gets its own run_spec loop on the spec, and a later finding on that spec goes to it through the lead", async () => {
  const lead = leadAnswering([ACCEPT_ALL, NO_ORDERS, JSON.stringify({ corrections: [{ flow: OLD_SPEC_ID, action: "revise", instruction: "wait for the table" }] })]);
  const r = oldSpecRig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  await outcome.pass!.correct([{ text: "flows/old.spec.ts never asserts the total", spec: "e2e/flows/old.spec.ts" }]);
  const loop = r.flowLoops.at(-1)!;
  assert.equal(loop.input.specFile, "flows/old.spec.ts");
  assert.equal(loop.input.limits.maxCalls, 8, "what a plan flow's eight minutes run at a minute a call");
  await outcome.pass!.correct([{ text: "flows/old.spec.ts still fails", spec: "e2e/flows/old.spec.ts" }]);
  assert.equal(opened(r, OLD_SPEC_ID).length, 1, "never a second maintenance flow for the same spec");
  assert.ok(r.executed.some((e) => e.asked && e.brief.delegationId === `run-1-flow-${OLD_SPEC_ID}`), "the same sidekick is asked");
  await outcome.pass!.release();
  assert.equal(r.flowLoops.at(-1)!.closed, 1);
});

test("a maintenance flow's brief carries the Live DOM of the pages the candidates that list the spec visit", async () => {
  const lead = leadAnswering([ACCEPT_ALL, NO_ORDERS]);
  const r = oldSpecRig();
  const contextPack = [`### ${PACK_HEADINGS.liveDom}`, "route /old:", "  button \"Export\"", "route /login:", "  textbox \"Email\""].join("\n");
  const candidates = [pageCandidate("/old", undefined, { existingSpecs: ["e2e/flows/old.spec.ts"] })];
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, candidates, contextPack, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  await outcome.pass!.correct([{ text: "flows/old.spec.ts fails", spec: "flows/old.spec.ts" }]);
  const brief = opened(r, OLD_SPEC_ID)[0]!.brief;
  assert.ok(brief.pages?.includes("button \"Export\""));
  assert.ok(!brief.pages?.includes("Email"));
  await outcome.pass!.release();
});

test("a finding whose spec is outside the spec directory or is not a spec is never given a maintenance flow", async () => {
  const lead = leadAnswering([ACCEPT_ALL, NO_ORDERS]);
  const r = oldSpecRig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([
    { text: "climbs", spec: "../outside.spec.ts" },
    { text: "absolute", spec: "/etc/x.spec.ts" },
    { text: "auth", spec: "auth.setup.ts" },
    { text: "probe", spec: "e2e/.qa-probe/p.spec.ts" },
  ]);
  assert.deepEqual(corrected.unrouted, [0, 1, 2, 3]);
  assert.equal(r.executed.filter((e) => !e.asked).length, 2, "only the plan's two sessions");
  await outcome.pass!.release();
});

test("with no room under the run's flow cap, or too little time, unowned spec findings stay unrouted with the reason on the record", async () => {
  const capped = oldSpecRig();
  const lead = leadAnswering([ACCEPT_ALL, NO_ORDERS]);
  const settings = { ...DEFAULT_COORDINATION_SETTINGS, maxFlows: 2 };
  const outcome = await new LeadSidekicks(capped.deps).coordinate(input(capped, { plan: lead.plan, closedLoop: undefined, settings }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([{ text: "flows/old.spec.ts fails", spec: "flows/old.spec.ts" }]);
  assert.deepEqual(corrected.unrouted, [0]);
  assert.equal(opened(capped, OLD_SPEC_ID).length, 0);
  assert.ok(capped.events.some((e) => /maxFlows/.test(e.reason ?? "")), "the reason is recorded");
  assert.equal(outcome.pass!.tally().maintained, undefined);
  await outcome.pass!.release();
});

test("a maintenance flow that delivers nothing leaves its findings unrouted", async () => {
  const lead = leadAnswering([ACCEPT_ALL, NO_ORDERS]);
  const r = rig({ answers: { [OLD_SPEC_ID]: [{ status: "failed", summary: "x", filesChanged: [] }] } });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([{ text: "flows/old.spec.ts fails", spec: "flows/old.spec.ts" }]);
  assert.deepEqual(corrected.specs, []);
  assert.deepEqual(corrected.unrouted, [0]);
  await outcome.pass!.release();
});

test("every origin still routes a finding that names a plan flow's spec to that flow, with no maintenance flow", async () => {
  for (const origin of Object.values(CORRECTION_ORIGIN)) {
    const lead = leadAnswering([ACCEPT_ALL, NO_ORDERS]);
    const r = oldSpecRig();
    const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
    if (outcome.action !== "fanout") return assert.fail("fanout expected");
    const corrected = await outcome.pass!.correct([{ text: "flows/cart.spec.ts fails" }], origin);
    assert.deepEqual([corrected.specs, corrected.unrouted], [["flows/cart.spec.ts"], []], origin);
    assert.equal(r.executed.filter((e) => !e.asked).length, 2, `${origin}: no maintenance flow`);
    await outcome.pass!.release();
  }
});

test("leaving findings unrouted by the run's request is recorded and counted", async () => {
  const lead = leadAnswering([ACCEPT_ALL]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  outcome.pass!.leaveUnrouted([{ text: "a" }, { text: "b" }], CORRECTION_ORIGIN.EXECUTION, "lead correction budget spent");
  assert.equal(outcome.pass!.tally().unrouted, 2);
  assert.ok(r.events.some((e) => /lead correction budget spent/.test(e.reason ?? "") && /left unrouted/.test(e.reason ?? "")));
  await outcome.pass!.release();
});

/* A lead whose plan cites candidates, answering its turns with these outputs in order (the last repeats) and recording what it was asked; `second` is what it answers a re-plan request with. */
function leadCiting(outputs: string[], plan: Record<string, unknown>, second?: Record<string, unknown>): { plan: CoordinateInput["plan"]; asked: string[]; replans: string[] } {
  const asked: string[] = [];
  const replans: string[] = [];
  return {
    asked,
    replans,
    plan: async () => ({
      plan,
      parsed: true,
      timedOut: false,
      lead: {
        askForPlan: async (text: string) => { replans.push(text); return { ...(second ?? {}), parsed: second !== undefined, timedOut: false }; },
        ask: async (text: string) => {
          asked.push(text);
          return { output: outputs[Math.min(asked.length - 1, outputs.length - 1)]!, timedOut: false };
        },
        dispose: async () => {},
      },
    }),
  };
}

const seededPage = (route: string, file: string, over: Partial<UseCaseCandidate> = {}): UseCaseCandidate =>
  pageCandidate(route, undefined, { seeds: [{ file, symbol: "*" }], ...over });
const CITING_PLAN = { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", candidates: ["uc-/cart"] }, { id: "login", objective: "sign in works", candidates: ["uc-/login"] }] };
const SEEDED = [seededPage("/cart", "src/cart.ts"), seededPage("/login", "src/login.ts"), seededPage("/orders", "src/orders.ts")];

test("a coverage finding about a file that seeds a use case one flow covers goes to that flow without the lead placing it, and the lead sees every flow with its use cases", async () => {
  const lead = leadCiting([ACCEPT_ALL, NO_ORDERS], CITING_PLAN);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, candidates: SEEDED }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([{ text: "changed lines of src/cart.ts: 4-9 are not exercised", file: "src/cart.ts" }], CORRECTION_ORIGIN.COVERAGE);
  await outcome.pass!.release();
  assert.deepEqual([corrected.specs, corrected.unrouted], [["flows/cart.spec.ts"], []]);
  const asked = r.executed.find((e) => e.asked && e.brief.delegationId === "run-1-flow-cart")!;
  assert.match(asked.opts.feedback!, /src\/cart\.ts/);
  assert.equal(r.executed.some((e) => e.asked && e.brief.delegationId === "run-1-flow-login"), false);
});

test("a coverage turn with findings to place lists every flow with its use cases for the lead", async () => {
  const lead = leadCiting([ACCEPT_ALL, NO_ORDERS], CITING_PLAN);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, candidates: SEEDED }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  await outcome.pass!.correct([{ text: "a gap with no file" }], CORRECTION_ORIGIN.COVERAGE);
  await outcome.pass!.release();
  assert.ok(lead.asked[1]!.includes("uc-/cart") && lead.asked[1]!.includes("uc-/login"));
});

test("a coverage finding about a file that seeds a use case the plan did not cover opens one flow for that use case, writing its own spec; a file that seeds none stays unrouted with that reason", async () => {
  const lead = leadCiting([ACCEPT_ALL, NO_ORDERS], CITING_PLAN);
  const r = rig({ hasFile: new Set(["cart", "login", "cand-orders"]) });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, candidates: SEEDED }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([
    { text: "changed lines of src/orders.ts: 2-5 are not exercised", file: "src/orders.ts" },
    { text: "decision arm on a changed line that NO test ran: src/orders.ts:9 if: else", file: "src/orders.ts", line: 9 },
    { text: "changed lines of src/stray.ts: 1-3 are not exercised", file: "src/stray.ts" },
  ], CORRECTION_ORIGIN.COVERAGE);
  const sessions = opened(r, "cand-orders");
  assert.equal(sessions.length, 1, "one flow for both findings of the use case");
  const brief = sessions[0]!.brief;
  assert.deepEqual(brief.scope.writablePaths, ["e2e/flows/cand-orders.spec.ts"]);
  assert.match(brief.task, /src\/orders\.ts:9/);
  assert.match(brief.task, /Write the Playwright E2E spec/);
  assert.doesNotMatch(brief.task, /src\/stray\.ts/);
  assert.deepEqual(corrected.specs, ["flows/cand-orders.spec.ts"]);
  assert.deepEqual(corrected.unrouted, [2]);
  assert.ok(r.events.some((e) => /seeds no use case/.test(e.reason ?? "")), "the reason is on the record");
  assert.equal(outcome.pass!.tally().maintained, 1);
  await outcome.pass!.release();
});

test("a flow opened for a use case is held to the run's flow cap, and a second finding on its file is not given a second flow", async () => {
  const capped = rig({ hasFile: new Set(["cart", "login", "cand-orders"]) });
  const settings = { ...DEFAULT_COORDINATION_SETTINGS, maxFlows: 2 };
  const lead = leadCiting([ACCEPT_ALL, NO_ORDERS], CITING_PLAN);
  const outcome = await new LeadSidekicks(capped.deps).coordinate(input(capped, { plan: lead.plan, closedLoop: undefined, candidates: SEEDED, settings }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  const corrected = await outcome.pass!.correct([{ text: "src/orders.ts not exercised", file: "src/orders.ts" }], CORRECTION_ORIGIN.COVERAGE);
  assert.deepEqual(corrected.unrouted, [0]);
  assert.equal(opened(capped, "cand-orders").length, 0);
  assert.ok(capped.events.some((e) => /maxFlows/.test(e.reason ?? "")));
  await outcome.pass!.release();

  const r = rig({ hasFile: new Set(["cart", "login", "cand-orders"]) });
  const again = leadCiting([ACCEPT_ALL, NO_ORDERS], CITING_PLAN);
  const second = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: again.plan, closedLoop: undefined, candidates: SEEDED }));
  if (second.action !== "fanout") return assert.fail("fanout expected");
  await second.pass!.correct([{ text: "src/orders.ts not exercised", file: "src/orders.ts" }], CORRECTION_ORIGIN.COVERAGE);
  await second.pass!.correct([{ text: "src/orders.ts still not exercised", file: "src/orders.ts" }], CORRECTION_ORIGIN.COVERAGE);
  assert.equal(opened(r, "cand-orders").length, 1);
  await second.pass!.release();
});

const DROP_EVERYTHING = { kind: "fanout", flows: [], dropped: [{ candidate: "uc-/cart", basis: "no-observable-change", reason: "only a stylesheet changed" }] };
const SECOND_PLAN = { plan: { kind: "fanout", flows: [{ id: "cart", objective: "the cart total", candidates: ["uc-/cart"] }] } };

test("a plan that drops every use case as unchanged is refused when the candidate's changed code is executable, asked once more, and then run on the plan the lead gives", async () => {
  const lead = leadCiting([ACCEPT_ALL], DROP_EVERYTHING, SECOND_PLAN);
  const r = rig({ hasFile: new Set(["cart"]) });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, candidates: [SEEDED[0]!] }));
  assert.equal(outcome.action, "fanout", "the cosmetic claim did not end the run");
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(lead.replans.length, 1);
  assert.ok(lead.replans[0]!.includes("src/cart.ts"), "the lead is told which fact contradicts its drop");
});

test("a plan whose drops stay contradicted after the one more asking is the lead's no-op, recorded with the fact, never an infra error", async () => {
  const stubborn = leadCiting([ACCEPT_ALL], DROP_EVERYTHING, { plan: DROP_EVERYTHING });
  const r = rig();
  const kept = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: stubborn.plan, closedLoop: undefined, candidates: [SEEDED[0]!] }));
  assert.equal(kept.action, "noop");
  assert.equal(stubborn.replans.length, 1, "once, never twice");
  const contradicted = kept.signal.dropsContradicted;
  assert.deepEqual(contradicted?.map((c) => [c.candidate, c.basis]), [["uc-/cart", "no-observable-change"]]);
  assert.ok(contradicted?.[0]?.why.includes("src/cart.ts"));
  assert.ok(r.events.some((e) => /contradict/.test(e.reason ?? "") && /uc-\/cart/.test(e.reason ?? "")), "a coordination event says it");
  const dropped = r.plans.at(-1)?.candidates.find((c) => c.id === "uc-/cart");
  assert.equal(dropped?.state, "dropped");
  assert.equal(dropped?.contradicted?.basis, "no-observable-change");

  const style = seededPage("/cart", "src/cart.css");
  const allowed = leadCiting([ACCEPT_ALL], DROP_EVERYTHING);
  const noop = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: allowed.plan, closedLoop: undefined, candidates: [style] }));
  assert.equal(noop.action, "noop");
  assert.equal(noop.signal.dropsContradicted, undefined, "a drop the facts allow records no contradiction");
  assert.equal(allowed.replans.length, 0);
});

test("a drop of a use case whose pages made requests while the run captured them is refused with the request named, and the lead's persistence is honored and recorded", async () => {
  const requested = "GET https://maps.example/styles/v1/owner/theme-a";
  const pack = [`### ${PACK_HEADINGS.liveDom}`, "route /cart:", "  heading: Cart", "", `### ${PACK_HEADINGS.requests} (data requests)`, `- /cart: ${requested}`].join("\n");
  const style = seededPage("/cart", "src/cart.css");

  const stubborn = leadCiting([ACCEPT_ALL], DROP_EVERYTHING, { plan: DROP_EVERYTHING });
  const r = rig();
  const kept = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: stubborn.plan, closedLoop: undefined, candidates: [style], contextPack: pack }));
  assert.equal(kept.action, "noop");
  assert.equal(stubborn.replans.length, 1, "the lead was asked once more");
  assert.ok(stubborn.replans[0]!.includes(requested), "the lead is shown the request that contradicts its drop");
  assert.ok(kept.signal.dropsContradicted?.[0]?.why.includes(requested), "the contradiction on the record names it");

  const quiet = rig();
  const unasked = leadCiting([ACCEPT_ALL], DROP_EVERYTHING);
  const noop = await new LeadSidekicks(quiet.deps).coordinate(input(quiet, { plan: unasked.plan, closedLoop: undefined, candidates: [style], contextPack: `### ${PACK_HEADINGS.liveDom}\nroute /cart:\n  heading: Cart` }));
  assert.equal(noop.action, "noop");
  assert.equal(unasked.replans.length, 0, "a pack that recorded no request on its pages holds the drop to nothing more");
});

test("the explicit no-op shape is held to the same facts: asked once with the fact, then honored and recorded", async () => {
  const asked: string[] = [];
  const plan: CoordinateInput["plan"] = async () => ({
    noopReason: "a refactor, nothing observable",
    parsed: true,
    timedOut: false,
    lead: { askForPlan: async (text: string) => { asked.push(text); return { noopReason: "still a refactor", parsed: true, timedOut: false }; }, ask: async () => ({ output: "", timedOut: false }), dispose: async () => {} },
  });
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan, closedLoop: undefined, candidates: [SEEDED[0]!] }));
  assert.equal(outcome.action, "noop");
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.includes("src/cart.ts"), "the lead is shown the contradicting fact");
  assert.deepEqual(outcome.signal.dropsContradicted?.map((c) => c.candidate), ["uc-/cart"]);

  const style = rig();
  const plain = await new LeadSidekicks(style.deps).coordinate(input(style, { plan: async () => ({ noopReason: "docs only", parsed: true, timedOut: false }), candidates: [seededPage("/cart", "src/cart.css")] }));
  assert.equal(plain.action, "noop");
  assert.equal(plain.signal.dropsContradicted, undefined);
});

test("a fan-out whose drop the facts contradict keeps its flows when the lead persists, and records the contradiction", async () => {
  const mixed = { kind: "fanout", flows: [{ id: "login", objective: "sign in works", candidates: ["uc-/login"] }], dropped: [{ candidate: "uc-/cart", basis: "no-observable-change", reason: "a type-only edit" }] };
  const lead = leadCiting([ACCEPT_ALL], mixed, { plan: mixed });
  const r = rig({ hasFile: new Set(["login"]) });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, candidates: [SEEDED[0]!, SEEDED[1]!] }));
  assert.equal(outcome.action, "fanout");
  assert.equal(lead.replans.length, 1);
  assert.deepEqual(outcome.signal.dropsContradicted?.map((c) => c.candidate), ["uc-/cart"]);
  assert.ok(!r.events.some((e) => /neither covered nor dropped/.test(e.reason ?? "")), "it is a kept drop, not an unplanned use case");
  assert.ok(r.events.some((e) => e.dropContradicted === true && e.dropBases?.includes("no-observable-change")), "the kept drop's basis and contradiction are attributes of its event");
  if (outcome.action === "fanout") await outcome.pass?.release();
});

test("a flow's turn event names the flow, and a review decision names the flow, the decision and whether the orchestrator took it as given", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "try the cart page" }, { flow: "login", action: "revise" }], []]);
  const r = rig({ answers: { cart: [{ status: "failed", summary: "x", filesChanged: [] }] }, hasFile: new Set(["login"]) });
  await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  const turn = r.events.find((e) => e.kind === "delegation" && e.flowId === "cart");
  assert.ok(turn, "the turn event carries the flow id as an attribute");
  const taken = r.events.find((e) => e.kind === "lead-decision" && e.flowId === "cart" && e.decision === "revise");
  assert.equal(taken?.overridden, false);
  assert.equal(taken?.overrideReason, undefined);
  const refused = r.events.find((e) => e.kind === "lead-decision" && e.flowId === "login" && e.decision === "revise");
  assert.equal(refused?.overridden, true);
  assert.equal(refused?.overrideReason, "needs-instruction");
});

test("a correction turn summarises how its findings were routed: by the spec they name, by the lead's order, and not at all", async () => {
  const order = JSON.stringify({ corrections: [{ flow: "cart", action: "revise", findings: [2], instruction: "cover the arm" }] });
  const lead = leadAnswering([ACCEPT_ALL, order]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  await outcome.pass!.correct([{ text: "the total is never asserted", spec: "e2e/flows/cart.spec.ts" }, { text: "decision arm src/a.ts:4 if: the else" }, { text: "decision arm src/a.ts:9 ?: nothing is asked of it", file: "src/a.ts" }], CORRECTION_ORIGIN.COVERAGE);
  await outcome.pass!.release();
  const summary = r.events.find((e) => e.origin === CORRECTION_ORIGIN.COVERAGE && e.routes !== undefined);
  assert.equal(summary?.findings, 3);
  assert.deepEqual(summary?.routes, { spec: 1, candidate: 0, lead: 1, candidateFlow: 0, unrouted: 1 });
  assert.deepEqual(summary?.unroutedReasons, ["no-seed-use-case"]);
  const sent = r.events.find((e) => e.flowId === "cart" && e.decision === "revise" && e.findings === 2);
  assert.ok(sent, "the flow's order says how many findings it was sent");
  assert.ok(r.events.every((e) => !/^correction/.test(e.reason ?? "") || e.origin === CORRECTION_ORIGIN.COVERAGE), "every correction event names its origin");
});

test("findings a turn left unrouted say why as a code, and the pass's own leave-unrouted call is told apart", async () => {
  const lead = leadAnswering([ACCEPT_ALL, OUT_OF_RANGE_ORDER, OUT_OF_RANGE_ORDER]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action !== "fanout") return assert.fail("fanout expected");
  await outcome.pass!.correct(LOOSE_ARMS, CORRECTION_ORIGIN.COVERAGE);
  outcome.pass!.leaveUnrouted([{ text: "x" }], CORRECTION_ORIGIN.COVERAGE, "lead correction budget spent");
  await outcome.pass!.release();
  const summary = r.events.find((e) => e.routes !== undefined && e.origin === CORRECTION_ORIGIN.COVERAGE);
  assert.equal(summary?.routes?.unrouted, 2);
  assert.deepEqual(summary?.unroutedReasons, ["no-flow-took"]);
  assert.ok(r.events.some((e) => e.unroutedReasons?.[0] === "left-by-caller" && e.findings === 1));
});

test("a review turn hands the lead's transport the sizes and hashes of the sections it was assembled from", async () => {
  const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }]]);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.ok("flows" in (lead.turnOpts[0]!.sectionSizes ?? {}));
  assert.ok("flows" in (lead.turnOpts[0]!.sectionHashes ?? {}));
});

test("a sidekick answer the reader could not read reaches the lead as the orchestrator's statement, not as what the sidekick says", async () => {
  const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }]]);
  const r = rig({ answers: { cart: [{ status: "failed", summary: "sidekick output was not a valid DelegationResult", filesChanged: [], readMiss: "unreadable", answerMiss: "unreadable" }] } });
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const cart = lead.asked[0]!.split("### Flow").find((block) => block.includes("`cart`"))!;
  assert.doesNotMatch(cart, /Sidekick says|Sidekick concerns/);
  assert.match(cart, /Sidekick answer: the orchestrator could not read it/);
});

test("a run_spec failure is the flow's last failure only when its sha256 is that of the spec the working copy holds now", async () => {
  const lead = leadWith([[{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }]]);
  const r = rig();
  r.deps.readSpec = async (_root, file) => `// ${file}\ntest('works', async () => {});`;
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    const sha256 = flowInput.flowId === "cart" ? sha256Hex(`// flows/cart.spec.ts\ntest('works', async () => {});`) : "sha-of-earlier-bytes";
    r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256, status: "failed", devWrites: 0, failures: [{ detail: `failure of ${flowInput.flowId}` }] });
    return { ...handle, isClosed: async () => true };
  })(r.closedLoop.openFlow);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.match(lead.asked[0]!, /^Last failure: failure of cart$/m);
  assert.match(lead.asked[0]!, /Last failure \(seen on earlier bytes[^)]*\): failure of login/);
});

test("a second review turn does not send a spec again whose bytes the lead already saw, and sends the one that changed", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "Assert the total row." }, { flow: "login", action: "accept" }], [{ flow: "cart", action: "accept" }, { flow: "login", action: "accept" }]]);
  const r = rig();
  r.deps.readSpec = async (_root, file) => `// ${file} v${r.executed.filter((e) => e.asked && file.includes(e.brief.delegationId.replace(/^.*-flow-/, ""))).length}\ntest('works', async () => {});`;
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(lead.asked.length, 2);
  const [first, second] = lead.asked;
  assert.ok(first!.includes("// flows/cart.spec.ts v0") && first!.includes("// flows/login.spec.ts v0"));
  assert.ok(second!.includes("// flows/cart.spec.ts v1"), "the revised spec is sent in full");
  assert.ok(!second!.includes("// flows/login.spec.ts"), "the unchanged spec is not sent again");
  assert.match(second!, /Spec: unchanged since review turn 1 \(sha256 [0-9a-f]{12}, 2 lines\)/);
});

test("the sidekick is told its last run_spec call ended on an earlier version of its spec when the bytes it ran are not the ones the working copy holds", async () => {
  const lead = leadWith([[{ flow: "cart", action: "revise", instruction: "Fix it." }], []]);
  const r = rig({ hasFile: new Set(["login"]) });
  r.deps.readSpec = async () => "now";
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "older", status: "failed", devWrites: 0 });
    return handle;
  })(r.closedLoop.openFlow);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  const cart = r.executed.filter((e) => e.brief.delegationId === "run-1-flow-cart");
  assert.match(cart[1]!.opts.feedback ?? "", /The last run_spec call ended failed, on an earlier version of your spec\./);
});

/* A one-hunk diff of each file: `added` lines added and one removed. */
const diffOf = (files: Record<string, number>): string =>
  Object.entries(files).map(([file, added]) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +1,${added} @@`, "-old", ...Array.from({ length: added }, (_, i) => `+line ${i}`)].join("\n")).join("\n");
const ORDERS_FLOW = { id: "orders", objective: "the order list", candidates: ["uc-/orders"] };
const CITING_THREE = { kind: "fanout", flows: [...CITING_PLAN.flows, ORDERS_FLOW] };

test("the planning turn is told the run's capacity from its time and parallel flows, and the change each candidate would own", async () => {
  const r = rig();
  const seen: PlanningLimits[] = [];
  /* 63 min left, 3 for the plan: 60, a quarter kept, 45 min of 10 min flows is 4 waves of 2. */
  const settings = { ...DEFAULT_COORDINATION_SETTINGS, maxParallel: 2, flowBudgetMs: { opencode: 10 * 60_000 } };
  await r.coordinator.coordinate(input(r, { settings, deadline: { remainingMs: () => 63 * 60_000 }, candidates: SEEDED, change: { diffs: [diffOf({ "src/cart.ts": 3, "src/login.ts": 1 })] }, plan: async (p) => (seen.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(seen[0]!.capacity, 8);
  assert.deepEqual(seen[0]!.candidateSlices?.["uc-/cart"], { hunks: 1, added: 3, removed: 1 });
  assert.deepEqual(seen[0]!.candidateSlices?.["uc-/orders"], { hunks: 0, added: 0, removed: 0 });
  const ceiling: PlanningLimits[] = [];
  await rig().coordinator.coordinate(input(r, { settings: { ...settings, maxFlows: 3 }, deadline: { remainingMs: () => 63 * 60_000 }, plan: async (p) => (ceiling.push(p), { parsed: false, timedOut: true }) }));
  assert.equal(ceiling[0]!.capacity, 3, "the app's ceiling bounds it");
});

test("flows past the run's capacity, the use cases only they covered and a contradicted drop are asked of the lead in one amendment turn; what is still past it is recorded not admitted", async () => {
  const plan = { ...CITING_THREE, dropped: [{ candidate: "uc-/checkout", basis: "no-observable-change", reason: "only a stylesheet changed" }] };
  const lead = leadCiting([ACCEPT_ALL], plan, { plan });
  const r = rig({ hasFile: new Set(["cart", "login"]) });
  const settings = { ...DEFAULT_COORDINATION_SETTINGS, maxParallel: 2, maxFlows: 2 };
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { settings, plan: lead.plan, closedLoop: undefined, candidates: [...SEEDED, seededPage("/checkout", "src/checkout.ts")] }));
  if (outcome.action !== "fanout") return assert.fail(`fanout expected, got ${outcome.action}`);
  await outcome.pass?.release();
  assert.equal(lead.replans.length, 1, "one amendment turn, never one per kind of question");
  const amendment = lead.replans[0]!;
  assert.match(amendment, /orders/, "the flow past the capacity is named");
  assert.match(amendment, /uc-\/orders/, "the use case only that flow covered is unresolved");
  assert.match(amendment, /src\/checkout\.ts/, "the fact that contradicts the drop is shown");
  assert.match(amendment, /\b2\b/, "the capacity is stated");
  assert.equal(outcome.signal.capacity, 2);
  assert.deepEqual(outcome.signal.notAdmitted, ["orders"]);
  assert.deepEqual(r.plans.at(-1)!.flows.map((f) => f.id), ["cart", "login"]);
  assert.ok(r.events.some((e) => e.kind === "lead-decision" && /not admitted/.test(e.reason ?? "") && /orders/.test(e.reason ?? "")));
});

test("an admitted flow whose owned change alone does not fit an author's window is asked of the lead to split, in the same one amendment turn", async () => {
  const windows = { windowTokens: () => 1_000 };
  const room = { forRole: () => ({ growthTokensPerStep: 100, steps: 5, basis: "history" as const, samples: 3 }) };
  const lead = leadCiting([ACCEPT_ALL], CITING_PLAN, { plan: CITING_PLAN });
  const r = rig();
  const coordinator = new LeadSidekicks({ ...r.deps, contextBudget: new ContextBudget(windows, room) });
  /* 500 tokens of room leaves 500 of a 1,000-token window: 400 added lines of cart are well over 2,000 bytes. */
  const outcome = await coordinator.coordinate(input(r, { plan: lead.plan, closedLoop: undefined, candidates: SEEDED.slice(0, 2), change: { diffs: [diffOf({ "src/cart.ts": 400, "src/login.ts": 2 })] } }));
  if (outcome.action !== "fanout") return assert.fail(`fanout expected, got ${outcome.action}`);
  await outcome.pass?.release();
  assert.equal(lead.replans.length, 1);
  assert.match(lead.replans[0]!, /cart/);
  assert.doesNotMatch(lead.replans[0]!, /\blogin\b/, "a flow that fits is not asked about");
  assert.deepEqual(outcome.signal.oversize, ["cart"]);
});

test("a plan within the run's capacity, answering for every candidate, with flows that fit is admitted with no amendment turn", async () => {
  const lead = leadCiting([ACCEPT_ALL], CITING_PLAN);
  const r = rig();
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan, closedLoop: undefined, candidates: SEEDED.slice(0, 2) }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(lead.replans.length, 0);
  assert.equal(outcome.signal.notAdmitted, undefined);
  assert.equal(outcome.signal.oversize, undefined);
});

/* ── an unmet criterion DEV's state prevents ─────────────────────────────────────────────────── */

const CUISINE_PLAN = { kind: "fanout", flows: [{ id: "cart", objective: "the cuisine filter", acceptance: ["available cuisines toggle the filter"], routes: ["/search"] }] };

/* A rig whose cart flow answers through the real reader, with the facts the executor hands it, as a sidekick's closing block. */
function cuisineRig(unmet: Record<string, unknown>, reads: readonly string[]): Rig {
  const r = rig({ hasFile: new Set(["cart"]) });
  r.agentBrowser.readsOf = () => reads;
  r.deps.sidekick = {
    open: async (brief, opts) => {
      r.executed.push({ brief, opts, session: ++r.sessionsOpened });
      const closing = JSON.stringify({
        delegationId: brief.delegationId, runId: brief.runId, status: "completed-with-concerns", summary: "the spec passes; every cuisine chip is disabled on DEV",
        filesChanged: brief.scope.writablePaths.map((path) => ({ path })), concerns: [], unresolvedQuestions: [], recommendation: "review", acceptance: [unmet],
      });
      return { first: readDelegationResult(closing, brief, r.deps.redaction, opts.devStateGround?.()), ask: async () => { throw new Error("not asked"); }, dispose: async () => {} };
    },
  };
  return r;
}

const devStateUnmet = (pages: string[]) => ({ criterion: 1, status: "unmet", cause: "dev-state", pages, note: "every chip is aria-disabled" });

test("an unmet DEV's state prevents, on a page the flow's session was shown, is recorded as completed with concerns and reaches the lead as a DEV limit", async () => {
  const r = cuisineRig(devStateUnmet(["/search"]), ["/search"]);
  const lead = leadWith([[{ flow: "cart", action: "accept" }]], CUISINE_PLAN);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(r.events.find((e) => /flow cart turn 1/.test(e.reason ?? ""))?.sidekickStatus, "completed-with-concerns");
  assert.equal(outcome.action === "fanout" ? outcome.signal.delivered : -1, 1, "the spec it wrote is delivered");
  assert.match(lead.asked[0] ?? "", /DEV limits/);
  assert.match(lead.asked[0] ?? "", /available cuisines toggle the filter/);
  assert.match(lead.asked[0] ?? "", /flow's browser session was shown \/search/);
});

test("an unmet DEV's state prevents on a page the orchestrator never saw the flow read still blocks, and the lead is told no DEV limit", async () => {
  const r = cuisineRig(devStateUnmet(["/map"]), ["/search"]);
  const lead = leadWith([[{ flow: "cart", action: "accept" }]], CUISINE_PLAN);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: lead.plan }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.equal(r.events.find((e) => /flow cart turn 1/.test(e.reason ?? ""))?.sidekickStatus, "blocked");
  assert.doesNotMatch(lead.asked[0] ?? "", /DEV limits/);
});

test("the facts an unmet DEV's state prevents is held to are the flow's own: its browser reads, its run_spec empty reads and the pack's pages", async () => {
  const r = cuisineRig(devStateUnmet(["/home"]), ["/search"]);
  r.closedLoop.openFlow = ((original) => (flowInput: FlowLoopOpenInput) => {
    const handle = original(flowInput)!;
    r.flowLoops.at(-1)!.ledger.push({ path: flowInput.specFile, sha256: "bytes", status: "failed", devWrites: 0, failures: [{ path: "/home", resultCount: 0 }] });
    return handle;
  })(r.closedLoop.openFlow);
  const outcome = await new LeadSidekicks(r.deps).coordinate(input(r, { plan: leadWith([[]], CUISINE_PLAN).plan, confirmedDataRoutes: [{ path: "/search", resultCount: 4 }] }));
  if (outcome.action === "fanout") await outcome.pass?.release();
  assert.deepEqual(r.executed[0]!.opts.devStateGround?.(), { flowReads: ["/search"], emptyReads: ["/home"], dataRoutes: [{ path: "/search", resultCount: 4 }] });
  assert.equal(r.events.find((e) => /flow cart turn 1/.test(e.reason ?? ""))?.sidekickStatus, "completed-with-concerns", "its own empty read of /home backs the claim");
});
