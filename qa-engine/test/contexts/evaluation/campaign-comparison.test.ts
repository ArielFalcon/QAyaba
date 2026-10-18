import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComparisonError, armKey, bootstrapDiffCi, bootstrapMeanCi, compareCampaign, mean, renderComparisonMarkdown, seededRandom,
  type CampaignRun, type RunScore,
} from "@contexts/evaluation/domain/campaign-comparison.ts";

const score = (name: string, value: number | boolean | string, over: Partial<RunScore> = {}): RunScore => ({
  name, value, dataType: typeof value === "boolean" ? "BOOLEAN" : typeof value === "string" ? "CATEGORICAL" : "NUMERIC", polarity: "higher_better", graderVersion: "1", ...over,
});
let n = 0;
const run = (arm: string, replicate: number, scores: RunScore[]): CampaignRun => ({ runId: `r${(n += 1)}`, variant: { arm }, replicate, scores });
const arm = (name: string, values: number[], over: Partial<RunScore> = {}): CampaignRun[] => values.map((v, i) => run(name, i + 1, [score("spec_pass_rate", v, over)]));
const opts = { campaignId: "c", baseline: { arm: "control" }, iterations: 500 };

test("the seeded generator is deterministic and different seeds differ", () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(seededRandom(8)(), seededRandom(7)());
  const x = seededRandom(1)();
  assert.ok(x >= 0 && x < 1);
});

test("the bootstrap interval brackets the mean, collapses on constant data and is absent for one value", () => {
  const values = [0.2, 0.4, 0.6, 0.8, 1];
  const ci = bootstrapMeanCi(values, seededRandom(1), 1000)!;
  assert.ok(ci.low <= mean(values) && mean(values) <= ci.high);
  assert.ok(ci.low >= 0.2 && ci.high <= 1);
  assert.deepEqual(bootstrapMeanCi([3, 3, 3], seededRandom(1), 100), { low: 3, high: 3 });
  assert.equal(bootstrapMeanCi([1], seededRandom(1), 100), null);
  assert.equal(bootstrapDiffCi([1, 2], [1], seededRandom(1), 100), null);
});

test("the same runs and seed give the same report, and a different seed may move the interval but not the mean", () => {
  const runs = [...arm("control", [0.1, 0.3, 0.2, 0.4]), ...arm("treatment", [0.6, 0.8, 0.7, 0.9])];
  assert.deepEqual(compareCampaign(runs, opts), compareCampaign(runs, opts));
  const other = compareCampaign(runs, { ...opts, seed: 1 });
  assert.equal(other.scores[0]!.arms["arm=treatment"]!.mean, compareCampaign(runs, opts).scores[0]!.arms["arm=treatment"]!.mean);
});

test("a clear gap with three replicates a side is a lift, with the interval of the difference", () => {
  const cmp = compareCampaign([...arm("control", [0.1, 0.2, 0.15]), ...arm("treatment", [0.8, 0.9, 0.85])], opts);
  const diff = cmp.scores[0]!.versusBaseline["arm=treatment"]!;
  assert.equal(diff.assessment, "lift");
  assert.ok(diff.delta > 0.6 && diff.ci!.low > 0);
  assert.equal(cmp.baseline, "arm=control");
});

test("the same gap on fewer than three replicates is never called a lift", () => {
  const cmp = compareCampaign([...arm("control", [0.1, 0.2]), ...arm("treatment", [0.8, 0.9])], opts);
  assert.equal(cmp.scores[0]!.versusBaseline["arm=treatment"]!.assessment, "insufficient-replicates");
  const single = compareCampaign([...arm("control", [0.1]), ...arm("treatment", [0.9])], opts);
  assert.equal(single.scores[0]!.versusBaseline["arm=treatment"]!.assessment, "insufficient-replicates");
  assert.equal(single.scores[0]!.versusBaseline["arm=treatment"]!.ci, null);
});

test("overlapping arms show no detectable difference", () => {
  const cmp = compareCampaign([...arm("control", [0.1, 0.9, 0.5, 0.6]), ...arm("treatment", [0.2, 0.8, 0.55, 0.5])], opts);
  assert.equal(cmp.scores[0]!.versusBaseline["arm=treatment"]!.assessment, "no-detectable-difference");
});

test("polarity decides what is a lift: a drop in a lower-better score is one, a rise is a regression", () => {
  const lower = { polarity: "lower_better" as const };
  const down = compareCampaign([...arm("control", [10, 11, 12], lower), ...arm("treatment", [1, 2, 1], lower)], opts);
  assert.equal(down.scores[0]!.versusBaseline["arm=treatment"]!.assessment, "lift");
  const up = compareCampaign([...arm("control", [1, 2, 1], lower), ...arm("treatment", [10, 11, 12], lower)], opts);
  assert.equal(up.scores[0]!.versusBaseline["arm=treatment"]!.assessment, "regression");
  const none = { polarity: "none" as const };
  const shift = compareCampaign([...arm("control", [1, 2, 1], none), ...arm("treatment", [10, 11, 12], none)], opts);
  assert.equal(shift.scores[0]!.versusBaseline["arm=treatment"]!.assessment, "shift");
});

test("boolean scores average as pass rates and categorical ones are listed, not averaged", () => {
  const runs = [1, 2, 3].flatMap((rep) => [
    run("control", rep, [score("empty_output_guard", rep === 1), score("furthest_phase", "execute", { polarity: "none" })]),
    run("treatment", rep, [score("empty_output_guard", true), score("furthest_phase", "learn", { polarity: "none" })]),
  ]);
  const cmp = compareCampaign(runs, opts);
  assert.equal(cmp.scores.length, 1);
  assert.equal(cmp.scores[0]!.arms["arm=control"]!.mean, 1 / 3);
  assert.equal(cmp.scores[0]!.arms["arm=treatment"]!.mean, 1);
  assert.deepEqual(cmp.notAggregated, ["furthest_phase"]);
});

test("runs scored by an older grader version are left out and counted, never mixed in", () => {
  const runs = [...arm("control", [0.1, 0.2, 0.3]), run("control", 4, [score("spec_pass_rate", 0.99, { graderVersion: "0" })]), ...arm("treatment", [0.5, 0.6, 0.7], { graderVersion: "1" })];
  const s = compareCampaign(runs, opts).scores[0]!;
  assert.equal(s.graderVersion, "1");
  assert.equal(s.excluded, 1);
  assert.equal(s.arms["arm=control"]!.n, 3);
});

test("a run without the score is not an observation of it", () => {
  const runs = [...arm("control", [0.1, 0.2, 0.3]), ...arm("treatment", [0.5, 0.6, 0.7]), run("treatment", 4, [])];
  assert.equal(compareCampaign(runs, opts).scores[0]!.arms["arm=treatment"]!.n, 3);
});

test("the baseline must name exactly one arm", () => {
  const runs = [...arm("control", [1, 2, 3]), ...arm("treatment", [4, 5, 6])];
  assert.throws(() => compareCampaign(runs, { ...opts, baseline: { arm: "ghost" } }), ComparisonError);
  const two = [...runs, ...[1, 2, 3].map((r) => ({ runId: `z${r}`, variant: { arm: "treatment", model: "m2" }, replicate: r, scores: [score("spec_pass_rate", 1)] }))];
  assert.throws(() => compareCampaign(two, { ...opts, baseline: { arm: "treatment" } }), /match 2 arms/);
  assert.equal(compareCampaign(two, { ...opts, baseline: { arm: "treatment", model: "m2" } }).baseline, "arm=treatment,model=m2");
});

test("without a baseline there are no differences", () => {
  const cmp = compareCampaign([...arm("control", [1, 2, 3]), ...arm("treatment", [4, 5, 6])], { campaignId: "c" });
  assert.equal(cmp.baseline, null);
  assert.deepEqual(cmp.scores[0]!.versusBaseline, {});
});

test("arms are keyed by their labels in key order", () => {
  assert.equal(armKey({ b: "2", a: "1" }), "a=1,b=2");
  assert.equal(armKey({}), "(no variant)");
});

test("the markdown names the arms, the interval, the assessment and the engram confound, and warns when the campaign is incomplete", () => {
  const cmp = compareCampaign([...arm("control", [0.1, 0.2, 0.15]), ...arm("treatment", [0.8, 0.9, 0.85])], opts);
  const md = renderComparisonMarkdown(cmp, { complete: false });
  assert.match(md, /# Campaign c/);
  assert.match(md, /arm=control \(baseline\)/);
  assert.match(md, /\| lift \|/);
  assert.match(md, /engram/);
  assert.match(md, /not complete/);
  assert.doesNotMatch(renderComparisonMarkdown(cmp, { complete: true }), /not complete/);
});

test("three values that are all replicate 1 are not three replicates, and the report says the count is a proxy without a paired analysis", () => {
  const same = (name: string, values: number[]) => values.map((v) => run(name, 1, [score("spec_pass_rate", v)]));
  const cmp = compareCampaign([...same("control", [0.1, 0.2, 0.15]), ...same("treatment", [0.8, 0.9, 0.85])], opts);
  assert.equal(cmp.scores[0]!.versusBaseline["arm=treatment"]!.assessment, "insufficient-replicates");
  const md = renderComparisonMarkdown(cmp);
  assert.match(md, /proxy/);
  assert.match(md, /no paired per-item analysis/);
});
