/*
 * How long a whole run may take on the agents' time, by the kind of run. One named table, one
 * environment override per row, and the note that says so when a run's time is spent. Pure: the run's
 * mode and the change's size in, a bound in milliseconds out; the caller hands in the environment.
 */
import type { RunMode } from "@kernel/run-mode.ts";

/** The kinds of run that are bounded apart: each mode is its own kind. */
export const RUN_TIME_BUDGET_KEYS = ["diff", "manual", "context"] as const;
export type RunTimeBudgetKey = (typeof RUN_TIME_BUDGET_KEYS)[number];

/** The wall time a whole run may take, in milliseconds, counted from the end of classification. Generous on purpose and finite for every kind: it exists to end a run that is no longer converging, not to shape one that is, so it reads no property of the change. */
export const RUN_TIME_BUDGET_MS: Readonly<Record<RunTimeBudgetKey, number>> = {
  diff: 60 * 60_000,
  manual: 45 * 60_000,
  context: 60 * 60_000,
};

/** The variable that overrides each kind's time, in milliseconds. Declared per kind so a kind added to the table cannot be left without one. */
export const RUN_TIME_BUDGET_ENV: Readonly<Record<RunTimeBudgetKey, string>> = {
  diff: "QA_RUN_TIME_BUDGET_MS_DIFF",
  manual: "QA_RUN_TIME_BUDGET_MS_MANUAL",
  context: "QA_RUN_TIME_BUDGET_MS_CONTEXT",
};

/** The per-size variables the diff row replaced. They are read for one release more: the new variable when set, else the largest of these that are set (an operator who lengthened a bound keeps it). */
export const RUN_TIME_BUDGET_FORMER_ENV = ["QA_RUN_TIME_BUDGET_MS_DIFF_TINY", "QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED", "QA_RUN_TIME_BUDGET_MS_DIFF_BROAD"] as const;

/** The labels runs were stored with before a kind took its present name (`runs.time_budget` is never rewritten): a read of the kind reads these rows too. */
export const RUN_TIME_BUDGET_FORMER_LABELS: Readonly<Partial<Record<RunTimeBudgetKey, readonly string[]>>> = {
  diff: ["diff-tiny", "diff-focused", "diff-broad"],
};

export type RunTimeBudgets = Readonly<Record<RunTimeBudgetKey, number>>;

export interface RunTimeBudgetScope {
  mode: RunMode;
}

/** The kind of run this is: its mode. */
export function runTimeBudgetKey(scope: RunTimeBudgetScope): RunTimeBudgetKey {
  return scope.mode;
}

/** The longest any run can last under these budgets: a session a run holds sits idle for less than that, so one idle for longer belongs to no live run. */
export function longestRunTimeBudgetMs(budgets: RunTimeBudgets): number {
  return Math.max(...RUN_TIME_BUDGET_KEYS.map((key) => budgets[key]));
}

function parseMs(name: string, raw: string | undefined): number | undefined {
  const text = raw?.trim() ?? "";
  if (text === "") return undefined;
  const ms = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return ms;
}

/** The longest of the former per-size variables that are set: an operator who lengthened a bound keeps it. */
function formerDiffBudget(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const set = RUN_TIME_BUDGET_FORMER_ENV.map((name) => parseMs(name, env[name])).filter((ms): ms is number => ms !== undefined);
  return set.length > 0 ? Math.max(...set) : undefined;
}

/**
 * The run budgets with the operator's overrides applied: a kind with no variable (or a blank one) keeps its
 * default, and any other value must be a positive whole number of milliseconds or this throws, naming the
 * variable. The diff kind reads the former per-size variables when its own is unset (see `RUN_TIME_BUDGET_FORMER_ENV`).
 * There is deliberately no way to remove a bound: a run that can never end is the fault this budget
 * exists to close, so an operator who wants more time sets a larger number.
 */
export function resolveRunTimeBudgets(env: Readonly<Record<string, string | undefined>>): RunTimeBudgets {
  const entries = RUN_TIME_BUDGET_KEYS.map((key) => {
    const own = parseMs(RUN_TIME_BUDGET_ENV[key], env[RUN_TIME_BUDGET_ENV[key]]);
    /* Every former variable is validated even when the new one wins, so a mistyped value is reported, never silently ignored. */
    const former = key === "diff" ? formerDiffBudget(env) : undefined;
    return [key, own ?? former ?? RUN_TIME_BUDGET_MS[key]] as const;
  });
  return Object.fromEntries(entries) as RunTimeBudgets;
}

/** A budget as an operator reads it: whole minutes when it is that, otherwise seconds. */
function budgetText(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

export interface RunDeadlineNoteInput {
  budgetMs: number;
  label: string;
  /** The role whose turn the deadline refused or stopped. */
  role: string;
  /** Whether that turn had begun, or a phase that is no agent turn was cut while it ran. */
  stop: "before-turn" | "mid-turn" | "mid-phase";
  /** The purpose the deadline cut. */
  purpose?: string;
}

/** The note of a run that ended because a step with no path of its own for it met the end of its purpose's share of the time: what the share was, where it ended and that it says nothing about the app. */
export function renderAllotmentNote(input: { role: string; purpose: string; stop: "before-turn" | "mid-turn"; budgetMs?: number; label?: string }): string {
  const where = input.stop === "mid-turn" ? `the ${input.role} turn in progress was stopped` : `the next ${input.role} turn was not started`;
  const budget = input.budgetMs !== undefined && input.label ? ` of the run time budget of ${budgetText(input.budgetMs)} (${input.label})` : "";
  return `The time allotted to ${input.purpose}${budget} was spent while the run still had time (the rest is held for the phases after it): ${where}, and nothing at that step could go on without it. The run ended without a verdict on the change; this is a limit on the run's time, not a finding about the app.`;
}

/** The note persisted for a run whose time ran out: what the budget was, where it ended and that it says nothing about the app. */
export function renderRunDeadlineNote(input: RunDeadlineNoteInput): string {
  const where =
    input.stop === "mid-phase" ? `the ${input.role} phase in progress was stopped`
    : input.stop === "mid-turn" ? `the ${input.role} turn in progress was stopped`
    : `the next ${input.role} turn was not started`;
  const purpose = input.purpose ? ` The purpose cut was ${input.purpose}.` : "";
  return `Run time budget of ${budgetText(input.budgetMs)} (${input.label}) exhausted: ${where}.${purpose} The run ended without a verdict on the change; this is a limit on the run's time, not a finding about the app.`;
}
