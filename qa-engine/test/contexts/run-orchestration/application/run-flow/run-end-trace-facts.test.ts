/*
 * What a run's trace says about how it ended beyond its verdict: every limit that fired, every degradation the run went on past
 * and the one decision (what it decided, and whether shadow replaced it), read from the rows of the run-end table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { traceFactsOf } from "@kernel/run-trace-facts.ts";
import { RUN_END_ROWS } from "./run-end-rows.ts";
import { dispose, newRig, observe, type Rig } from "./run-end-rig.ts";

async function factsOfRow(id: string, tweak?: (rig: Rig) => void) {
  const row = RUN_END_ROWS.find((r) => r.id === id);
  assert.ok(row, `the run-end table has a row ${id}`);
  const rig = newRig();
  try {
    row.setup(rig);
    tweak?.(rig);
    const observed = await observe(rig, `facts-${id}`);
    assert.ok(observed.result, "the run returned a result");
    return { facts: traceFactsOf(observed.result), note: observed.result.note };
  } finally {
    dispose(rig);
  }
}

test("a deadline spent after the suite was proven is a limit and a degradation of the run, not only a sentence in its note", async () => {
  const { facts, note } = await factsOfRow("run-deadline-in-coverage-after-proof");
  assert.deepEqual(facts?.limits, [{ fired: "run-deadline", role: "primary", scope: "run" }]);
  assert.equal(facts?.limitFired, "run-deadline");
  assert.equal(facts?.limitRole, "primary");
  assert.deepEqual(facts?.degradations, [{ reason: "deadline-after-proof", note: "the run deadline was spent during measure-coverage; the suite that ran green on its final bytes is kept" }]);
  assert.equal(facts?.endReason, "decided");
  assert.match(note ?? "", /the run deadline was spent during measure-coverage/, "the note is derived from the same degradation");
});

test("a publication that failed after the verdict was decided is a degradation of the run, and the note says it", async () => {
  const { facts, note } = await factsOfRow("publication-failed-after-decision");
  assert.equal(facts?.degradations?.length, 1);
  assert.equal(facts?.degradations?.[0]?.reason, "publication-failed");
  assert.match(facts?.degradations?.[0]?.note ?? "", /github 502/);
  assert.equal(note, facts?.degradations?.[0]?.note);
  assert.deepEqual(facts?.limits, []);
});

test("a run that met no limit and went on past nothing says so with empty lists, not with absence", async () => {
  const rig = newRig();
  try {
    const observed = await observe(rig, "facts-clean");
    const facts = traceFactsOf(observed.result!);
    assert.deepEqual(facts?.limits, []);
    assert.deepEqual(facts?.degradations, []);
    assert.equal(facts?.decision, "pr");
    assert.equal(facts?.shadowed, false);
  } finally {
    dispose(rig);
  }
});

test("a shadow run names what it decided and that shadow replaced it, in the same words as a live run", async () => {
  const rig = newRig();
  try {
    rig.config = { ...rig.config, shadow: true };
    const observed = await observe(rig, "facts-shadow-pass");
    const facts = traceFactsOf(observed.result!);
    assert.equal(observed.result?.decision.sideEffect, "shadow-log", "what ran is unchanged");
    assert.equal(facts?.decision, "pr");
    assert.equal(facts?.shadowed, true);
  } finally {
    dispose(rig);
  }
});

test("a shadow run that would have opened an Issue says issue, and a decision shadow cannot replace is never marked shadowed", async () => {
  const failing = newRig();
  try {
    failing.config = { ...failing.config, shadow: true };
    failing.execute = async () => ({ verdict: "fail", cases: [{ name: "a", status: "fail" }], logs: "assertion failed" });
    const facts = traceFactsOf((await observe(failing, "facts-shadow-fail")).result!);
    assert.equal(facts?.decision, "issue");
    assert.equal(facts?.shadowed, true);
  } finally {
    dispose(failing);
  }
  const infra = await factsOfRow("run-deadline", (rig) => { rig.config = { ...rig.config, shadow: true }; });
  assert.equal(infra.facts?.decision, "none");
  assert.equal(infra.facts?.shadowed, false);
});

test("a limit that ended the run is recorded once, whichever place ended it", async () => {
  const { facts } = await factsOfRow("run-deadline-during-fix-loop");
  assert.deepEqual(facts?.limits, [{ fired: "run-deadline", role: "primary", scope: "run" }]);
  assert.deepEqual(facts?.degradations, []);
});

