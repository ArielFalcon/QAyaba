/*
 * A sidekick session is ended only when the runtime says it is gone, the run is cancelled or its holder releases it: a fault of the
 * transport, a turn that runs out of the flow's time or a fault outside the turn leaves the session, its run_spec share and its proof
 * state for the lead's next order. The real executor and dispatcher run here; only the agent runtime and the clock are faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COORDINATION_SETTINGS } from "@kernel/coordination.ts";
import { SessionGoneError } from "@kernel/turn-end.ts";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import { LeadSidekicks, type CoordinateInput } from "@contexts/coordination/application/lead-sidekicks.ts";
import { SidekickExecutor } from "@contexts/coordination/application/sidekick-executor.ts";
import type { TimerPort } from "@contexts/coordination/application/fan-out-dispatcher.ts";
import type { CoordinationTelemetryEvent } from "@contexts/coordination/application/coordination-telemetry.ts";
import type { DelegationWorkspacePort } from "@contexts/coordination/application/ports/delegation-workspace.port.ts";
import type { ClosedLoopHandle, FlowLedgerEntry, FlowLoopHandle } from "@contexts/agent-tools/application/index.ts";
import type { LeadTurnOpts, PlanOutput } from "@kernel/plan-output.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const FLOW = "run-1-flow-cart";
const answer = (summary: string): string =>
  JSON.stringify({ delegationId: FLOW, runId: "run-1", status: "completed", summary, filesChanged: [{ path: "e2e/flows/cart.spec.ts" }], evidence: [], acceptance: [], concerns: [], unresolvedQuestions: [] });

/* A prompt that does not answer: it ends only when its own time runs out (the transport's timeout, which aborts it and keeps the session), when the session's signal aborts it, or when the session is deleted. */
const HANG = Symbol("hang");

/* What the runtime does with each prompt of the one session the flow's sidekick holds, in order: an answer, a fault the transport raises, or no answer. */
type Turn = string | Error | typeof HANG;

/*
 * A clock whose armed timers all fire, in the order they were armed, once a prompt hangs: the flow's slot and the prompt's own
 * timeout run out as they would in production, the slot first (it is armed when the flow's turn starts, the prompt's when it is sent).
 */
class RunningOutClock implements TimerPort {
  private readonly pending = new Set<{ fire: () => void }>();
  setTimer(_ms: number, fire: () => void): () => void {
    const timer = { fire };
    this.pending.add(timer);
    return () => void this.pending.delete(timer);
  }
  runOut(): void {
    for (const timer of [...this.pending]) {
      this.pending.delete(timer);
      timer.fire();
    }
  }
}

interface RunOpts {
  /* The taking back of these turns (1-based, across the flow's turns) fails: a fault outside the sidekick's turn. */
  collectFaults?: readonly number[];
}

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

async function run(turns: Turn[], reviews: unknown[][], opts: RunOpts = {}): Promise<Run> {
  const clock = new RunningOutClock();
  let collects = 0;
  const state = { opened: 0, disposed: 0, loops: 0, loopsClosed: 0, prompts: [] as string[], events: [] as CoordinationTelemetryEvent[], leadPrompts: [] as string[] };
  const ledger: FlowLedgerEntry[] = Array.from({ length: 4 }, (_, i) => ({ path: "e2e/flows/cart.spec.ts", sha256: "abc", status: i === 3 ? "passed" : "failed", devWrites: 0 }));
  const workspaces: DelegationWorkspacePort = {
    create: async (request) => ({ dir: `/w/${request.delegationId}`, specDir: `/w/${request.delegationId}/e2e`, specRelDir: "e2e", files: 1, cut: false }),
    stage: async () => true,
    collect: async (_ws, request) => {
      collects += 1;
      if (opts.collectFaults?.includes(collects)) throw new Error("the workspace could not be read");
      return { copied: [...request.writablePaths], refused: [], proposals: [], proposalsTotal: 0 };
    },
    refresh: async (_ws, request) => [...request.writablePaths],
    dispose: async () => {},
    sweepAll: async () => 0,
  };
  const sidekick = new SidekickExecutor({
    redaction,
    runtime: {
      openSession: async (_role, _cwd, sessionOpts) => {
        state.opened += 1;
        let prompts = 0;
        const hanging = new Set<(err: Error) => void>();
        const endHanging = (err: Error): void => { for (const end of [...hanging]) end(err); };
        sessionOpts?.signal?.addEventListener("abort", () => endHanging(new Error("the prompt was aborted")), { once: true });
        return {
          prompt: async (text: string, promptOpts) => {
            state.prompts.push(text);
            const turn = turns[Math.min(prompts++, turns.length - 1)]!;
            if (turn instanceof Error) throw turn;
            if (turn !== HANG) return { output: turn };
            return new Promise<{ output: string }>((_resolve, reject) => {
              const end = (err: Error): void => { hanging.delete(end); reject(err); };
              hanging.add(end);
              clock.setTimer(promptOpts?.timeoutMs ?? sessionOpts?.timeoutMs ?? 0, () => end(new AgentTimeoutError("OpenCode prompt: timed out")));
              setImmediate(() => clock.runOut());
            });
          },
          dispose: async () => {
            state.disposed += 1;
            endHanging(new SessionGoneError("the session was deleted"));
          },
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
    timedOut: false,
    lead: {
      askForPlan: async () => ({ noSubmission: "no accepted submission", timedOut: false }),
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
    timers: clock,
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

const REVISE_REVISE_ACCEPT = [
  [{ flow: "cart", action: "revise", instruction: "Assert the total row." }],
  [{ flow: "cart", action: "revise", instruction: "Assert the total row, again." }],
  [{ flow: "cart", action: "accept" }],
];

test("a first turn that runs out of the flow's time keeps its session for the lead's revision", async () => {
  const r = await run([HANG, answer("fixed it")], REVISE_REVISE_ACCEPT);
  assert.equal(r.sessionsOpened, 1, "the revision reached the session that ran out of time");
  assert.equal(r.sessionsDisposed, 0);
});

test("a revision that runs out of the flow's time keeps the sidekick's session, its run_spec share and its proof for the lead's next order", async () => {
  const r = await run([answer("wrote the spec"), HANG, answer("fixed it")], REVISE_REVISE_ACCEPT);
  assert.equal(r.sessionsDisposed, 0, "running out of time did not end the session");
  assert.equal(r.sessionsOpened, 1, "the lead's next revision reached the session that did the work");
  assert.equal(r.prompts.length, 3);
  assert.equal(r.loopsOpened, 1);
  assert.equal(r.loopsClosed, 0, "its loop and the proof it holds outlived the flow's time");
  const overridden = r.events.filter((e) => e.kind === "lead-decision" && e.overrideReason !== undefined).map((e) => e.overrideReason);
  assert.deepEqual(overridden, [], "no revision was turned into a replace");
});

test("a revision that runs out of the flow's time is recorded as the turn's typed end, and the lead is shown it did not answer", async () => {
  const r = await run([answer("wrote the spec"), HANG, answer("fixed it")], REVISE_REVISE_ACCEPT);
  const revision = r.events.filter((e) => e.kind === "delegation" && e.flowId === "cart" && e.attempt === 2);
  assert.equal(revision.length, 1, "the revision's turn has its delegation event");
  assert.equal(revision[0]!.turnEnd, "timeout");
  assert.match(r.leadPrompts[1]!, /did not answer/i);
});

test("a fault outside the sidekick's turn (taking its work back) leaves the session for the lead's next revision", async () => {
  const r = await run([answer("wrote the spec"), answer("fixed it"), answer("again")], REVISE_REVISE_ACCEPT, { collectFaults: [2] });
  assert.equal(r.sessionsDisposed, 0, "a fault that is not the runtime's did not end the session");
  assert.equal(r.sessionsOpened, 1);
  assert.equal(r.prompts.length, 3);
});
