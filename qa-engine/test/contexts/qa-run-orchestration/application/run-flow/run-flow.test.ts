import { test } from "node:test";
import assert from "node:assert/strict";
import { end, goto, next, runFlow, validateTable, type FlowHooks, type FlowStep, type StepEvent } from "@contexts/qa-run-orchestration/application/run-flow/run-flow.ts";
import { runEnd } from "@contexts/qa-run-orchestration/application/run-flow/run-end.ts";
import type { RunPhase } from "@contexts/qa-run-orchestration/domain/run-phase-cursor.ts";

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
function recorder() {
  const entered: RunPhase[] = [];
  const events: StepEvent<Id>[] = [];
  const hooks: FlowHooks<Id> = { enter: (phase) => entered.push(phase), record: (event) => events.push(event) };
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
  const hooks: FlowHooks<Id> = { enter: (phase) => order.push(`enter ${phase}`), record: (event) => order.push(`${event.outcome} ${event.id}`) };
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
