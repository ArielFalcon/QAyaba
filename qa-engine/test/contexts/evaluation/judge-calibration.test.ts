import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CALIBRATION, calibrate, splitOfRun, type LabeledPair } from "@contexts/evaluation/domain/judge-calibration.ts";
import { ROOT_CAUSE_CATEGORIES, judgeDefinition } from "@contexts/evaluation/domain/judges.ts";

const relevance = judgeDefinition("spec_relevance");
const rootCause = judgeDefinition("failure_root_cause");
const AT = "2026-10-18T00:00:00.000Z";
const by = { promptVersion: "1", model: "m", computedAt: AT };

/* Run ids that fall in the test split, found by the function under a different name each time so the fixtures never assume its hash. */
function idsIn(split: "train" | "dev" | "test", n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (splitOfRun(`run-${i}`) === split) out.push(`run-${i}`);
  return out;
}

function binaryPairs(ids: string[], plan: Array<[human: boolean, judge: boolean]>): LabeledPair[] {
  return plan.map(([human, judge], i) => ({ runId: ids[i]!, human, judge }));
}

const times = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

test("the split of a run is a pure function of its id, and the three splits are all used", () => {
  assert.equal(splitOfRun("run-42"), splitOfRun("run-42"));
  const seen = new Set(Array.from({ length: 200 }, (_, i) => splitOfRun(`run-${i}`)));
  assert.deepEqual([...seen].sort(), ["dev", "test", "train"]);
});

test("only the TEST split decides: a judge perfect on train and dev but wrong on test is experimental", () => {
  const train = idsIn("train", 40);
  const test_ = idsIn("test", 40);
  const pairs = [
    ...binaryPairs(train, [...times(20, [true, true] as [boolean, boolean]), ...times(20, [false, false] as [boolean, boolean])]),
    ...binaryPairs(test_, [...times(20, [true, false] as [boolean, boolean]), ...times(20, [false, true] as [boolean, boolean])]),
  ];
  const report = calibrate(relevance, pairs, by);
  assert.equal(report.status, "experimental");
  assert.equal(report.tpr, 0);
  assert.equal(report.tnr, 0);
  assert.equal(report.splits.train.n, 40);
  assert.equal(report.splits.test.n, 40);
});

test("a judge whose TPR and TNR reach the thresholds on the test split with enough of each class is calibrated", () => {
  const ids = idsIn("test", 50);
  // 25 humans say pass: judge agrees on 22 (TPR .88). 25 say fail: judge agrees on 21 (TNR .84).
  const plan = [...times(22, [true, true]), ...times(3, [true, false]), ...times(21, [false, false]), ...times(4, [false, true])] as Array<[boolean, boolean]>;
  const report = calibrate(relevance, binaryPairs(ids, plan), by);
  assert.equal(report.status, "calibrated");
  assert.ok(Math.abs((report.tpr ?? 0) - 22 / 25) < 1e-9);
  assert.ok(Math.abs((report.tnr ?? 0) - 21 / 25) < 1e-9);
  assert.ok(Math.abs((report.agreement ?? 0) - 43 / 50) < 1e-9);
  assert.equal(report.splits.test.n, 50);
});

test("the thresholds are inclusive and configurable", () => {
  const ids = idsIn("test", 40);
  // TPR exactly 16/20 = .8, TNR exactly .8.
  const plan = [...times(16, [true, true]), ...times(4, [true, false]), ...times(16, [false, false]), ...times(4, [false, true])] as Array<[boolean, boolean]>;
  assert.equal(calibrate(relevance, binaryPairs(ids, plan), by).status, "calibrated");
  assert.equal(calibrate(relevance, binaryPairs(ids, plan), { ...by, thresholds: { ...DEFAULT_CALIBRATION, minTpr: 0.85 } }).status, "experimental");
});

test("fewer than the minimum labels in either class keeps a judge experimental even when it is perfect", () => {
  const ids = idsIn("test", 40);
  const few = [...times(19, [true, true]), ...times(21, [false, false])] as Array<[boolean, boolean]>;
  const report = calibrate(relevance, binaryPairs(ids, few), by);
  assert.equal(report.status, "experimental");
  assert.match(report.reasons.join(" "), /19/);
  assert.equal(calibrate(relevance, binaryPairs(ids, few), { ...by, thresholds: { ...DEFAULT_CALIBRATION, minN: 19 } }).status, "calibrated");
});

test("with no labels the report is experimental, has no rates, and says so", () => {
  const report = calibrate(relevance, [], by);
  assert.equal(report.status, "experimental");
  assert.equal(report.tpr, null);
  assert.equal(report.tnr, null);
  assert.equal(report.agreement, null);
});

test("a pair whose values do not fit the judge's type is ignored, not counted", () => {
  const ids = idsIn("test", 2);
  const pairs: LabeledPair[] = [
    { runId: ids[0]!, human: "yes", judge: true },
    { runId: ids[1]!, human: true, judge: "selector" },
  ];
  assert.equal(calibrate(relevance, pairs, by).splits.test.n, 0);
});

test("a categorical judge is calibrated one-vs-rest over the classes the humans used, each with enough labels", () => {
  const ids = idsIn("test", 60);
  const classes = ["selector", "timeout", "auth"];
  const pairs: LabeledPair[] = ids.map((runId, i) => {
    const human = classes[i % 3]!;
    // the judge is right on 17 of every 20 and confuses selector with timeout otherwise
    const right = i % 20 < 17;
    return { runId, human, judge: right ? human : human === "selector" ? "timeout" : "selector" };
  });
  const report = calibrate(rootCause, pairs, by);
  assert.equal(report.status, "calibrated");
  assert.deepEqual(report.perClass?.map((c) => c.class).sort(), ["auth", "selector", "timeout"]);
  assert.ok((report.tpr ?? 0) >= 0.8 && (report.tnr ?? 0) >= 0.8);
});

test("a categorical judge with a class the humans used fewer times than the minimum stays experimental and names the class", () => {
  const ids = idsIn("test", 45);
  const pairs: LabeledPair[] = ids.map((runId, i) => {
    const human = i < 22 ? "selector" : i < 44 ? "timeout" : "egress";
    return { runId, human, judge: human };
  });
  const report = calibrate(rootCause, pairs, by);
  assert.equal(report.status, "experimental");
  assert.match(report.reasons.join(" "), /egress/);
});

test("a categorical judge's answer outside the closed set counts as wrong and never as a class", () => {
  const ids = idsIn("test", 2);
  const report = calibrate(rootCause, [{ runId: ids[0]!, human: ROOT_CAUSE_CATEGORIES[0], judge: "made_up" }, { runId: ids[1]!, human: "made_up", judge: "made_up" }], by);
  assert.equal(report.splits.test.n, 1);
  assert.equal(report.agreement, 0);
});
