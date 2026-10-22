import { test } from "node:test";
import assert from "node:assert/strict";
import { runFlow, type FlowStep } from "@contexts/qa-run-orchestration/application/run-flow/run-flow.ts";
import type { RunPhase } from "@contexts/qa-run-orchestration/domain/run-phase-cursor.ts";

interface S { trace: string[]; n: number }
type Step = FlowStep<S, { skipB: boolean }, string>;

const recording = (name: string, phase?: RunPhase, extra: Partial<Step> = {}): Step => ({
  name,
  ...(phase ? { phase } : {}),
  run: async (state) => ({ update: { trace: [...state.trace, name], n: state.n + 1 } }),
  ...extra,
});

test("steps run in table order, each update reaching the next step, and the final state comes back", async () => {
  const entered: RunPhase[] = [];
  const out = await runFlow([recording("a", "gate"), recording("b"), recording("c", "setup")], { trace: [], n: 0 }, { skipB: false }, (p) => entered.push(p));
  assert.deepEqual(out, { state: { trace: ["a", "b", "c"], n: 3 } });
  assert.deepEqual(entered, ["gate", "setup"], "only a step that names a phase opens one");
});

test("a step whose condition says no is passed over without opening its phase", async () => {
  const entered: RunPhase[] = [];
  const out = await runFlow([recording("a"), recording("b", "classify", { runs: (_s, ctx) => !ctx.skipB }), recording("c")], { trace: [], n: 0 }, { skipB: true }, (p) => entered.push(p));
  assert.deepEqual(out, { state: { trace: ["a", "c"], n: 2 } });
  assert.deepEqual(entered, []);
});

test("the first step that ends the run stops the walk and its result is returned", async () => {
  const ending: Step = { name: "end", phase: "validate", run: async () => ({ end: "invalid" }) };
  const entered: RunPhase[] = [];
  const out = await runFlow([recording("a"), ending, recording("never", "execute")], { trace: [], n: 0 }, { skipB: false }, (p) => entered.push(p));
  assert.deepEqual(out, { end: "invalid" });
  assert.deepEqual(entered, ["validate"]);
});

test("a step that returns nothing leaves the state as it was", async () => {
  const quiet: Step = { name: "quiet", run: async () => undefined };
  assert.deepEqual(await runFlow([quiet], { trace: ["x"], n: 1 }, { skipB: false }, () => {}), { state: { trace: ["x"], n: 1 } });
});
