import { test } from "node:test";
import assert from "node:assert/strict";
import type { QaCase } from "@kernel/qa-case.ts";
import { FLAKY_CLASS, classifyFlakyCase, triageFlaky } from "@contexts/run-orchestration/domain/flaky-triage.ts";

const flaky = (over: Partial<QaCase> = {}): QaCase => ({ name: "lists", status: "flaky", file: "flows/a.spec.ts", ...over });
const SETTLED = { inFlight: 0, treeStable: true };
const PACK = [{ path: "/restaurants", resultCount: 3 }];

test("a settled first attempt that read an empty data state on a page the pack read with results is DEV data instability", () => {
  assert.equal(classifyFlakyCase(flaky({ failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: SETTLED }), PACK), FLAKY_CLASS.DATA_INSTABILITY);
});

test("an empty data state with no pack evidence that the page has results is timing, not data instability", () => {
  assert.equal(classifyFlakyCase(flaky({ failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: SETTLED }), undefined), FLAKY_CLASS.TIMING);
  assert.equal(classifyFlakyCase(flaky({ failureResultCount: 0, finalUrl: "https://dev/other", failureSettle: SETTLED }), PACK), FLAKY_CLASS.TIMING);
  assert.equal(classifyFlakyCase(flaky({ failureResultCount: 0, failureSettle: SETTLED }), PACK), FLAKY_CLASS.TIMING);
});

test("a count other than the Context Pack read on the same page is DEV data instability", () => {
  assert.equal(classifyFlakyCase(flaky({ failureResultCount: 1, finalUrl: "https://dev/restaurants?q=a", failureSettle: SETTLED }), PACK), FLAKY_CLASS.DATA_INSTABILITY);
});

test("the pack's own count, no data state, or a page still changing is timing", () => {
  assert.equal(classifyFlakyCase(flaky({ failureResultCount: 3, finalUrl: "https://dev/restaurants", failureSettle: SETTLED }), PACK), FLAKY_CLASS.TIMING);
  assert.equal(classifyFlakyCase(flaky(), PACK), FLAKY_CLASS.TIMING);
  assert.equal(classifyFlakyCase(flaky({ failureResultCount: 0, failureSettle: { inFlight: 1, treeStable: true } }), PACK), FLAKY_CLASS.TIMING);
});

test("only the flaky cases are triaged, each with what its first attempt read", () => {
  const triage = triageFlaky([flaky({ failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: SETTLED }), { name: "ok", status: "pass" }, { name: "bad", status: "fail" }], PACK);
  assert.equal(triage.length, 1);
  assert.match(triage[0]!.evidence, /result count of 0/);
});
