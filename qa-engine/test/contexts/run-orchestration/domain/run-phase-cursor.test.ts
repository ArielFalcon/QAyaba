import { test } from "node:test";
import assert from "node:assert/strict";
import { RunPhaseCursor, RUN_PHASES, phaseSnapshotOf, recordPhaseSnapshot } from "@contexts/run-orchestration/domain/run-phase-cursor.ts";

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("a cursor that entered nothing has no timings and no furthest phase", () => {
  const cursor = new RunPhaseCursor(fakeClock());
  assert.deepEqual(cursor.timings(), {});
  assert.equal(cursor.furthest(), null);
});

test("entering a phase ends the open one and charges it the time it was open", () => {
  const clock = fakeClock();
  const cursor = new RunPhaseCursor(clock);
  cursor.enter("gate");
  clock.advance(30);
  cursor.enter("classify");
  clock.advance(70);
  cursor.close();
  assert.deepEqual(cursor.timings(), { gate: 30, classify: 70 });
});

test("the furthest phase is the entered phase latest in the pipeline, not the last one entered", () => {
  const clock = fakeClock();
  const cursor = new RunPhaseCursor(clock);
  cursor.enter("execute");
  cursor.enter("fix_loop");
  cursor.enter("execute");
  assert.equal(cursor.furthest(), "fix_loop");
});

test("re-entering a phase adds to its total instead of replacing it", () => {
  const clock = fakeClock();
  const cursor = new RunPhaseCursor(clock);
  cursor.enter("generate");
  clock.advance(10);
  cursor.enter("validate");
  clock.advance(5);
  cursor.enter("generate");
  clock.advance(20);
  cursor.close();
  assert.deepEqual(cursor.timings(), { generate: 30, validate: 5 });
});

test("closing twice charges the open phase once", () => {
  const clock = fakeClock();
  const cursor = new RunPhaseCursor(clock);
  cursor.enter("setup");
  clock.advance(40);
  cursor.close();
  clock.advance(500);
  cursor.close();
  assert.deepEqual(cursor.timings(), { setup: 40 });
});

test("timings read while a phase is open include the time it has run so far, without ending it", () => {
  const clock = fakeClock();
  const cursor = new RunPhaseCursor(clock);
  cursor.enter("decide");
  clock.advance(15);
  assert.deepEqual(cursor.timings(), { decide: 15 });
  clock.advance(5);
  cursor.close();
  assert.deepEqual(cursor.timings(), { decide: 20 });
});

test("only phases that were entered appear in the timings", () => {
  const cursor = new RunPhaseCursor(fakeClock());
  cursor.enter("gate");
  cursor.enter("classify");
  cursor.close();
  assert.deepEqual(Object.keys(cursor.timings()).sort(), ["classify", "gate"]);
});

test("the canonical phase order lists every phase once", () => {
  assert.equal(new Set(RUN_PHASES).size, RUN_PHASES.length);
  assert.equal(RUN_PHASES[0], "gate");
  assert.equal(RUN_PHASES.at(-1), "learn");
});

test("a snapshot recorded for an error is read back for that error and for no other", () => {
  const failure = new Error("boom");
  recordPhaseSnapshot(failure, { furthestPhase: "execute", phaseTimings: { execute: 9 } });
  assert.deepEqual(phaseSnapshotOf(failure), { furthestPhase: "execute", phaseTimings: { execute: 9 } });
  assert.equal(phaseSnapshotOf(new Error("boom")), undefined);
  assert.equal(phaseSnapshotOf("not an object"), undefined);
});

test("an observer hears each phase open at the clock reading it opened at and close at the reading it closed at", () => {
  const clock = fakeClock(5_000);
  const heard: string[] = [];
  const cursor = new RunPhaseCursor(clock, {
    onEnter: (phase, at) => heard.push(`enter ${phase} ${at}`),
    onExit: (phase, at) => heard.push(`exit ${phase} ${at}`),
  });
  cursor.enter("gate");
  clock.advance(30);
  cursor.enter("classify");
  clock.advance(70);
  cursor.close();
  assert.deepEqual(heard, ["enter gate 5000", "exit gate 5030", "enter classify 5030", "exit classify 5100"]);
});

test("a re-entered phase is observed as a new opening each time, and closing twice exits once", () => {
  const clock = fakeClock();
  const exits: string[] = [];
  const enters: string[] = [];
  const cursor = new RunPhaseCursor(clock, { onEnter: (p) => enters.push(p), onExit: (p) => exits.push(p) });
  cursor.enter("generate");
  cursor.enter("validate");
  cursor.enter("generate");
  cursor.close();
  cursor.close();
  assert.deepEqual(enters, ["generate", "validate", "generate"]);
  assert.deepEqual(exits, ["generate", "validate", "generate"]);
});

test("an observer that throws changes neither the timings nor the furthest phase", () => {
  const clock = fakeClock();
  const cursor = new RunPhaseCursor(clock, {
    onEnter: () => { throw new Error("observer fault"); },
    onExit: () => { throw new Error("observer fault"); },
  });
  cursor.enter("gate");
  clock.advance(12);
  cursor.enter("workspace");
  cursor.close();
  assert.deepEqual(cursor.timings(), { gate: 12, workspace: 0 });
  assert.equal(cursor.furthest(), "workspace");
});
