/* A data-state failure is a failed case whose settled failure point shows DEV's data differing from what the pack read of the same page; the run records them per page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { QaCase } from "@kernel/qa-case.ts";
import { dataStateFailuresOf, dataStateFailuresOfReads, mergeDataStateFailures } from "@contexts/run-orchestration/domain/failure-data-state.ts";

const failed = (over: Partial<QaCase> = {}): QaCase => ({ name: "lists", status: "fail", file: "flows/a.spec.ts", ...over });
const SETTLED = { inFlight: 0, treeStable: true };
const PACK = [{ path: "/restaurants", resultCount: 3 }, { path: "/orders", resultCount: 2 }];

test("a failed case whose settled failure point read an empty state on a page the pack read with results is recorded on that page", () => {
  const cases = [failed({ failureResultCount: 0, finalUrl: "https://dev/restaurants?q=a", failureSettle: SETTLED })];
  assert.deepEqual(dataStateFailuresOf(cases, PACK), [{ path: "/restaurants", count: 1 }]);
});

test("a count other than the pack's counts too, and a page's failures add up", () => {
  const cases = [
    failed({ failureResultCount: 1, finalUrl: "https://dev/restaurants", failureSettle: SETTLED }),
    failed({ name: "again", failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: SETTLED }),
    failed({ name: "orders", failureResultCount: 0, finalUrl: "https://dev/orders", failureSettle: SETTLED }),
  ];
  assert.deepEqual(dataStateFailuresOf(cases, PACK), [{ path: "/orders", count: 1 }, { path: "/restaurants", count: 2 }]);
});

test("a failure on a page still changing, with no data state, with no pack evidence for its page, or of a case that passed is not recorded", () => {
  const cases = [
    failed({ failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: { inFlight: 1, treeStable: true } }),
    failed({ finalUrl: "https://dev/restaurants", failureSettle: SETTLED }),
    failed({ failureResultCount: 0, finalUrl: "https://dev/elsewhere", failureSettle: SETTLED }),
    failed({ failureResultCount: 0, failureSettle: SETTLED }),
    failed({ status: "pass", failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: SETTLED }),
  ];
  assert.deepEqual(dataStateFailuresOf(cases, PACK), []);
  assert.deepEqual(dataStateFailuresOf([failed({ failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: SETTLED })], undefined), []);
});

test("a flaky case whose first attempt failed this way is a data-state failure too", () => {
  const flaky = failed({ status: "flaky", failureResultCount: 0, finalUrl: "https://dev/orders", failureSettle: SETTLED });
  assert.deepEqual(dataStateFailuresOf([flaky], PACK), [{ path: "/orders", count: 1 }]);
});

test("a failing run_spec test is read the same way: its settled failure point against the pack, by page", () => {
  const reads = [
    { path: "/restaurants", resultCount: 0 },
    { path: "/restaurants", resultCount: 1 },
    { path: "/restaurants", resultCount: 3 },
    { path: "/orders", resultCount: 0 },
    { path: "/elsewhere", resultCount: 0 },
  ];
  assert.deepEqual(dataStateFailuresOfReads(reads, PACK), [{ path: "/orders", count: 1 }, { path: "/restaurants", count: 2 }]);
  assert.deepEqual(dataStateFailuresOfReads(reads, undefined), []);
  assert.deepEqual(dataStateFailuresOfReads([], PACK), []);
});

test("the failures of the final execution and of the run_spec calls add up by page", () => {
  assert.deepEqual(
    mergeDataStateFailures([{ path: "/orders", count: 1 }], [{ path: "/orders", count: 2 }, { path: "/a", count: 1 }]),
    [{ path: "/a", count: 1 }, { path: "/orders", count: 3 }],
  );
  assert.deepEqual(mergeDataStateFailures([], []), []);
});
