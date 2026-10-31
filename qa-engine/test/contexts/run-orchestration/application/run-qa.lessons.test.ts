/* What a run read of DEV's data is recorded at the ground step as observations, whatever the run comes to, and the run records how many reads were left out and why. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ok } from "@kernel/result.ts";
import type { PageDataRead } from "@kernel/page-data-read.ts";
import type { ServedVersionState } from "@kernel/served-version.ts";
import { RecordLessonObservations, type LessonObservation, type LessonStorePort } from "@contexts/cross-run-learning/application/index.ts";
import { dispose, newRig, observe, type Rig } from "./run-flow/run-end-rig.ts";

const READ: PageDataRead = { scope: "/shops/madrid", grounded: true, dataState: true, unconfirmed: false, resultCount: 0, emptyConfirmed: true, ready: true };

function recorded(): { rows: LessonObservation[]; extra: Rig["extra"] } {
  const rows: LessonObservation[] = [];
  const store: LessonStorePort = { record: async (batch) => { rows.push(...batch); }, listAdmitted: async () => [] };
  return { rows, extra: { lessonRecorder: new RecordLessonObservations(store), preGenerationGrounding: { ground: async () => ({ pageReads: [READ, { ...READ, scope: "/home", dataState: undefined }] }) } } };
}

async function runWith(setup: (rig: Rig) => void, served: ServedVersionState = "equal") {
  const rig = newRig();
  try {
    const { rows, extra } = recorded();
    rig.extra = extra;
    rig.verifyServed = async () => ok({ state: served });
    setup(rig);
    const observed = await observe(rig, `lessons-${Math.random().toString(36).slice(2, 8)}`);
    return { observed, rows };
  } finally {
    dispose(rig);
  }
}

test("the same read is admitted in a run that ends pass, one that ends invalid and one that ends flaky: the verdict is never an input", async () => {
  const ends = {
    pass: () => {},
    invalid: (rig: Rig) => { rig.validate = async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }); },
    flaky: (rig: Rig) => { rig.execute = async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" }], logs: "" }); },
  };
  for (const [verdict, setup] of Object.entries(ends)) {
    const { observed, rows } = await runWith(setup);
    assert.equal(observed.result?.decision.verdict, verdict);
    const shops = rows.filter((r) => r.scope === "/shops/madrid");
    assert.deepEqual(shops.map((r) => [r.admitted, r.leftOutReason, r.servedState]), [[true, null, "equal"]], verdict);
    assert.deepEqual(shops[0]!.fact, { resultCount: 0, emptyConfirmed: true, ready: true });
    assert.equal(shops[0]!.sha, "abc1234");
    assert.equal(shops[0]!.repo, "org/demo", "the anchor repo of the change");
  }
});

test("the run records how many pages it read and why the others taught nothing, beside its other gate signals", async () => {
  const { observed } = await runWith(() => {});
  assert.deepEqual(observed.saved[0]!.gateSignals.lessons, { observed: 2, leftOut: { "no-data-state": 1 } });
});

test("under a served-version state the kind does not admit, every read is left out under that state", async () => {
  const { observed, rows } = await runWith(() => {}, "undeclared");
  assert.ok(rows.length === 2 && rows.every((r) => !r.admitted && r.leftOutReason === "served-version:undeclared"));
  assert.deepEqual(observed.saved[0]!.gateSignals.lessons, { observed: 2, leftOut: { "served-version:undeclared": 2 } });
});

test("a run with no recorder wired, or whose grounding read no page, records nothing and persists no lessons signal, as before", async () => {
  const rig = newRig();
  try {
    rig.extra = { preGenerationGrounding: { ground: async () => ({ pageReads: [READ] }) } };
    assert.equal((await observe(rig, "lessons-unwired")).saved[0]!.gateSignals.lessons, undefined);
  } finally {
    dispose(rig);
  }
  const { observed, rows } = await runWith(() => {});
  assert.ok(observed.saved[0]);
  const rig2 = newRig();
  try {
    const { rows: none, extra } = recorded();
    rig2.extra = { ...extra, preGenerationGrounding: { ground: async () => ({}) } };
    const out = await observe(rig2, "lessons-no-pages");
    assert.deepEqual(none, []);
    assert.equal(out.saved[0]!.gateSignals.lessons, undefined);
  } finally {
    dispose(rig2);
  }
  assert.ok(rows.length > 0);
});

test("a store that fails costs the run nothing but the observation: the run goes on and ends as it would have", async () => {
  const rig = newRig();
  try {
    const store: LessonStorePort = { record: async () => { throw new Error("disk full"); }, listAdmitted: async () => [] };
    rig.extra = { lessonRecorder: new RecordLessonObservations(store), preGenerationGrounding: { ground: async () => ({ pageReads: [READ] }) } };
    const observed = await observe(rig, "lessons-store-fails");
    assert.equal(observed.result?.decision.verdict, "pass");
    assert.equal(observed.saved[0]!.gateSignals.lessons, undefined);
  } finally {
    dispose(rig);
  }
});
