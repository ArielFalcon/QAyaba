/* What a run read of DEV's data is recorded at the ground step as observations, whatever the run comes to, and the run records how many reads were left out and why. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ok } from "@kernel/result.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { PageDataRead } from "@kernel/page-data-read.ts";
import type { ServedVersionState } from "@kernel/served-version.ts";
import type { CoordinateInput } from "@contexts/coordination/application/lead-sidekicks.ts";
import type { LessonDelivery } from "@kernel/coordination.ts";
import { RecordLessonObservations, type Lesson, type LessonObservation, type LessonsPort, type LessonStorePort } from "@contexts/cross-run-learning/application/index.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { CoordinateResult } from "@contexts/coordination/application/index.ts";
import { RIG_SPEC, dispose, newRig, observe, type Rig } from "./run-flow/run-end-rig.ts";

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
  assert.deepEqual(observed.saved[0]!.gateSignals.lessons, { observed: 2, leftOut: { "no-data-state": 1 }, dataStateFailures: [] });
});

test("under a served-version state the kind does not admit, every read is left out under that state", async () => {
  const { observed, rows } = await runWith(() => {}, "undeclared");
  assert.ok(rows.length === 2 && rows.every((r) => !r.admitted && r.leftOutReason === "served-version:undeclared"));
  assert.deepEqual(observed.saved[0]!.gateSignals.lessons, { observed: 2, leftOut: { "served-version:undeclared": 2 }, dataStateFailures: [] });
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

/* Delivery: what earlier observations teach reaches the coordinator only for a run whose lessons lever is on. */
const LESSON: Lesson = { kind: "data-volatility", scope: "/shops/madrid", withResults: 2, emptyConfirmed: 1, latestReadAt: "2026-10-30T10:00:00.000Z", evidence: ["r-1", "r-2", "r-3"] };

function coordinating(seen: CoordinateInput[], delivered: LessonDelivery[]): Partial<Rig["extra"]> {
  return {
    leadSidekicks: {
      coordinate: async (input) => {
        seen.push(input);
        return { action: "noop", reason: "nothing worth a test", signal: { plan: "noop", flows: 0, delivered: 0, incomplete: 0, ...(delivered.length > 0 ? { lessonsDelivered: delivered } : {}) } };
      },
    },
  };
}

test("a run whose lessons lever is on derives the lessons of the pages it read from rows written before it started, hands them to the coordinator and records what its briefs delivered", async () => {
  const rig = newRig();
  try {
    rig.verifyServed = async () => ok({ state: "equal" });
    const queries: Array<Parameters<LessonsPort["derive"]>[0]> = [];
    const seen: CoordinateInput[] = [];
    const delivered = [{ kind: "data-volatility", scope: "/shops/madrid", digest: "abc123def456" }];
    const { extra } = recorded();
    rig.extra = { ...extra, ...coordinating(seen, delivered), lessons: { derive: async (query) => { queries.push(query); return [LESSON]; } } };
    const observed = await observe(rig, "lessons-delivered");
    assert.deepEqual([...queries[0]!.scopes].sort(), ["/home", "/shops/madrid"]);
    assert.equal(queries[0]!.app, "demo");
    assert.ok(Date.parse(queries[0]!.before) <= Date.now(), "rows of this run itself are not before its start");
    assert.deepEqual(seen[0]!.lessons, [LESSON]);
    const signals = observed.saved[0]!.gateSignals;
    assert.deepEqual(signals.lessons, { observed: 2, leftOut: { "no-data-state": 1 }, delivered });
    assert.equal(signals.coordination?.lessonsDelivered, undefined, "the delivery is on the lessons signal alone");
  } finally {
    dispose(rig);
  }
});

test("a run whose lessons lever is off records its reads and is handed no lesson: the coordinator input carries none and no delivery is recorded", async () => {
  const rig = newRig();
  try {
    rig.verifyServed = async () => ok({ state: "equal" });
    const seen: CoordinateInput[] = [];
    const { rows, extra } = recorded();
    rig.extra = { ...extra, ...coordinating(seen, []) };
    const observed = await observe(rig, "lessons-frozen");
    assert.ok(rows.length > 0, "a frozen run still writes its observations");
    assert.equal(seen[0]!.lessons, undefined);
    assert.deepEqual(observed.saved[0]!.gateSignals.lessons, { observed: 2, leftOut: { "no-data-state": 1 } });
  } finally {
    dispose(rig);
  }
});

test("a run with no lessons to derive, or whose derivation fails, is handed none and ends as it would have", async () => {
  for (const derive of [async () => [] as Lesson[], async (): Promise<Lesson[]> => { throw new Error("read failed"); }]) {
    const rig = newRig();
    try {
      rig.verifyServed = async () => ok({ state: "equal" });
      const seen: CoordinateInput[] = [];
      const { extra } = recorded();
      rig.extra = { ...extra, ...coordinating(seen, []), lessons: { derive } };
      const observed = await observe(rig, "lessons-none");
      assert.equal(seen[0]!.lessons, undefined);
      assert.deepEqual(observed.saved[0]!.gateSignals.lessons, { observed: 2, leftOut: { "no-data-state": 1 } });
    } finally {
      dispose(rig);
    }
  }
});

/* The measure: the failures of the final execution that show DEV's data differing from what the pack read. */
const SETTLED = { inFlight: 0, treeStable: true };
const withPackRead = (extra: Rig["extra"]): Rig["extra"] => ({ ...extra, preGenerationGrounding: { ground: async () => ({ pageReads: [READ], packConfirmedDataRoutes: [{ path: "/shops/madrid", resultCount: 3 }] }) } });

test("the run records, by page, the failures of its final execution that read DEV's data differently from the pack, and an empty list when it executed and had none", async () => {
  const caseAt = (over: Partial<QaCase>): QaCase => ({ name: "lists shops", status: "fail", file: "flows/shops.spec.ts", finalUrl: "https://dev.example/shops/madrid", failureSettle: SETTLED, ...over });
  const executing = (cases: QaCase[]) => (rig: Rig): void => {
    rig.extra = withPackRead(rig.extra);
    rig.execute = async () => ({ verdict: "fail", cases, logs: "" });
    rig.publish = async () => ({ outcome: "issue" });
  };
  /* Another count than the pack's: the run ends fail. */
  const other = await runWith(executing([caseAt({ failureResultCount: 1 })]));
  assert.equal(other.observed.result?.decision.verdict, "fail");
  assert.deepEqual(other.observed.saved[0]!.gateSignals.lessons?.dataStateFailures, [{ path: "/shops/madrid", count: 1 }]);
  /* An empty read on a page the pack read with results: the fix loop's triage ends the run E-PRECONDITION with no case left to read, so it carries no measure and not a zero. */
  const empty = await runWith(executing([caseAt({ failureResultCount: 0 })]));
  assert.equal(empty.observed.saved[0]!.errorClass, "E-PRECONDITION");
  assert.equal(empty.observed.saved[0]!.gateSignals.lessons?.dataStateFailures, undefined);

  const green = await runWith((rig) => { rig.extra = withPackRead(rig.extra); });
  assert.deepEqual(green.observed.saved[0]!.gateSignals.lessons?.dataStateFailures, []);
});

test("a run that never executed has not measured the failures: the signal carries none", async () => {
  const { observed } = await runWith((rig) => {
    rig.extra = withPackRead(rig.extra);
    rig.validate = async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] });
  });
  assert.equal(observed.result?.decision.verdict, "invalid");
  assert.equal(observed.saved[0]!.gateSignals.lessons?.dataStateFailures, undefined);
});

test("the failures the flows' run_spec calls met at a settled failure point count with those of the final execution, by page, and the pages the flows were given reach the lessons signal alone", async () => {
  const fanout = (signal: Record<string, unknown>) => (rig: Rig): void => {
    rig.execute = async () => ({ verdict: "fail", cases: [{ name: "lists shops", status: "fail", file: "flows/shops.spec.ts", finalUrl: "https://dev.example/shops/madrid", failureSettle: SETTLED, failureResultCount: 1 }], logs: "" });
    rig.publish = async () => ({ outcome: "issue" });
    rig.extra = {
      ...withPackRead(rig.extra),
      leadSidekicks: { coordinate: async (): Promise<CoordinateResult> => ({ action: "fanout", aggregated: { end: GENERATION_END.DELIVERED, specs: [RIG_SPEC], incompleteFlows: [] }, proposals: [], signal: { plan: "fanout", flows: 1, delivered: 1, incomplete: 0, ...signal } }) },
    };
  };
  const { observed } = await runWith(fanout({
    runSpecFailureReads: [{ path: "/shops/madrid", resultCount: 0 }, { path: "/shops/madrid", resultCount: 3 }, { path: "/shops/madrid", resultCount: 1 }, { path: "/home", resultCount: 0 }],
    specPages: [{ spec: "flows/shops.spec.ts", routes: ["/shops/madrid"] }],
  }));
  const signals = observed.saved[0]!.gateSignals;
  assert.deepEqual(signals.lessons?.dataStateFailures, [{ path: "/shops/madrid", count: 3 }], "the failed case and two calls' failure points (an empty read and another count) on a page the pack read with 3 results; a read of 3 differs from nothing");
  assert.deepEqual(signals.lessons?.specPages, [{ spec: "flows/shops.spec.ts", routes: ["/shops/madrid"] }]);
  assert.equal(signals.coordination?.runSpecFailureReads, undefined);
  assert.equal(signals.coordination?.specPages, undefined);
  const none = await runWith(fanout({}));
  assert.equal(none.observed.saved[0]!.gateSignals.lessons?.specPages, undefined);
});
