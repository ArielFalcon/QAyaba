/* The static-fix rounds as the run walks them: a gate that fails and is repaired reaches execution, a gate that is never repaired ends the run after the rounds a run may spend. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { traceFactsOf } from "@kernel/run-trace-facts.ts";
import { MAX_STATIC_FIX_ROUNDS } from "@kernel/derive-cycle-backstop.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { RIG_SPEC, dispose, newRig, observe } from "./run-end-rig.ts";

function counting(failures: number) {
  const calls = { generate: 0, validate: 0, execute: 0 };
  return {
    calls,
    arm: (rig: ReturnType<typeof newRig>) => {
      rig.author = async () => { calls.generate += 1; return scriptedGeneration({ specs: [RIG_SPEC]}); };
      rig.validate = async () => { calls.validate += 1; return calls.validate <= failures ? { ok: false, errors: ["[lint] no-wait-for-timeout"] } : { ok: true, errors: [] }; };
      rig.execute = async () => { calls.execute += 1; return { verdict: "pass", cases: [], logs: "" }; };
    },
  };
}

test("a gate that fails twice and then passes spends two repair rounds and reaches execution", async () => {
  const rig = newRig();
  try {
    const run = counting(2);
    run.arm(rig);
    const observed = await observe(rig, "static-fix-repaired");
    assert.equal(observed.threw, undefined);
    assert.equal(traceFactsOf(observed.result!)?.endReason, "decided");
    assert.deepEqual(run.calls, { generate: 1 + 2, validate: 3, execute: 1 });
    assert.equal(observed.result!.gateSignals.retries, 2);
  } finally {
    dispose(rig);
  }
});

test("a gate that is never repaired ends the run invalid after exactly the repair rounds a run may spend", async () => {
  const rig = newRig();
  try {
    const run = counting(100);
    run.arm(rig);
    const observed = await observe(rig, "static-fix-exhausted");
    assert.equal(traceFactsOf(observed.result!)?.endReason, "static-gate-failed");
    assert.equal(observed.result!.decision.verdict, "invalid");
    assert.deepEqual(run.calls, { generate: 1 + MAX_STATIC_FIX_ROUNDS, validate: 1 + MAX_STATIC_FIX_ROUNDS, execute: 0 });
  } finally {
    dispose(rig);
  }
});

test("a cancel during a repair round stops the run before another regeneration is spent", async () => {
  const rig = newRig();
  try {
    const run = counting(100);
    run.arm(rig);
    const generate = rig.author;
    rig.author = async (...args) => {
      const out = await generate(...args);
      if (run.calls.generate === 2) rig.abort.abort();
      return out;
    };
    const observed = await observe(rig, "static-fix-cancelled");
    assert.equal(traceFactsOf(observed.result!)?.endReason, "aborted");
    assert.equal(run.calls.generate, 2);
  } finally {
    dispose(rig);
  }
});
