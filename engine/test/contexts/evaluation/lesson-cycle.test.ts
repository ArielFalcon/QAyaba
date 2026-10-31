/* The cycle measure on fixture campaigns: a cycle is one frozen and one learning replicate of the same commit and snapshot, measured over the pages the lessons cover; improved, not improved and unproven, and green never counts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CampaignRun, RunScore } from "@contexts/evaluation/domain/campaign-comparison.ts";
import { judgeLessonCycle, renderLessonCycleMarkdown } from "@contexts/evaluation/domain/lesson-cycle.ts";
import { LESSON_SLICE_SCORE, encodeLessonSlice, type LessonSlice } from "@contexts/evaluation/domain/lesson-slice.ts";

const num = (name: string, value: number, graderVersion = "4"): RunScore => ({ name, value, dataType: "NUMERIC", polarity: "none", graderVersion });
const GUARDS = { mutation_kill_rate: 0.5, change_coverage_ratio: 0.8, defect_found: 1 };
let id = 0;

interface Spec {
  commit?: string;
  replicate?: number;
  snapshot?: string | undefined;
  labels?: Record<string, string>;
  scopes?: string[];
  failures?: Array<{ path: string; count: number }> | null;
  specs?: Array<{ routes: string[]; calls: number }>;
  /* The scores besides the slice; a guard left out is not scored. */
  scores?: Record<string, number>;
  slice?: false;
}

function run(lessons: "on" | "off" | "default", over: Spec = {}): CampaignRun {
  const slice: LessonSlice = { commit: over.commit ?? "c1", scopes: over.scopes ?? [], failures: over.failures === undefined ? [] : over.failures, specs: over.specs ?? [] };
  return {
    runId: `r${(id += 1)}`, variant: { arm: "a", ...over.labels, lessons }, replicate: over.replicate ?? 1,
    ...("snapshot" in over ? { snapshot: over.snapshot } : { snapshot: "snap-1" }),
    scores: [
      ...Object.entries(over.scores ?? GUARDS).map(([name, value]) => num(name, value)),
      ...(over.slice === false ? [] : [{ name: LESSON_SLICE_SCORE, value: encodeLessonSlice(slice), dataType: "CATEGORICAL" as const, polarity: "none" as const, graderVersion: "4" }]),
    ],
  };
}

const SHOPS = ["/shops/madrid"];
const frozen = (over: Spec = {}): CampaignRun => run("off", { failures: [{ path: "/shops/madrid", count: 3 }], specs: [{ routes: SHOPS, calls: 2 }], ...over });
const learning = (over: Spec = {}): CampaignRun => run("on", { scopes: SHOPS, failures: [{ path: "/shops/madrid", count: 1 }], specs: [{ routes: SHOPS, calls: 1.5 }], scores: { ...GUARDS, change_coverage_ratio: 0.9 }, ...over });

test("data-state failures lower, calls-to-green not higher and no guard lower, over the covered pages, is an improvement", () => {
  const cycle = judgeLessonCycle([frozen(), learning()]);
  assert.equal(cycle.verdict, "improved");
  assert.equal(cycle.pairs.length, 1);
  assert.deepEqual(cycle.pairs[0]!.measures.map((m) => [m.name, m.direction]), [
    ["data_state_failures", "better"], ["calls_to_green", "better"], ["mutation_kill_rate", "same"], ["change_coverage_ratio", "better"], ["defect_found", "same"],
  ]);
  assert.equal(judgeLessonCycle([run("default", { failures: [{ path: "/shops/madrid", count: 3 }], specs: [{ routes: SHOPS, calls: 2 }] }), learning()]).verdict, "improved", "a campaign run that sets no lever is a frozen arm");
});

test("failures are counted over the pages the lessons cover: a page with no lesson is neither a win nor a loss", () => {
  /* The lesson is for /shops/madrid: the frozen replicate failed once there, the learning one not at all there and twice on /orders, which has no lesson. */
  const cycle = judgeLessonCycle([
    frozen({ failures: [{ path: "/shops/madrid", count: 1 }] }),
    learning({ failures: [{ path: "/orders", count: 2 }] }),
  ]);
  assert.equal(cycle.verdict, "improved");
  assert.deepEqual(cycle.pairs[0]!.measures[0], { name: "data_state_failures", frozen: 1, learning: 0, direction: "better" });
  /* The other way round: a failure of the learning replicate on a page with a lesson counts against it. */
  const worse = judgeLessonCycle([frozen({ failures: [{ path: "/shops/madrid", count: 1 }, { path: "/orders", count: 5 }] }), learning({ failures: [{ path: "/shops/madrid", count: 2 }] })]);
  assert.equal(worse.verdict, "not-improved");
  assert.deepEqual(worse.pairs[0]!.measures[0], { name: "data_state_failures", frozen: 1, learning: 2, direction: "worse" });
});

test("a lesson on a template of the map covers the pages that fill it, and a flow is covered by the pages it was given", () => {
  const cycle = judgeLessonCycle([
    frozen({ failures: [{ path: "/shops/madrid", count: 2 }, { path: "/shops/madrid/extra", count: 9 }], specs: [{ routes: ["/shops/madrid"], calls: 3 }, { routes: ["/orders"], calls: 9 }] }),
    learning({ scopes: ["/shops/:city"], failures: [{ path: "/shops/valencia", count: 1 }], specs: [{ routes: ["/shops/:city"], calls: 1 }, { routes: ["/orders"], calls: 1 }] }),
  ]);
  assert.deepEqual(cycle.pairs[0]!.measures.slice(0, 2).map((m) => [m.frozen, m.learning]), [[2, 1], [3, 1]]);
  assert.equal(cycle.verdict, "improved");
});

test("a counted cycle where the failures are not lower, the calls are higher or a guard is lower is not an improvement, each said", () => {
  const same = judgeLessonCycle([frozen(), learning({ failures: [{ path: "/shops/madrid", count: 3 }] })]);
  assert.equal(same.verdict, "not-improved");
  assert.match(same.reasons.join(), /data-state failures on the covered pages are not lower/);
  const slower = judgeLessonCycle([frozen(), learning({ specs: [{ routes: SHOPS, calls: 4 }] })]);
  assert.equal(slower.verdict, "not-improved");
  assert.match(slower.reasons.join(), /calls-to-green are higher/);
  for (const guard of ["mutation_kill_rate", "change_coverage_ratio", "defect_found"]) {
    const worse = judgeLessonCycle([frozen(), learning({ scores: { ...GUARDS, [guard]: 0 } })]);
    assert.equal(worse.verdict, "not-improved", guard);
    assert.match(worse.reasons.join(), new RegExp(`${guard} is lower`));
  }
});

test("green never counts: a learning replicate that passes more and fails no less is not improved, and one that fails more but reads less data-state failure is", () => {
  const greener = judgeLessonCycle([frozen({ scores: { ...GUARDS, spec_pass_rate: 0.1 } }), learning({ failures: [{ path: "/shops/madrid", count: 3 }], scores: { ...GUARDS, spec_pass_rate: 1 } })]);
  assert.equal(greener.verdict, "not-improved");
  assert.equal(judgeLessonCycle([frozen({ scores: { ...GUARDS, spec_pass_rate: 1 } }), learning({ scores: { ...GUARDS, spec_pass_rate: 0 } })]).verdict, "improved");
});

test("no lesson delivered, nothing that could go wrong on the covered pages, an unmeasured arm or a missing arm is unproven", () => {
  const nothing = judgeLessonCycle([frozen(), learning({ scopes: [] })]);
  assert.equal(nothing.verdict, "unproven");
  assert.equal(nothing.pairs[0]!.status, "not-counted");
  const quiet = { failures: [], specs: [{ routes: SHOPS, calls: 1 }] };
  const calm = judgeLessonCycle([frozen(quiet), learning(quiet)]);
  assert.equal(calm.verdict, "unproven");
  assert.match(calm.reasons[0]!, /neither replicate shows a data-state failure/);
  /* Failures elsewhere do not trigger a cycle about the covered pages. */
  assert.equal(judgeLessonCycle([frozen({ ...quiet, failures: [{ path: "/orders", count: 4 }] }), learning(quiet)]).verdict, "unproven");
  const unmeasured = judgeLessonCycle([frozen(), learning({ failures: null })]);
  assert.equal(unmeasured.verdict, "unproven");
  assert.equal(unmeasured.pairs[0]!.status, "invalid");
  assert.match(unmeasured.reasons.join(), /not measured in the learning replicate/);
  assert.equal(judgeLessonCycle([learning()]).verdict, "unproven");
  assert.equal(judgeLessonCycle([frozen()]).verdict, "unproven");
});

test("a spec on the covered pages that went green in one replicate only cannot be compared", () => {
  const cycle = judgeLessonCycle([frozen(), learning({ specs: [{ routes: ["/orders"], calls: 1 }] })]);
  assert.equal(cycle.verdict, "unproven");
  assert.match(cycle.reasons.join(), /went green in the frozen replicate only/);
});

test("a spec that needed more than one call is a trigger even when no data-state failure shows", () => {
  const trigger = judgeLessonCycle([frozen({ failures: [] }), learning({ failures: [] })]);
  assert.equal(trigger.verdict, "not-improved", "counted, and the failures are not lower (0 against 0)");
});

test("cycles are pairs judged each on its own: runs that pair with nothing or an invalid pair are listed and decide nothing, and no counted pair leaves the campaign unproven", () => {
  const x = [frozen({ commit: "cX" }), learning({ commit: "cX" })];
  /* Commit Y: its learning run has no slice (graded before grader version 4, or no lessons signal). */
  const y = [frozen({ commit: "cY" }), learning({ commit: "cY", slice: false })];
  const cycle = judgeLessonCycle([...x, ...y]);
  assert.equal(cycle.verdict, "improved");
  assert.equal(cycle.pairs.length, 1);
  assert.equal(cycle.unpaired.length, 2, "the unmeasured run and the frozen run of its commit make no cycle");
  assert.match(cycle.reasons.join(), /pair with nothing/);
  assert.equal(judgeLessonCycle([...y, frozen({ commit: "cZ" }), learning({ commit: "cZ" })]).pairs.length, 1);
  assert.equal(judgeLessonCycle(y).verdict, "unproven", "no counted pair");
  /* Every pair measured: the pairs decide, each on its own commit. */
  assert.equal(judgeLessonCycle([...x, frozen({ commit: "cY" }), learning({ commit: "cY" })]).verdict, "improved");
  const failing = judgeLessonCycle([...x, frozen({ commit: "cY" }), learning({ commit: "cY", failures: [{ path: "/shops/madrid", count: 3 }] })]);
  assert.equal(failing.verdict, "not-improved");
  assert.match(failing.reasons.join(), /^cY replicate 1:/);
});

test("a counted pair without improvement decides the campaign whatever else is unpaired or invalid, and an improved one whatever else cannot be paired", () => {
  const notImproved = [frozen(), learning({ failures: [{ path: "/shops/madrid", count: 3 }] })];
  const invalidPair = [frozen({ commit: "c2" }), learning({ commit: "c2", failures: null })];
  const withInvalid = judgeLessonCycle([...notImproved, ...invalidPair]);
  assert.equal(withInvalid.verdict, "not-improved");
  assert.equal(withInvalid.pairs.find((p) => p.commit === "c2")!.status, "invalid");
  assert.match(withInvalid.reasons.join(), /c2 replicate 1: the data-state failures were not measured/, "the invalid pair is still listed");
  assert.equal(judgeLessonCycle([...notImproved, frozen({ replicate: 2 })]).verdict, "not-improved", "an extra frozen replicate");
  assert.equal(judgeLessonCycle([frozen(), learning(), learning({ snapshot: "snap-2" })]).verdict, "improved", "a continuation with another digest pairs with nothing");
  assert.equal(judgeLessonCycle([frozen(), learning(), learning({ snapshot: "snap-2" })]).unpaired.length, 1);
});

test("runs pair only on the same commit, snapshot, replicate and every other label; several runs for one arm of a pair make no cycle", () => {
  for (const [name, other] of [
    ["commit", learning({ commit: "c2" })],
    ["snapshot", learning({ snapshot: "snap-2" })],
    ["snapshot unknown on one side", learning({ snapshot: undefined })],
    ["replicate", learning({ replicate: 2 })],
    ["another label", learning({ labels: { closedLoop: "off" } })],
  ] as const) {
    const cycle = judgeLessonCycle([frozen(), other]);
    assert.equal(cycle.verdict, "unproven", name);
    assert.equal(cycle.pairs.length, 0, name);
  }
  const twice = judgeLessonCycle([frozen(), learning(), learning()]);
  assert.equal(twice.verdict, "unproven");
  assert.equal(twice.pairs.length, 0);
  assert.equal(twice.unpaired.length, 3);
  assert.equal(judgeLessonCycle([frozen({ replicate: 2 }), learning({ replicate: 2 }), frozen(), learning()]).pairs.length, 2, "replicates of one commit are cycles of their own");
});

test("a guard scored in one replicate only, or by two grader versions, is unproven and named, not read as 'no guard is lower'", () => {
  const { mutation_kill_rate: _dropped, ...withoutKills } = GUARDS;
  const one = judgeLessonCycle([frozen(), learning({ scores: { ...withoutKills, change_coverage_ratio: 0.9 } })]);
  assert.equal(one.verdict, "unproven");
  assert.match(one.reasons.join(), /mutation_kill_rate is scored in the frozen replicate only, so whether a guard is lower cannot be told/);
  assert.doesNotMatch(one.reasons.join(), /no guard is lower/);
  const versions = learning();
  const broken = { ...versions, scores: versions.scores.map((s) => (s.name === "defect_found" ? { ...s, graderVersion: "5" } : s)) };
  const cycle = judgeLessonCycle([frozen(), broken]);
  assert.equal(cycle.verdict, "unproven");
  assert.match(cycle.reasons.join(), /defect_found was graded by different grader versions in the two replicates/);
  /* A guard neither replicate scored is not applicable, and the verdict says only what was measured. */
  const neither = judgeLessonCycle([frozen({ scores: withoutKills }), learning({ scores: { ...withoutKills, change_coverage_ratio: 0.9 } })]);
  assert.equal(neither.verdict, "improved");
  assert.match(neither.reasons.join(), /no measured guard is lower/);
});

test("the section states the verdict, why and each pair's measures", () => {
  const text = renderLessonCycleMarkdown(judgeLessonCycle([frozen(), learning({ failures: [{ path: "/shops/madrid", count: 3 }] })]));
  assert.match(text, /^## Lesson cycle/);
  assert.match(text, /Verdict: \*\*not improved: a counted cycle without improvement/);
  assert.match(text, /### c1, replicate 1: not-improved/);
  assert.match(text, /\| data_state_failures \| 3 \| 3 \| same \|/);
});
