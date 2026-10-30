/* A sidekick session is ended only when the runtime says it is gone: a fault of the transport on a revision leaves the session, its run_spec share and its proof state for the lead's next order. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COORDINATION_SETTINGS } from "@kernel/coordination.ts";
import { SessionGoneError } from "@kernel/turn-end.ts";
import { LeadSidekicks, type CoordinateInput } from "@contexts/coordination/application/lead-sidekicks.ts";
import { SidekickExecutor } from "@contexts/coordination/application/sidekick-executor.ts";
import type { TimerPort } from "@contexts/coordination/application/fan-out-dispatcher.ts";
import type { CoordinationTelemetryEvent } from "@contexts/coordination/application/coordination-telemetry.ts";
import type { DelegationWorkspacePort } from "@contexts/coordination/application/ports/delegation-workspace.port.ts";
import type { ClosedLoopHandle, FlowLedgerEntry, FlowLoopHandle } from "@contexts/agent-tools/application/index.ts";
import type { LeadTurnOpts, PlanOutput } from "@kernel/plan-output.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const timers: TimerPort = { setTimer: () => () => {} };

const FLOW = "run-1-flow-cart";
const answer = (summary: string): string =>
  JSON.stringify({ delegationId: FLOW, runId: "run-1", status: "completed", summary, filesChanged: [{ path: "e2e/flows/cart.spec.ts" }], evidence: [], acceptance: [], concerns: [], unresolvedQuestions: [] });

/* What the runtime does with each prompt of the one session the flow's sidekick holds, in order: an answer, or a fault the transport raises. */
type Turn = string | Error;

interface Run {
  outcome: Awaited<ReturnType<LeadSidekicks["coordinate"]>>;
  sessionsOpened: number;
  prompts: string[];
  sessionsDisposed: number;
  loopsOpened: number;
  loopsClosed: number;
  events: CoordinationTelemetryEvent[];
  leadPrompts: string[];
}

async function run(turns: Turn[], reviews: unknown[][]): Promise<Run> {
  const state = { opened: 0, disposed: 0, loops: 0, loopsClosed: 0, prompts: [] as string[], events: [] as CoordinationTelemetryEvent[], leadPrompts: [] as string[] };
  const ledger: FlowLedgerEntry[] = Array.from({ length: 4 }, (_, i) => ({ path: "e2e/flows/cart.spec.ts", sha256: "abc", status: i === 3 ? "passed" : "failed", devWrites: 0 }));
  const workspaces: DelegationWorkspacePort = {
    create: async (request) => ({ dir: `/w/${request.delegationId}`, specDir: `/w/${request.delegationId}/e2e`, specRelDir: "e2e", files: 1, cut: false }),
    stage: async () => true,
    collect: async (_ws, request) => ({ copied: [...request.writablePaths], refused: [], proposals: [], proposalsTotal: 0 }),
    refresh: async (_ws, request) => [...request.writablePaths],
    dispose: async () => {},
    sweepAll: async () => 0,
  };
  const sidekick = new SidekickExecutor({
    redaction,
    runtime: {
      openSession: async () => {
        state.opened += 1;
        let prompts = 0;
        return {
          prompt: async (text: string) => {
            state.prompts.push(text);
            const turn = turns[Math.min(prompts++, turns.length - 1)]!;
            if (turn instanceof Error) throw turn;
            return { output: turn };
          },
          dispose: async () => { state.disposed += 1; },
        };
      },
    },
  });
  const closedLoop: ClosedLoopHandle = {
    limits: { maxCalls: 8, perCallMs: 60_000, maxDevWrites: 12 },
    openFlow: (input) => {
      state.loops += 1;
      const handle: FlowLoopHandle = {
        limits: { maxCalls: input.limits.maxCalls, perCallMs: 60_000, maxDevWrites: input.limits.maxDevWrites },
        signals: () => ({ calls: ledger.length, devWrites: 0 }),
        runWritesLeft: () => 12,
        ledger: () => ledger,
        isClosed: async () => true,
        close: async () => { state.loopsClosed += 1; },
      };
      return handle;
    },
    sweepProbes: async () => {},
    isClosed: async () => false,
    signals: () => ({ calls: 0, devWrites: 0 }),
    close: async () => {},
  };
  let reviewTurn = 0;
  const plan = async (): Promise<PlanOutput> => ({
    plan: { kind: "fanout", flows: [{ id: "cart", objective: "the cart total" }] },
    parsed: true,
    timedOut: false,
    lead: {
      askForPlan: async () => ({ parsed: false, timedOut: false }),
      ask: async (text: string, _opts: LeadTurnOpts) => {
        state.leadPrompts.push(text);
        return { output: JSON.stringify({ review: reviews[Math.min(reviewTurn++, reviews.length - 1)] }), timedOut: false };
      },
      dispose: async () => {},
    },
  });
  const coordinator = new LeadSidekicks({
    redaction,
    sidekick,
    workspaces,
    timers,
    telemetry: { record: (event) => void state.events.push(event) },
    specFileFor: (id) => `flows/${id}.spec.ts`,
  });
  const input: CoordinateInput = {
    runId: "run-1", app: "shop", objective: "the cart", mirrorDir: "/m", specDir: "/m/e2e", specRelDir: "e2e",
    settings: DEFAULT_COORDINATION_SETTINGS, facts: { hasLogin: true }, closedLoop, plan,
  };
  const outcome = await coordinator.coordinate(input);
  const disposedBeforeRelease = state.disposed;
  const loopsClosedBeforeRelease = state.loopsClosed;
  if (outcome.action === "fanout") await outcome.pass?.release();
  return { outcome, sessionsOpened: state.opened, prompts: state.prompts, sessionsDisposed: disposedBeforeRelease, loopsOpened: state.loops, loopsClosed: loopsClosedBeforeRelease, events: state.events, leadPrompts: state.leadPrompts };
}

const transportFault = (): Error => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });

test("a revision that met a fault of the transport leaves the sidekick's session, its run_spec share and its proof for the lead's next order", async () => {
  const r = await run(
    [answer("wrote the spec"), transportFault(), answer("fixed it")],
    [[{ flow: "cart", action: "revise", instruction: "Assert the total row." }], [{ flow: "cart", action: "revise", instruction: "Assert the total row, again." }], [{ flow: "cart", action: "accept" }]],
  );
  assert.equal(r.sessionsOpened, 1, "the second revision reached the session that did the work, not a fresh sidekick");
  assert.equal(r.prompts.length, 3);
  assert.equal(r.sessionsDisposed, 0, "the fault did not end the session");
  assert.equal(r.loopsOpened, 1, "the flow kept its one run_spec loop");
  assert.equal(r.loopsClosed, 0, "its loop and the proof it holds outlived the fault");
  assert.match(r.leadPrompts.at(-1)!, /run_spec: 4 of 8 calls used/, "the lead is still shown the flow's calls");
  assert.equal(r.outcome.action === "fanout" ? r.outcome.aggregated.incompleteFlows.length : -1, 0);
});

test("a turn that did not answer is said as the flow's typed end, in the sidekick's turn event and in what the lead is shown", async () => {
  const r = await run(
    [answer("wrote the spec"), transportFault(), answer("fixed it")],
    [[{ flow: "cart", action: "revise", instruction: "Assert the total row." }], [{ flow: "cart", action: "accept" }]],
  );
  const unanswered = r.events.filter((e) => e.kind === "delegation" && e.turnEnd !== undefined);
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0]!.flowId, "cart");
  assert.equal(unanswered[0]!.turnEnd, "failed");
  assert.equal(unanswered[0]!.errorType, "transport");
  assert.match(r.leadPrompts[1]!, /did not answer/i, "the second review turn says the revision's turn ended without an answer");
});

test("a session the runtime says is gone is ended, and the lead's revision of its flow starts a fresh sidekick", async () => {
  const r = await run(
    [answer("wrote the spec"), new SessionGoneError("session ses_1 not found"), answer("from scratch")],
    [[{ flow: "cart", action: "revise", instruction: "Assert the total row." }], [{ flow: "cart", action: "revise", instruction: "Again." }], [{ flow: "cart", action: "accept" }]],
  );
  assert.equal(r.sessionsOpened, 2, "a fresh sidekick took the flow once its session was gone");
  assert.ok(r.events.some((e) => e.kind === "delegation" && e.turnEnd === "session-gone"));
});
