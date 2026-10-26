/* test/contexts/objective-signal/domain/fault-injection-score.test.ts
   The aimed scoring of the response oracle: a spec is exposed to a use case when a response of one of its operations was
   corrupted for it, and killed when it then failed for a reason other than the flow breaking.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreFaultInjection, isFlowBreak, FLOW_BREAK, operationKey, type FaultAim } from "@contexts/objective-signal/domain/fault-injection-score.ts";
import type { FaultCounterRecord } from "@contexts/objective-signal/domain/dump-sanitizers.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const ORDERS = operationKey({ verb: "get", pattern: "^/orders/[^/]+/?$" });
const ITEMS = operationKey({ verb: "GET", pattern: "^/items/?$" });

const AIM: FaultAim = {
  operations: [{ verb: "GET", pattern: "^/orders/[^/]+/?$" }, { verb: "GET", pattern: "^/items/?$" }],
  candidates: [{ candidateId: "uc-orders", operations: [ORDERS] }, { candidateId: "uc-items", operations: [ITEMS] }],
  specToCandidates: [{ specFile: "flows/orders.spec.ts", candidates: ["uc-orders"] }, { specFile: "flows/items.spec.ts", candidates: ["uc-items"] }],
};

const spec = (name: string, file: string, status: QaCase["status"], over: Partial<QaCase> = {}): QaCase => ({ name, status, file, ...over });
const counter = (test: string, byOperation: Record<string, number>): FaultCounterRecord => ({ corrupted: Object.values(byOperation).reduce((a, b) => a + b, 0), byOperation, test });

describe("scoreFaultInjection", () => {
  it("counts a kill for the use case whose operation was corrupted for the spec that failed, and for no other", () => {
    const r = scoreFaultInjection({
      baselinePass: ["orders", "items", "about"],
      corrupted: [spec("orders", "flows/orders.spec.ts", "fail", { detail: "expected 3 received -3" }), spec("items", "flows/items.spec.ts", "pass"), spec("about", "flows/about.spec.ts", "pass")],
      counters: [counter("flows/orders.spec.ts::orders", { [ORDERS]: 2 }), counter("flows/items.spec.ts::items", { [ITEMS]: 1 })],
      aim: AIM,
    });
    assert.deepEqual(r.perCandidate, [
      { candidateId: "uc-orders", exposed: 1, killed: 1, ratio: 1 },
      { candidateId: "uc-items", exposed: 1, killed: 0, ratio: 0 },
    ]);
    assert.deepEqual([r.exposed, r.killed, r.valueScore], [2, 1, 0.5]);
  });

  it("does not count a failure caused by the corruption breaking the flow as a kill", () => {
    const r = scoreFaultInjection({
      baselinePass: ["orders"],
      corrupted: [spec("orders", "flows/orders.spec.ts", "fail", { detail: "page.goto: net::ERR_CONNECTION_REFUSED" })],
      counters: [counter("flows/orders.spec.ts::orders", { [ORDERS]: 1 })],
      aim: AIM,
    });
    assert.deepEqual(r.perCandidate[0], { candidateId: "uc-orders", exposed: 1, killed: 0, ratio: 0 });
    assert.equal(r.valueScore, 0);
  });

  it("treats a spec that went flaky under corruption as having noticed it", () => {
    const r = scoreFaultInjection({ baselinePass: ["orders"], corrupted: [spec("orders", "flows/orders.spec.ts", "flaky")], counters: [counter("flows/orders.spec.ts::orders", { [ORDERS]: 1 })], aim: AIM });
    assert.equal(r.valueScore, 1);
  });

  it("leaves a use case whose specs never requested a reached operation with no ratio, and says so", () => {
    const r = scoreFaultInjection({
      baselinePass: ["orders", "items"],
      corrupted: [spec("orders", "flows/orders.spec.ts", "pass"), spec("items", "flows/items.spec.ts", "pass")],
      counters: [counter("flows/items.spec.ts::items", { [ITEMS]: 1 })],
      aim: AIM,
    });
    assert.deepEqual(r.perCandidate[0], { candidateId: "uc-orders", exposed: 0, killed: 0, ratio: null, unscored: "no-operation-hit" });
    assert.equal(r.perCandidate[1]!.ratio, 0);
    assert.deepEqual([r.exposed, r.valueScore], [1, 0]);
  });

  it("says no-spec for a use case no baseline-passing spec was written for, and inconclusive when its specs did not run or it names no operation", () => {
    const aim: FaultAim = { ...AIM, candidates: [...AIM.candidates, { candidateId: "uc-none", operations: [ORDERS] }, { candidateId: "uc-bare", operations: [] }], specToCandidates: [...AIM.specToCandidates, { specFile: "flows/bare.spec.ts", candidates: ["uc-bare"] }, { specFile: "flows/ran-not.spec.ts", candidates: ["uc-items-2"] }] };
    const r = scoreFaultInjection({ baselinePass: ["orders"], corrupted: [spec("orders", "flows/orders.spec.ts", "pass")], counters: [], aim });
    const by = Object.fromEntries(r.perCandidate.map((c) => [c.candidateId, c.unscored]));
    assert.equal(by["uc-none"], "no-spec");
    assert.equal(by["uc-bare"], "inconclusive");
    assert.equal(by["uc-items"], "inconclusive", "its spec was not in the corrupted run");
  });

  it("scores nothing for a run whose counters show no exposed spec", () => {
    const r = scoreFaultInjection({ baselinePass: ["orders"], corrupted: [spec("orders", "flows/orders.spec.ts", "fail")], counters: [], aim: AIM });
    assert.deepEqual([r.valueScore, r.exposed, r.killed], [null, 0, 0]);
  });

  it("matches a counter to its case by file and title even when the case name carries the groups above it", () => {
    const r = scoreFaultInjection({
      baselinePass: ["Orders > lists"],
      corrupted: [spec("Orders > lists", "flows/orders.spec.ts", "fail")],
      counters: [counter("e2e/flows/orders.spec.ts::lists", { [ORDERS]: 1 })],
      aim: AIM,
    });
    assert.equal(r.exposed, 1);
  });

  it("a baseline spec absent from the corrupted run is not exposed", () => {
    const r = scoreFaultInjection({ baselinePass: ["orders", "ghost"], corrupted: [spec("orders", "flows/orders.spec.ts", "fail")], counters: [counter("flows/orders.spec.ts::orders", { [ORDERS]: 1 })], aim: AIM });
    assert.equal(r.exposed, 1);
  });
});

describe("isFlowBreak / FLOW_BREAK", () => {
  it("matches a navigation/network flow-break signature", () => {
    assert.equal(isFlowBreak({ name: "a", status: "fail", detail: "page.goto: net::ERR_CONNECTION_REFUSED" }), true);
  });

  it("does not match a plain assertion timeout", () => {
    assert.equal(isFlowBreak({ name: "a", status: "fail", detail: "expect(locator).toBeVisible timed out" }), false);
  });

  it("checks both detail and reason fields", () => {
    assert.equal(isFlowBreak({ name: "a", status: "fail", reason: "ECONNREFUSED" }), true);
  });

  it("FLOW_BREAK is exported for direct inspection", () => {
    assert.ok(FLOW_BREAK instanceof RegExp);
  });
});
