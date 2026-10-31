import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTurnTraces, DEFAULT_TRACE_MAX_AGE_MS } from "@contexts/generation/infrastructure/telemetry/turn-trace-registry.ts";
import type { TurnProbe } from "@contexts/generation/infrastructure/telemetry/turn-probe.ts";

function fakeProbe() {
  const probe = { closed: 0, events: [] as string[], onAttempt(e: { kind: string }) { this.events.push(e.kind); }, closeAll() { this.closed += 1; }, isDone: () => false, limit() {}, firedByOuter: () => undefined };
  return probe;
}

test("a session that is never disposed is swept, and its open spans closed, once a newer turn finds it older than the age limit", () => {
  let now = 0;
  const traces = new AgentTurnTraces({ now: () => now });
  const stale = fakeProbe();
  traces.begin("old-session", stale as unknown as TurnProbe);
  now = DEFAULT_TRACE_MAX_AGE_MS + 1;
  const fresh = fakeProbe();
  traces.begin("new-session", fresh as unknown as TurnProbe);
  assert.equal(stale.closed, 1);
  assert.equal(fresh.closed, 0);
  assert.equal(traces.size(), 1);
});

test("a session heard from recently is kept however old its first turn is", () => {
  let now = 0;
  const traces = new AgentTurnTraces({ now: () => now });
  const probe = fakeProbe();
  traces.begin("s", probe as unknown as TurnProbe);
  now = DEFAULT_TRACE_MAX_AGE_MS - 10;
  traces.begin("s", fakeProbe() as unknown as TurnProbe);
  now = DEFAULT_TRACE_MAX_AGE_MS + 5;
  traces.begin("other", fakeProbe() as unknown as TurnProbe);
  assert.equal(traces.size(), 2);
  assert.equal(probe.closed, 0);
});

test("the live attempt of a session is the one its latest turn has open, and a served call is told to that turn", () => {
  const traces = new AgentTurnTraces();
  const span = { id: "attempt-span" };
  const told: unknown[] = [];
  const probe = { ...fakeProbe(), liveAttempt: () => span, noteToolCall: (call: unknown) => told.push(call) };
  traces.begin("s", probe as unknown as TurnProbe);
  assert.equal(traces.attemptSpan("s"), span);
  assert.equal(traces.attemptSpan("unknown"), undefined);
  const call = { tool: "run_spec", startedAt: 1, endedAt: 2, context: { traceId: "t", spanId: "x" } };
  traces.noteToolCall("s", call);
  traces.noteToolCall("unknown", call);
  assert.deepEqual(told, [call]);
  traces.end("s");
  assert.equal(traces.attemptSpan("s"), undefined);
});

test("a call served for one session is told to that session's turn only, so parallel sessions never see each other's calls", () => {
  const traces = new AgentTurnTraces();
  const told: string[] = [];
  const probeFor = (name: string) => ({ ...fakeProbe(), liveAttempt: () => undefined, noteToolCall: () => told.push(name) });
  traces.begin("sidekick-1", probeFor("one") as unknown as TurnProbe);
  traces.begin("sidekick-2", probeFor("two") as unknown as TurnProbe);
  traces.noteToolCall("sidekick-2", { tool: "run_spec", startedAt: 1, endedAt: 2, context: { traceId: "t", spanId: "x" } });
  assert.deepEqual(told, ["two"]);
});
