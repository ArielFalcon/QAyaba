import { test } from "node:test";
import assert from "node:assert/strict";
import { end, goto, next, runFlow, validateTable, type FlowHooks, type FlowStep, type StepEvent } from "@contexts/run-orchestration/application/run-flow/run-flow.ts";
import { throwIfAborted } from "@contexts/run-orchestration/application/run-flow/abort.ts";
import { runEnd } from "@contexts/run-orchestration/application/run-flow/run-end.ts";
import type { RunPhase } from "@kernel/run-step.ts";

interface S { trace: string[]; n: number }
type Id = "a" | "b" | "c" | "end" | "quiet" | "never";
type Step = FlowStep<S, { skipB: boolean }, Id>;

const recording = (id: Id, phase?: RunPhase, extra: Partial<Step> = {}): Step => ({
  id,
  ...(phase ? { phase } : {}),
  run: async (state) => ({ update: { trace: [...state.trace, id], n: state.n + 1 } }),
  ...extra,
});

/* A recorder standing in for the run's trace: the phases entered and the step events, in the order the runner reported them. */
function recorder(cancelled: () => boolean = () => false) {
  const entered: RunPhase[] = [];
  const events: StepEvent<Id>[] = [];
  const hooks: FlowHooks<Id> = { aborted: cancelled, endOf: (reason) => runEnd(reason as "aborted"), enter: (phase) => entered.push(phase), record: (event) => events.push(event) };
  return { entered, events, hooks };
}

test("steps run in table order, each update reaching the next step, and the final state comes back", async () => {
  const { entered, hooks } = recorder();
  const out = await runFlow([recording("a", "gate"), recording("b"), recording("c", "setup")], { trace: [], n: 0 }, { skipB: false }, hooks);
  assert.deepEqual(out, { state: { trace: ["a", "b", "c"], n: 3 } });
  assert.deepEqual(entered, ["gate", "setup"], "only a step that names a phase opens one");
});

test("a step whose condition says no is passed over without opening its phase", async () => {
  const { entered, hooks } = recorder();
  const out = await runFlow([recording("a"), recording("b", "classify", { runs: (_s, ctx) => !ctx.skipB }), recording("c")], { trace: [], n: 0 }, { skipB: true }, hooks);
  assert.deepEqual(out, { state: { trace: ["a", "c"], n: 2 } });
  assert.deepEqual(entered, []);
});

test("the first step that ends the run stops the walk and its end, with the reason and facts, is returned", async () => {
  const ending: Step = { id: "end", phase: "validate", run: async () => end("setup-failed", { note: "npm ci failed" }) };
  const { entered, hooks } = recorder();
  const out = await runFlow([recording("a"), ending, recording("never", "execute")], { trace: [], n: 0 }, { skipB: false }, hooks);
  assert.deepEqual(out, { end: runEnd("setup-failed", { note: "npm ci failed" }) });
  assert.deepEqual(entered, ["validate"]);
});

test("a step that returns nothing leaves the state as it was", async () => {
  const quiet: Step = { id: "quiet", run: async () => undefined };
  assert.deepEqual(await runFlow([quiet], { trace: ["x"], n: 1 }, { skipB: false }, recorder().hooks), { state: { trace: ["x"], n: 1 } });
});

test("every step is reported in table order as ran, skipped or ended, and the ending step carries the reason", async () => {
  const ending: Step = { id: "end", run: async () => end("aborted") };
  const { events, hooks } = recorder();
  await runFlow([recording("a"), recording("b", undefined, { runs: () => false }), ending, recording("never")], { trace: [], n: 0 }, { skipB: false }, hooks);
  assert.deepEqual(events, [
    { id: "a", outcome: "ran" },
    { id: "b", outcome: "skipped" },
    { id: "end", outcome: "ended", reason: "aborted" },
  ]);
});

test("a step is reported after its phase is entered, so the report lands in the phase the step opens", async () => {
  const order: string[] = [];
  const hooks: FlowHooks<Id> = { aborted: () => false, endOf: (reason) => runEnd(reason as "aborted"), enter: (phase) => order.push(`enter ${phase}`), record: (event) => order.push(`${event.outcome} ${event.id}`) };
  await runFlow([recording("a", "gate"), recording("b", "setup", { runs: () => false }), recording("c", "execute")], { trace: [], n: 0 }, { skipB: false }, hooks);
  assert.deepEqual(order, ["enter gate", "ran a", "skipped b", "enter execute", "ran c"]);
});

test("an end carries the update the step returned with it", async () => {
  const ending: Step = { id: "end", run: async () => ({ end: runEnd("aborted"), update: { n: 7 } }) };
  const state: S = { trace: [], n: 0 };
  await runFlow([ending], state, { skipB: false }, recorder().hooks);
  assert.equal(state.n, 7);
});

test("a step that goes to another step sends the walk there, and its update is merged first", async () => {
  const visit: Step = { id: "a", run: async (state) => ({ update: { trace: [...state.trace, "a"] } }) };
  const loop: Step = {
    id: "b",
    run: async (state) => (state.trace.length < 3 ? goto("a", { n: state.n + 1 }) : next({ trace: [...state.trace, "done"] })),
  };
  const { events, hooks } = recorder();
  const out = await runFlow([visit, loop, recording("c")], { trace: [], n: 0 }, { skipB: false }, hooks);
  assert.deepEqual(out, { state: { trace: ["a", "a", "a", "done", "c"], n: 3 } });
  assert.deepEqual(events.filter((event) => event.id === "b").map((event) => event.outcome), ["ran", "ran", "ran"]);
});

test("a step that goes to a step the table does not have fails loudly instead of ending the run", async () => {
  const lost: Step = { id: "a", run: async () => goto("never") };
  await assert.rejects(runFlow([lost, recording("b")], { trace: [], n: 0 }, { skipB: false }, recorder().hooks), /goes to "never", which the step table does not have/);
});

test("a table that sends the walk back for ever stops with an error", async () => {
  const forever: Step = { id: "a", run: async () => goto("a") };
  await assert.rejects(runFlow([forever], { trace: [], n: 0 }, { skipB: false }, recorder().hooks), /did not end after/);
});

test("a table that names a step twice is refused before any step runs", async () => {
  let ran = false;
  const first: Step = { id: "a", run: async () => { ran = true; } };
  assert.throws(() => validateTable([first, first]), /names "a" twice/);
  await assert.rejects(runFlow([first, first], { trace: [], n: 0 }, { skipB: false }, recorder().hooks), /names "a" twice/);
  assert.equal(ran, false);
});

test("a run cancelled before a step ends aborted before that step runs, and the ending step is the one that did not run", async () => {
  let cancelled = false;
  const cancelling: Step = { id: "b", run: async (state) => { cancelled = true; return { update: { trace: [...state.trace, "b"] } }; } };
  const { events, hooks } = recorder(() => cancelled);
  const out = await runFlow([recording("a"), cancelling, recording("c")], { trace: [], n: 0 }, { skipB: false }, hooks);
  assert.deepEqual(out, { end: runEnd("aborted") });
  assert.deepEqual(events, [
    { id: "a", outcome: "ran" },
    { id: "b", outcome: "ran" },
    { id: "c", outcome: "ended", reason: "aborted" },
  ]);
});

test("a run cancelled while its last step ran still ends aborted", async () => {
  let cancelled = false;
  const last: Step = { id: "a", run: async () => { cancelled = true; } };
  assert.deepEqual(await runFlow([last], { trace: [], n: 0 }, { skipB: false }, recorder(() => cancelled).hooks), { end: runEnd("aborted") });
});

test("an interruption point inside a step ends the run aborted", async () => {
  const interrupted: Step = { id: "b", run: async () => { throwIfAborted(AbortSignal.abort()); } };
  const { events, hooks } = recorder();
  assert.deepEqual(await runFlow([recording("a"), interrupted, recording("c")], { trace: [], n: 0 }, { skipB: false }, hooks), { end: runEnd("aborted") });
  assert.deepEqual(events.at(-1), { id: "b", outcome: "ended", reason: "aborted" });
});

test("an interruption point leaves a live run alone", () => {
  assert.doesNotThrow(() => throwIfAborted(new AbortController().signal));
  assert.doesNotThrow(() => throwIfAborted(undefined));
});

test("a failed login is not kept when the run was cancelled: the abort wins, and a live run keeps its end", async () => {
  const failedLogin = (reason: "login-precondition" | "pre-execute-infra"): Step => ({
    id: "end",
    run: async () => (reason === "login-precondition" ? end("login-precondition", { generating: true, note: "rejected" }) : end("pre-execute-infra", { generating: true, note: "rejected", preconditionFailed: true })),
  });
  for (const reason of ["login-precondition", "pre-execute-infra"] as const) {
    assert.deepEqual(await runFlow([failedLogin(reason)], { trace: [], n: 0 }, { skipB: false }, recorder(() => false).hooks), { end: expectedEnd(reason) });
    let calls = 0;
    const out = await runFlow([failedLogin(reason)], { trace: [], n: 0 }, { skipB: false }, recorder(() => ++calls > 1).hooks);
    assert.deepEqual(out, { end: runEnd("aborted") });
  }
});

test("an infra end that is not a failed login survives a cancel", async () => {
  const dead: Step = { id: "end", run: async () => end("pre-execute-infra", { generating: true, note: "DEV is down" }) };
  let calls = 0;
  const out = await runFlow([dead], { trace: [], n: 0 }, { skipB: false }, recorder(() => ++calls > 1).hooks);
  assert.deepEqual(out, { end: runEnd("pre-execute-infra", { generating: true, note: "DEV is down" }) });
});

const expectedEnd = (reason: "login-precondition" | "pre-execute-infra") =>
  reason === "login-precondition" ? runEnd("login-precondition", { generating: true, note: "rejected" }) : runEnd("pre-execute-infra", { generating: true, note: "rejected", preconditionFailed: true });

test("a step that declares what it writes cannot return an update outside it", async () => {
  const stray: Step = { id: "a", writes: ["trace"], run: async () => ({ update: { n: 9 } }) };
  const { hooks } = recorder();
  await assert.rejects(runFlow([stray], { trace: [], n: 0 }, { skipB: false }, hooks), /step "a" returned an update for "n", which it does not declare/);
});

test("a step that declares what it writes may update exactly those fields", async () => {
  const within: Step = { id: "a", writes: ["trace", "n"], run: async (state) => ({ update: { trace: [...state.trace, "a"], n: 1 } }) };
  const { hooks } = recorder();
  assert.deepEqual(await runFlow([within], { trace: [], n: 0 }, { skipB: false }, hooks), { state: { trace: ["a"], n: 1 } });
});
