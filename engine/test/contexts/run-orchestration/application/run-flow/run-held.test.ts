/* A measured coverage fail under enforce holds the run: nothing is opened in the app's repository, the PR text with the coverage report stays on the run, and the suite stays out of the store. The other coverage outcomes decide as before. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicationPort } from "@contexts/workspace-and-publication/application/index.ts";
import { dispose, newRig, observe, type Rig } from "./run-end-rig.ts";

const FAILING = { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/cart.ts", lines: [10, 11] }], untakenArms: [{ file: "src/cart.ts", line: 14, kind: "if", arm: "else" }] };

type PublishInput = Parameters<PublicationPort["publish"]>[0];

function withCoverage(rig: Rig, mode: "signal" | "enforce", measure: Rig["measure"], blocks: Rig["blocks"], published: PublishInput[]): void {
  rig.config = { ...rig.config, coveragePolicyMode: mode, coverageMinRatio: 0.7 };
  rig.measure = measure;
  rig.blocks = blocks;
  rig.publish = async (input) => {
    published.push(input);
    return input.coverageBlocks ? { outcome: "held: change-coverage enforce-blocks the PR", held: { title: "qa-bot: pass run", body: "PR text\n\nChange coverage 0.2" } } : { outcome: "pr: https://github.com/o/a/pull/1" };
  };
}

test("an enforce fail records the held decision, hands the coverage report to publication and keeps the PR text on the run's outcome", async () => {
  const rig = newRig();
  const published: PublishInput[] = [];
  try {
    withCoverage(rig, "enforce", async () => FAILING, (status) => status === "fail", published);

    const observed = await observe(rig, "held-1");

    assert.equal(observed.result?.decision.sideEffect, "held");
    assert.equal(observed.result?.decision.outcome, "held");
    assert.equal(observed.result?.decision.shadowed, false);
    assert.equal(published[0]?.coverageBlocks, true);
    assert.deepEqual(published[0]?.coverageReport, { ratio: 0.2, minRatio: 0.7, uncovered: FAILING.uncovered, untakenArms: [{ file: "src/cart.ts", line: 14, arm: "else" }] });
    assert.deepEqual(observed.saved[0]?.gateSignals.heldPublication, { title: "qa-bot: pass run", body: "PR text\n\nChange coverage 0.2" });
  } finally {
    dispose(rig);
  }
});

test("a held run keeps no suite: it is not accepted into the store", async () => {
  const rig = newRig();
  const kept: string[] = [];
  try {
    withCoverage(rig, "enforce", async () => FAILING, (status) => status === "fail", []);
    const store = rig.store!;
    rig.store = Object.assign(Object.create(store) as typeof store, { capture: async (...args: Parameters<typeof store.capture>) => { kept.push("capture"); return await store.capture(...args); } });

    const observed = await observe(rig, "held-2");

    assert.equal(observed.result?.decision.outcome, "held", "the run reached its decision");
    assert.deepEqual(kept, []);
  } finally {
    dispose(rig);
  }
});

test("a coverage fail under signal and an unknown under enforce publish the PR as before and record no held text", async () => {
  for (const [mode, measure] of [["signal", async () => FAILING], ["enforce", async () => ({ status: "unknown" as const, ratio: null })]] as const) {
    const rig = newRig();
    const published: PublishInput[] = [];
    try {
      withCoverage(rig, mode, measure, (status) => mode === "enforce" && status === "fail", published);

      const observed = await observe(rig, `held-3-${mode}`);

      assert.equal(observed.result?.decision.sideEffect, "pr", mode);
      assert.equal(published[0]?.coverageBlocks, false, mode);
      assert.equal(published[0]?.coverageReport, undefined, mode);
      assert.equal(observed.saved[0]?.gateSignals.heldPublication, undefined, mode);
    } finally {
      dispose(rig);
    }
  }
});

test("a held run in shadow mode opens nothing and still keeps the text; a plain shadow pass is still replaced by its log line", async () => {
  const rig = newRig();
  try {
    withCoverage(rig, "enforce", async () => FAILING, (status) => status === "fail", []);
    rig.config = { ...rig.config, shadow: true };
    const held = await observe(rig, "held-4");
    assert.equal(held.result?.decision.sideEffect, "held");
    assert.equal(held.result?.decision.shadowed, false);
  } finally {
    dispose(rig);
  }
  const plain = newRig();
  try {
    plain.config = { ...plain.config, shadow: true };
    const observed = await observe(plain, "held-5");
    assert.equal(observed.result?.decision.sideEffect, "shadow-log");
    assert.equal(observed.result?.decision.outcome, "pr");
    assert.equal(observed.result?.decision.shadowed, true);
  } finally {
    dispose(plain);
  }
});
