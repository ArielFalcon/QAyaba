/* Recording what a run read of DEV and deriving lessons from what earlier runs recorded, through the use cases' public seam. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PageDataRead } from "@kernel/page-data-read.ts";
import { DeriveLessons, RecordLessonObservations, type LessonObservation, type LessonStorePort } from "@contexts/cross-run-learning/application/index.ts";

function memoryStore(): LessonStorePort & { rows: LessonObservation[] } {
  const rows: LessonObservation[] = [];
  return {
    rows,
    record: async (batch) => { rows.push(...batch); },
    listAdmitted: async ({ app, scopes, before }) => rows.filter((r) => r.app === app && r.admitted && scopes.includes(r.scope) && r.at < before),
  };
}

const page = (scope: string, over: Partial<PageDataRead> = {}): PageDataRead => ({ scope, grounded: true, dataState: true, unconfirmed: false, resultCount: 2, ready: true, ...over });
const run = (over: Partial<Parameters<RecordLessonObservations["record"]>[0]> = {}): Parameters<RecordLessonObservations["record"]>[0] => ({
  app: "demo", runId: "run-1", sha: "abc1234", repo: "org/demo", servedState: "equal", at: "2026-10-30T10:00:00.000Z", reads: [page("/shops")], ...over,
});

test("every read of a run is recorded, admitted or left out with its typed reason, and the tally counts them by reason", async () => {
  const store = memoryStore();
  const tally = await new RecordLessonObservations(store).record(run({
    reads: [page("/shops"), page("/offers", { resultCount: 0, emptyConfirmed: true }), page("/home", { dataState: undefined }), page("/gone", { grounded: false }), page("/slow", { unconfirmed: true, resultCount: 0 })],
  }));
  assert.deepEqual(store.rows.map((r) => [r.scope, r.admitted, r.leftOutReason]), [
    ["/shops", true, null],
    ["/offers", true, null],
    ["/home", false, "no-data-state"],
    ["/gone", false, "not-captured"],
    ["/slow", false, "unconfirmed-read"],
  ]);
  assert.deepEqual(tally, { observed: 5, leftOut: { "no-data-state": 1, "not-captured": 1, "unconfirmed-read": 1 } });
  assert.equal(new Set(store.rows.map((r) => r.id)).size, 5, "one row per read");
  assert.deepEqual(store.rows[1]!.fact, { resultCount: 0, emptyConfirmed: true, ready: true });
});

test("a run whose DEV served another commit leaves every read out under the served-version state", async () => {
  const store = memoryStore();
  const tally = await new RecordLessonObservations(store).record(run({ servedState: "undeclared", reads: [page("/a"), page("/b")] }));
  assert.deepEqual(tally, { observed: 2, leftOut: { "served-version:undeclared": 2 } });
  assert.ok(store.rows.every((r) => r.servedState === "undeclared" && !r.admitted));
});

test("a run that read no page records nothing and says so with a zero tally", async () => {
  const store = memoryStore();
  assert.deepEqual(await new RecordLessonObservations(store).record(run({ reads: [] })), { observed: 0, leftOut: {} });
  assert.deepEqual(store.rows, []);
});

test("lessons are derived from the rows recorded strictly before the run's start, for the scopes asked, and identical rows give identical lessons", async () => {
  const store = memoryStore();
  const recorder = new RecordLessonObservations(store);
  await recorder.record(run({ runId: "r1", at: "2026-10-29T10:00:00.000Z", reads: [page("/shops")] }));
  await recorder.record(run({ runId: "r2", at: "2026-10-29T11:00:00.000Z", reads: [page("/shops", { resultCount: 0, emptyConfirmed: true }), page("/other")] }));
  await recorder.record(run({ runId: "r3", at: "2026-10-30T10:00:00.000Z", reads: [page("/shops", { resultCount: 0, emptyConfirmed: true })] }));
  const derive = new DeriveLessons(store);
  const before = "2026-10-30T10:00:00.000Z";
  const first = await derive.derive({ app: "demo", scopes: ["/shops", "/other"], before });
  assert.deepEqual(first.map((l) => [l.scope, l.withResults, l.emptyConfirmed, l.evidence]), [["/shops", 1, 1, ["r1", "r2"]]]);
  assert.deepEqual(await derive.derive({ app: "demo", scopes: ["/shops", "/other"], before }), first);
  assert.deepEqual(await derive.derive({ app: "demo", scopes: ["/other"], before }), [], "only the scopes asked for");
  assert.deepEqual(await derive.derive({ app: "demo", scopes: [], before }), [], "no scope asked, no store read");
});
