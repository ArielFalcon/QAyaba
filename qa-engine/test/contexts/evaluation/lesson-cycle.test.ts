/* The cycle measure on fixture campaigns: improved, not improved and unproven, and green never counts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CampaignRun, RunScore } from "@contexts/evaluation/domain/campaign-comparison.ts";
import { judgeLessonCycle, renderLessonCycleMarkdown } from "@contexts/evaluation/domain/lesson-cycle.ts";

const num = (name: string, value: number): RunScore => ({ name, value, dataType: "NUMERIC", polarity: "none", graderVersion: "4" });
let id = 0;
const arm = (lessons: "on" | "off" | "default", scores: Record<string, number>, replicate = 1): CampaignRun => ({
  runId: `r${(id += 1)}`, variant: { arm: "a", lessons }, replicate, scores: Object.entries(scores).map(([name, value]) => num(name, value)),
});

const FROZEN = { lessons_delivered: 0, data_state_failures: 3, calls_to_green: 2, mutation_kill_rate: 0.5, change_coverage_ratio: 0.8, defect_found: 1, spec_pass_rate: 0.4 };
const LEARNING = { lessons_delivered: 2, data_state_failures: 1, calls_to_green: 1.5, mutation_kill_rate: 0.5, change_coverage_ratio: 0.9, defect_found: 1, spec_pass_rate: 0.4 };

test("data-state failures lower, calls-to-green not higher and no guard lower is an improvement", () => {
  const cycle = judgeLessonCycle([arm("off", FROZEN), arm("on", LEARNING)]);
  assert.equal(cycle.verdict, "improved");
  assert.deepEqual(cycle.measures.map((m) => [m.name, m.direction]), [
    ["data_state_failures", "better"], ["calls_to_green", "better"], ["mutation_kill_rate", "same"], ["change_coverage_ratio", "better"], ["defect_found", "same"],
  ]);
  assert.equal(judgeLessonCycle([arm("default", FROZEN), arm("on", LEARNING)]).verdict, "improved", "a campaign run that sets no lever is a frozen arm");
});

test("a counted cycle where the failures are not lower, the calls are higher or a guard is lower is not an improvement, each said", () => {
  const same = judgeLessonCycle([arm("off", FROZEN), arm("on", { ...LEARNING, data_state_failures: 3 })]);
  assert.equal(same.verdict, "not-improved");
  assert.match(same.reasons[0]!, /data-state failures are not lower/);
  const slower = judgeLessonCycle([arm("off", FROZEN), arm("on", { ...LEARNING, calls_to_green: 4 })]);
  assert.equal(slower.verdict, "not-improved");
  assert.match(slower.reasons.join(), /calls-to-green are higher/);
  for (const guard of ["mutation_kill_rate", "change_coverage_ratio", "defect_found"]) {
    const worse = judgeLessonCycle([arm("off", FROZEN), arm("on", { ...LEARNING, [guard]: 0 })]);
    assert.equal(worse.verdict, "not-improved", guard);
    assert.match(worse.reasons.join(), new RegExp(`${guard} is lower`));
  }
});

test("green never counts: a learning arm that passes more and fails no less is not improved, and one that fails more but reads less data-state failure is", () => {
  const greener = judgeLessonCycle([arm("off", { ...FROZEN, spec_pass_rate: 0.1 }), arm("on", { ...LEARNING, data_state_failures: 3, spec_pass_rate: 1 })]);
  assert.equal(greener.verdict, "not-improved");
  assert.equal(judgeLessonCycle([arm("off", { ...FROZEN, spec_pass_rate: 1 }), arm("on", { ...LEARNING, spec_pass_rate: 0 })]).verdict, "improved");
});

test("a cycle where no lesson was delivered, where nothing could go wrong, where the measure is missing or where an arm is missing is unproven", () => {
  assert.equal(judgeLessonCycle([arm("off", FROZEN), arm("on", { ...LEARNING, lessons_delivered: 0 })]).verdict, "unproven");
  const quiet = { data_state_failures: 0, calls_to_green: 1 };
  const calm = judgeLessonCycle([arm("off", { ...FROZEN, ...quiet }), arm("on", { ...LEARNING, ...quiet })]);
  assert.equal(calm.verdict, "unproven");
  assert.match(calm.reasons[0]!, /neither arm shows a data-state failure/);
  const { data_state_failures: _dropped, ...unmeasured } = LEARNING;
  assert.equal(judgeLessonCycle([arm("off", FROZEN), arm("on", unmeasured)]).verdict, "unproven");
  assert.equal(judgeLessonCycle([arm("on", LEARNING)]).verdict, "unproven");
  assert.equal(judgeLessonCycle([arm("off", FROZEN)]).verdict, "unproven");
});

test("a spec that needed more than one call is a trigger even when no data-state failure shows, and the arms are averaged over their replicates", () => {
  const trigger = judgeLessonCycle([arm("off", { ...FROZEN, data_state_failures: 0, calls_to_green: 2 }), arm("on", { ...LEARNING, data_state_failures: 0 })]);
  assert.equal(trigger.verdict, "not-improved", "counted, and the failures are not lower (0 against 0)");
  const averaged = judgeLessonCycle([arm("off", { ...FROZEN, data_state_failures: 4 }, 1), arm("off", { ...FROZEN, data_state_failures: 2 }, 2), arm("on", LEARNING, 1)]);
  assert.equal(averaged.measures[0]!.frozen, 3);
  assert.equal(averaged.verdict, "improved");
});

test("the section states the verdict, why and each measure", () => {
  const text = renderLessonCycleMarkdown(judgeLessonCycle([arm("off", FROZEN), arm("on", { ...LEARNING, data_state_failures: 3 })]));
  assert.match(text, /^## Lesson cycle/);
  assert.match(text, /Verdict: \*\*not improved: a counted cycle without improvement/);
  assert.match(text, /\| data_state_failures \| 3 \| 3 \| same \|/);
});
