import { test } from "node:test";
import assert from "node:assert/strict";
import { RunDeadline } from "@contexts/qa-run-orchestration/domain/run-deadline.ts";
import {
  RUN_TIME_BUDGET_ENV,
  RUN_TIME_BUDGET_KEYS,
  RUN_TIME_BUDGET_MS,
  renderRunDeadlineNote,
  resolveRunTimeBudgets,
  runTimeBudgetKey,
} from "@contexts/qa-run-orchestration/domain/run-time-budget.ts";

const bigDiff = Array.from({ length: 5 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n@@ -1 +1 @@\n-a\n+b\n`).join("");

test("every kind of run has a finite default and its own variable", () => {
  for (const key of RUN_TIME_BUDGET_KEYS) {
    assert.ok(Number.isFinite(RUN_TIME_BUDGET_MS[key]) && RUN_TIME_BUDGET_MS[key] > 0, key);
    assert.match(RUN_TIME_BUDGET_ENV[key], /^QA_RUN_TIME_BUDGET_MS_[A-Z_]+$/, key);
  }
  assert.equal(new Set(Object.values(RUN_TIME_BUDGET_ENV)).size, RUN_TIME_BUDGET_KEYS.length);
});

test("a bigger change is never given less time than a smaller one", () => {
  assert.ok(RUN_TIME_BUDGET_MS["diff-tiny"] <= RUN_TIME_BUDGET_MS["diff-focused"]);
  assert.ok(RUN_TIME_BUDGET_MS["diff-focused"] <= RUN_TIME_BUDGET_MS["diff-broad"]);
});

test("a diff run is keyed by the size of its change and every other mode by itself", () => {
  assert.equal(runTimeBudgetKey({ mode: "diff", diff: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n" }), "diff-tiny");
  assert.equal(runTimeBudgetKey({ mode: "diff", diff: bigDiff }), "diff-focused");
  assert.equal(runTimeBudgetKey({ mode: "diff", diff: "", changedFiles: Array.from({ length: 30 }, (_, i) => `f${i}.ts`) }), "diff-broad");
  for (const mode of ["manual", "complete", "exhaustive", "context"] as const) assert.equal(runTimeBudgetKey({ mode }), mode);
});

test("the defaults stand when no variable is set or a blank one is", () => {
  assert.deepEqual(resolveRunTimeBudgets({}), RUN_TIME_BUDGET_MS);
  assert.deepEqual(resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV["diff-broad"]]: "  " }), RUN_TIME_BUDGET_MS);
});

test("a variable overrides only its own kind", () => {
  const budgets = resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.manual]: "90000" });
  assert.equal(budgets.manual, 90_000);
  assert.equal(budgets.complete, RUN_TIME_BUDGET_MS.complete);
});

test("a value that is not a positive whole number of milliseconds fails loudly and names its variable, and 'none' is not a way out", () => {
  for (const bad of ["6min", "0", "-5", "1.5", "none", "1e6"]) {
    assert.throws(() => resolveRunTimeBudgets({ [RUN_TIME_BUDGET_ENV.complete]: bad }), new RegExp(RUN_TIME_BUDGET_ENV.complete), bad);
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
  const deadline = new RunDeadline({ now: () => t, budgets: { ...RUN_TIME_BUDGET_MS, manual: 100, complete: 500 } });
  deadline.arm({ mode: "manual" });
  t = 80;
  deadline.arm({ mode: "complete" });
  assert.equal(deadline.remainingMs(), 500);
  assert.equal(deadline.describe()?.label, "complete");
});

test("the note says what the budget was, where the run stopped and that it is not a finding about the app", () => {
  const mid = renderRunDeadlineNote({ budgetMs: 25 * 60_000, label: "diff-tiny", role: "primary", stop: "mid-turn" });
  assert.match(mid, /25 min \(diff-tiny\)/);
  assert.match(mid, /primary turn in progress was stopped/);
  assert.match(mid, /not a finding about the app/);
  const before = renderRunDeadlineNote({ budgetMs: 90_500, label: "manual", role: "reviewer", stop: "before-turn" });
  assert.match(before, /91 s \(manual\)/);
  assert.match(before, /next reviewer turn was not started/);
});
