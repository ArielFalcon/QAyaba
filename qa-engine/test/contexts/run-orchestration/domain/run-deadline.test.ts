import { test } from "node:test";
import assert from "node:assert/strict";
import { DEADLINE_PURPOSES } from "@kernel/deadline-purpose.ts";
import type { RunPhase } from "@kernel/run-step.ts";
import { RunDeadline, measuredPurposeDurations, type PhaseRecord } from "@contexts/run-orchestration/domain/run-deadline.ts";
import {
  RUN_TIME_BUDGET_ENV,
  RUN_TIME_BUDGET_KEYS,
  RUN_TIME_BUDGET_FORMER_ENV,
  RUN_TIME_BUDGET_FORMER_LABELS,
  RUN_TIME_BUDGET_MS,
  longestRunTimeBudgetMs,
  renderRunDeadlineNote,
  resolveRunTimeBudgets,
  runTimeBudgetKey,
} from "@contexts/run-orchestration/domain/run-time-budget.ts";

test("every kind of run has a finite default and its own variable", () => {
  for (const key of RUN_TIME_BUDGET_KEYS) {
    assert.ok(Number.isFinite(RUN_TIME_BUDGET_MS[key]) && RUN_TIME_BUDGET_MS[key] > 0, key);
    assert.match(RUN_TIME_BUDGET_ENV[key], /^QA_RUN_TIME_BUDGET_MS_[A-Z_]+$/, key);
  }
  assert.equal(new Set(Object.values(RUN_TIME_BUDGET_ENV)).size, RUN_TIME_BUDGET_KEYS.length);
});

test("the longest a run can last is the largest of the budgets in force, an operator's override included", () => {
  assert.equal(longestRunTimeBudgetMs(resolveRunTimeBudgets({})), Math.max(...Object.values(RUN_TIME_BUDGET_MS)));
  const raised = resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.diff]: String(10 * RUN_TIME_BUDGET_MS.context) });
  assert.equal(longestRunTimeBudgetMs(raised), 10 * RUN_TIME_BUDGET_MS.context);
});

test("a diff run is one kind whatever the size of its change, and every other mode is itself", () => {
  assert.equal(runTimeBudgetKey({ mode: "diff" }), "diff");
  assert.equal(RUN_TIME_BUDGET_MS.diff, 60 * 60_000);
  for (const mode of ["manual", "context"] as const) assert.equal(runTimeBudgetKey({ mode }), mode);
});

test("a deadline armed for a diff run counts down the one diff budget", () => {
  const deadline = new RunDeadline({ now: () => 0, budgets: RUN_TIME_BUDGET_MS });
  deadline.arm({ mode: "diff" });
  assert.deepEqual(deadline.describe(), { label: "diff", budgetMs: RUN_TIME_BUDGET_MS.diff });
});

test("the rows of the other modes keep their time and their variable", () => {
  assert.deepEqual({ manual: RUN_TIME_BUDGET_MS.manual, context: RUN_TIME_BUDGET_MS.context }, { manual: 45 * 60_000, context: 60 * 60_000 });
  assert.deepEqual({ manual: RUN_TIME_BUDGET_ENV.manual, context: RUN_TIME_BUDGET_ENV.context, diff: RUN_TIME_BUDGET_ENV.diff }, { manual: "QA_RUN_TIME_BUDGET_MS_MANUAL", context: "QA_RUN_TIME_BUDGET_MS_CONTEXT", diff: "QA_RUN_TIME_BUDGET_MS_DIFF" });
});

test("the defaults stand when no variable is set or a blank one is", () => {
  assert.deepEqual(resolveRunTimeBudgets({}), RUN_TIME_BUDGET_MS);
  assert.deepEqual(resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.diff]: "  ", [RUN_TIME_BUDGET_FORMER_ENV[0]]: " " }), RUN_TIME_BUDGET_MS);
});

test("a variable overrides only its own kind", () => {
  const budgets = resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.manual]: "90000" });
  assert.equal(budgets.manual, 90_000);
  assert.equal(budgets.context, RUN_TIME_BUDGET_MS.context);
});

test("the diff budget is the new variable when set, else the largest of the former per-size variables that are set, else the default", () => {
  const [tiny, focused, broad] = RUN_TIME_BUDGET_FORMER_ENV;
  assert.equal(resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.diff]: "900000" }).diff, 900_000);
  assert.equal(resolveRunTimeBudgets({ [tiny]: "600000", [broad]: "1200000" }).diff, 1_200_000, "an operator who lengthened a bound keeps the longest");
  assert.equal(resolveRunTimeBudgets({ [tiny]: "600000", [focused]: "300000" }).diff, 600_000);
  assert.equal(resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.diff]: "900000", [broad]: "1200000" }).diff, 900_000, "the new variable wins over every former one");
  assert.equal(resolveRunTimeBudgets({ [tiny]: " " }).diff, RUN_TIME_BUDGET_MS.diff, "a blank former variable is unset");
});

test("a former per-size variable is held to the same rule as the new one: a mistyped value fails loudly and names it", () => {
  for (const name of RUN_TIME_BUDGET_FORMER_ENV) {
    for (const bad of ["6min", "0", "none"]) assert.throws(() => resolveRunTimeBudgets({ [name]: bad }), new RegExp(name), `${name}=${bad}`);
  }
});

test("the former labels of the diff row are the three per-size rows and no other row has one", () => {
  assert.deepEqual(RUN_TIME_BUDGET_FORMER_LABELS, { diff: ["diff-tiny", "diff-focused", "diff-broad"] });
  assert.deepEqual([...RUN_TIME_BUDGET_FORMER_ENV], ["QA_RUN_TIME_BUDGET_MS_DIFF_TINY", "QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED", "QA_RUN_TIME_BUDGET_MS_DIFF_BROAD"]);
});

test("a value that is not a positive whole number of milliseconds fails loudly and names its variable, and 'none' is not a way out", () => {
  for (const bad of ["6min", "0", "-5", "1.5", "none", "1e6"]) {
    assert.throws(() => resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.context]: bad }), new RegExp(RUN_TIME_BUDGET_ENV.context), bad);
  }
});

test("a deadline that is not armed bounds nothing", () => {
  const deadline = new RunDeadline({ now: () => 0, budgets: RUN_TIME_BUDGET_MS });
  assert.equal(deadline.remainingMs(), undefined);
  assert.equal(deadline.describe(), undefined);
});

test("an armed deadline counts down on its clock from the moment it was armed", () => {
  let t = 1_000;
  const deadline = new RunDeadline({ now: () => t, budgets: { ...RUN_TIME_BUDGET_MS, manual: 10_000 } });
  t = 5_000;
  deadline.arm({ mode: "manual" });
  assert.deepEqual(deadline.describe(), { label: "manual", budgetMs: 10_000 });
  assert.equal(deadline.remainingMs(), 10_000);
  t = 12_000;
  assert.equal(deadline.remainingMs(), 3_000);
  t = 16_000;
  assert.equal(deadline.remainingMs(), -1_000, "past the deadline the time left is negative, which callers read as spent");
});

test("arming again restarts the countdown for the new scope", () => {
  let t = 0;
  const deadline = new RunDeadline({ now: () => t, budgets: { ...RUN_TIME_BUDGET_MS, manual: 100, context: 500 } });
  deadline.arm({ mode: "manual" });
  t = 80;
  deadline.arm({ mode: "context" });
  assert.equal(deadline.remainingMs(), 500);
  assert.equal(deadline.describe()?.label, "context");
});

test("the note says what the budget was, where the run stopped and that it is not a finding about the app", () => {
  const mid = renderRunDeadlineNote({ budgetMs: 25 * 60_000, label: "diff", role: "primary", stop: "mid-turn" });
  assert.match(mid, /25 min \(diff\)/);
  assert.match(mid, /primary turn in progress was stopped/);
  assert.match(mid, /not a finding about the app/);
  const before = renderRunDeadlineNote({ budgetMs: 90_500, label: "manual", role: "reviewer", stop: "before-turn" });
  assert.match(before, /91 s \(manual\)/);
  assert.match(before, /next reviewer turn was not started/);
});

/* A scheduler standing in for the timer: the test fires the countdown by hand and sees which ones were cancelled. */
function manualClock() {
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const schedule = (ms: number, fire: () => void) => {
    const timer = { ms, fire, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  return { timers, schedule };
}

test("a run's deadline hands out a signal that fires when its time is spent, and says which budget was spent", () => {
  const clock = manualClock();
  const deadline = new RunDeadline({ now: () => 0, budgets: { ...RUN_TIME_BUDGET_MS, manual: 1000 }, schedule: clock.schedule });
  assert.equal(deadline.signal(), undefined, "nothing is armed yet");
  assert.equal(deadline.fired(), false);
  deadline.arm({ mode: "manual" });
  const signal = deadline.signal()!;
  assert.equal(clock.timers[0]!.ms, 1000);
  assert.equal(signal.aborted, false);
  clock.timers[0]!.fire();
  assert.equal(signal.aborted, true);
  assert.equal(deadline.fired(), true);
  assert.match(String(signal.reason?.message ?? signal.reason), /manual/);
});

test("arming again cancels the countdown of the scope before and gives a fresh signal", () => {
  const clock = manualClock();
  const deadline = new RunDeadline({ now: () => 0, budgets: { ...RUN_TIME_BUDGET_MS, manual: 100, context: 500 }, schedule: clock.schedule });
  deadline.arm({ mode: "manual" });
  const first = deadline.signal()!;
  deadline.arm({ mode: "context" });
  assert.equal(clock.timers[0]!.cancelled, true);
  clock.timers[0]!.fire();
  assert.equal(deadline.fired(), false, "the cancelled countdown no longer speaks for the run");
  assert.notEqual(deadline.signal(), first);
});

test("a deadline cut in a phase reports the purpose of that phase", () => {
  const deadline = new RunDeadline({ now: () => 0, budgets: RUN_TIME_BUDGET_MS });
  deadline.arm({ mode: "manual" });
  deadline.enter("execute");
  assert.equal(deadline.currentPurpose(), "execute");
});

test("the note of a cut deterministic phase names the phase and the purpose it cut", () => {
  const note = renderRunDeadlineNote({ budgetMs: 60_000, label: "diff", role: "primary", stop: "mid-phase", purpose: "execute" });
  assert.match(note, /1 min \(diff\)/);
  assert.match(note, /The purpose cut was execute\./);
});

const MIN = 60_000;
/* A finished run of the app: every phase it entered with the minutes it took, ending where a normal run ends. */
function finished(timings: Partial<Record<RunPhase, number>>): PhaseRecord {
  return { furthestPhase: "learn", phaseTimings: timings };
}
const TYPICAL: PhaseRecord = finished({ setup: 1 * MIN, ground: 1 * MIN, generate: 10 * MIN, validate: 1 * MIN, health: 0, execute: 3 * MIN, fix_loop: 0, coverage: 2 * MIN, review: 4 * MIN, decide: 0, publish: 1 * MIN, learn: 0 });

function armedAt(budgetMs: number, history: readonly PhaseRecord[] = [TYPICAL]) {
  let t = 0;
  const deadline = new RunDeadline({ now: () => t, budgets: { ...RUN_TIME_BUDGET_MS, manual: budgetMs } });
  deadline.arm({ mode: "manual" });
  deadline.measure(history);
  return { deadline, at: (ms: number) => { t = ms; } };
}

test("nothing is allotted while the deadline is unarmed, whatever the purpose", () => {
  const deadline = new RunDeadline({ now: () => 0, budgets: RUN_TIME_BUDGET_MS });
  for (const purpose of DEADLINE_PURPOSES) assert.equal(deadline.allowance(purpose), null, purpose);
});

test("a purpose is allowed what is left less the app's measured time of every phase after it", () => {
  const { deadline } = armedAt(40 * MIN);
  /* After generate: validate 1, execute 3, fix 0, coverage 2, review 4, decide 1 = 11 min. */
  assert.equal(deadline.allowance("generate"), 29 * MIN);
  assert.equal(deadline.allowance("review"), 39 * MIN, "only the decision follows the review");
  assert.equal(deadline.allowance("decide"), 40 * MIN, "nothing follows the decision");
  assert.equal(deadline.allotment("generate")?.reserve.source, "measured");
});

test("an overrun of the earlier phases shrinks what generation may start, while the review keeps being allotted what is left less the decision", () => {
  const { deadline, at } = armedAt(40 * MIN);
  at(35 * MIN);
  assert.equal(deadline.allowance("generate"), 0, "5 min are left and the phases after generate are owed 11: generate may start nothing");
  assert.equal(deadline.allowance("review"), 4 * MIN, "the review is still allotted what is left less the decision");
});

test("a phase the app has no completed run of shares one fallback reserve, a quarter of what is left and at least two minutes, and the allotment says so", () => {
  const { deadline, at } = armedAt(40 * MIN, []);
  const first = deadline.allotment("generate");
  assert.equal(first?.reserve.source, "fallback");
  assert.equal(first?.reserve.ms, 10 * MIN, "a quarter of 40 min, once, however many phases follow");
  assert.equal(first?.ms, 30 * MIN);
  assert.deepEqual(first?.reserve.unmeasured, ["validate", "execute", "fix", "coverage", "review"], "the decision holds back only its measured time: publication is short and never cut at the deadline");
  at(36 * MIN);
  assert.equal(deadline.allotment("generate")?.reserve.ms, 2 * MIN, "the floor");
});

test("a run that ended before it finished a phase measures nothing for that phase", () => {
  const cut: PhaseRecord = { furthestPhase: "review", phaseTimings: { ...TYPICAL.phaseTimings, review: 30_000 } };
  const measured = measuredPurposeDurations([cut]);
  assert.equal(measured.get("execute"), 3 * MIN, "execute was completed in that run");
  assert.equal(measured.has("review"), false, "the review it was cut in says how long the cut took, not how long the phase needs");
  assert.equal(measured.has("decide"), false);
});

test("a phase a run never entered is no sample of it: runs that failed before the review say nothing about how long a review takes", () => {
  const failedBeforeReview = (): PhaseRecord => ({ furthestPhase: "learn", phaseTimings: { setup: MIN, ground: MIN, generate: 10 * MIN, validate: MIN, execute: 3 * MIN, fix_loop: MIN, decide: 0, publish: MIN } });
  const records = [...Array.from({ length: 11 }, failedBeforeReview), ...Array.from({ length: 9 }, () => TYPICAL)];
  const measured = measuredPurposeDurations(records);
  assert.equal(measured.get("review"), 4 * MIN, "the nine runs that reviewed set it, the eleven that never entered it add no zero");
  assert.equal(measured.get("coverage"), 2 * MIN);
  const never = measuredPurposeDurations(Array.from({ length: 5 }, failedBeforeReview));
  assert.equal(never.has("review"), false, "a streak of runs that failed before the review never had green bytes to review: the fallback stands, not a zero");
  assert.equal(never.has("coverage"), false);
  assert.equal(never.get("execute"), 3 * MIN);
  assert.equal(measuredPurposeDurations([]).has("review"), false, "no history says nothing: the fallback stands");
});

test("a purpose that whole runs with green bytes passed over takes no time for runs of that kind", () => {
  const { review: _review, ...noReview } = TYPICAL.phaseTimings;
  const greenWithoutReview: PhaseRecord = { furthestPhase: "learn", phaseTimings: noReview };
  const measured = measuredPurposeDurations([greenWithoutReview, greenWithoutReview]);
  assert.equal(measured.get("review"), 0, "an app whose green runs are never reviewed spends no time there");
  assert.equal(measured.get("fix"), 0, "green runs that never entered the fix loop");
  assert.equal(measured.get("coverage"), 2 * MIN);
});

test("a kind of run that executes nothing takes no time in the phases its whole runs never enter", () => {
  const contextRun: PhaseRecord = { furthestPhase: "learn", phaseTimings: { setup: MIN, ground: MIN, generate: 20 * MIN, validate: MIN, health: 0, decide: 0, publish: MIN } };
  const measured = measuredPurposeDurations([contextRun, contextRun], { executes: false });
  for (const purpose of ["execute", "fix", "coverage", "review"] as const) assert.equal(measured.get(purpose), 0, purpose);
  assert.equal(measured.get("generate"), 20 * MIN);
  assert.equal(measuredPurposeDurations([contextRun, contextRun]).has("review"), false, "the same history, read as a kind that executes, shows no green bytes");
});

test("a purpose that no run entered is not measured as none when every run that could say so was cut", () => {
  const cutEarly: PhaseRecord = { furthestPhase: "learn", phaseTimings: { setup: MIN, ground: MIN, generate: 30 * MIN }, cutPurposes: ["generate"] };
  const measured = measuredPurposeDurations([cutEarly, cutEarly]);
  assert.equal(measured.has("review"), false, "a run cut in generation never got to the review: it says nothing about it");
  assert.equal(measured.has("generate"), false);
});

test("a purpose the run's own deadline or share cut is no sample of it, even when a later phase ran", () => {
  const degraded: PhaseRecord = { ...TYPICAL, phaseTimings: { ...TYPICAL.phaseTimings, review: 30_000 }, cutPurposes: ["review"] };
  const measured = measuredPurposeDurations([degraded, TYPICAL]);
  assert.equal(measured.get("review"), 4 * MIN, "the cut review took 30 s because it was cut");
  assert.equal(measured.get("execute"), 3 * MIN, "the purposes it did not cut still count");
  assert.equal(measuredPurposeDurations([degraded]).has("review"), false);
});

test("the measured time of a phase is the median of the app's runs, so one outlier moves nothing", () => {
  const slow = finished({ ...TYPICAL.phaseTimings, review: 40 * MIN });
  const quick = finished({ ...TYPICAL.phaseTimings, review: 2 * MIN });
  assert.equal(measuredPurposeDurations([TYPICAL, slow, quick]).get("review"), 4 * MIN);
  assert.equal(measuredPurposeDurations([TYPICAL, quick]).get("review"), 3 * MIN, "the mean of the two in the middle");
});

test("identical history gives identical allotments", () => {
  const a = armedAt(40 * MIN, [TYPICAL, finished({ ...TYPICAL.phaseTimings, review: 6 * MIN })]).deadline;
  const b = armedAt(40 * MIN, [finished({ ...TYPICAL.phaseTimings, review: 6 * MIN }), TYPICAL]).deadline;
  for (const purpose of DEADLINE_PURPOSES) assert.deepEqual(a.allotment(purpose), b.allotment(purpose), purpose);
});

test("an allowance asked for without a purpose is the one of the phase the run is in", () => {
  const { deadline } = armedAt(40 * MIN);
  assert.equal(deadline.allowance(), deadline.allowance("ground"), "before any phase is entered the run is in its first purpose");
  deadline.enter("review");
  assert.equal(deadline.allowance(), deadline.allowance("review"));
  deadline.enter("fix_loop");
  assert.equal(deadline.allowance(), deadline.allowance("fix"));
});

test("each purpose is announced to the observer once, with the source of its reserve", () => {
  const { deadline } = armedAt(40 * MIN);
  const told: string[] = [];
  deadline.observe((a) => told.push(`${a.purpose}:${a.reserve.source}`));
  deadline.allowance("generate");
  deadline.allowance("generate");
  deadline.allowance("decide");
  assert.deepEqual(told, ["generate:measured", "decide:none"]);
});

test("the cut-off instant is the deadline's own: no purpose has time left at it", () => {
  const { deadline, at } = armedAt(1_000);
  at(1_000);
  for (const purpose of DEADLINE_PURPOSES) assert.equal(deadline.allowance(purpose), 0, purpose);
});
