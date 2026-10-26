/*
 * How long a whole run may take on the agents' time, by the kind of run. One named table, one
 * environment override per row, and the note that says so when a run's time is spent. Pure: the run's
 * mode and the change's size in, a bound in milliseconds out; the caller hands in the environment.
 */
import type { RunMode } from "@kernel/run-mode.ts";
import { diffStat, diffTier, type DiffTier } from "@kernel/diff-stat.ts";

/** The kinds of run that are bounded apart: a diff run by the size of its change, every other mode as itself. */
export const RUN_TIME_BUDGET_KEYS = ["diff-tiny", "diff-focused", "diff-broad", "manual", "complete", "exhaustive", "context"] as const;
export type RunTimeBudgetKey = (typeof RUN_TIME_BUDGET_KEYS)[number];

/** The wall time a whole run may take, in milliseconds, counted from the end of classification. Generous on purpose and finite for every kind: it exists to end a run that is no longer converging, not to shape one that is. */
export const RUN_TIME_BUDGET_MS: Readonly<Record<RunTimeBudgetKey, number>> = {
  "diff-tiny": 25 * 60_000,
  "diff-focused": 40 * 60_000,
  "diff-broad": 60 * 60_000,
  manual: 45 * 60_000,
  complete: 90 * 60_000,
  exhaustive: 150 * 60_000,
  context: 60 * 60_000,
};

/** The variable that overrides each kind's time, in milliseconds. Declared per kind so a kind added to the table cannot be left without one. */
export const RUN_TIME_BUDGET_ENV: Readonly<Record<RunTimeBudgetKey, string>> = {
  "diff-tiny": "QA_RUN_TIME_BUDGET_MS_DIFF_TINY",
  "diff-focused": "QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED",
  "diff-broad": "QA_RUN_TIME_BUDGET_MS_DIFF_BROAD",
  manual: "QA_RUN_TIME_BUDGET_MS_MANUAL",
  complete: "QA_RUN_TIME_BUDGET_MS_COMPLETE",
  exhaustive: "QA_RUN_TIME_BUDGET_MS_EXHAUSTIVE",
  context: "QA_RUN_TIME_BUDGET_MS_CONTEXT",
};

export type RunTimeBudgets = Readonly<Record<RunTimeBudgetKey, number>>;

const DIFF_KEY_FOR_TIER: Readonly<Record<DiffTier, RunTimeBudgetKey>> = {
  tiny: "diff-tiny",
  focused: "diff-focused",
  broad: "diff-broad",
};

export interface RunTimeBudgetScope {
  mode: RunMode;
  /** The change's diff; read only for a diff run. */
  diff?: string;
  /** The files the change touches; read only for a diff run. */
  changedFiles?: readonly string[];
}

/** The kind of run this is. A diff run is as large as its change really is; the rest are their mode. */
export function runTimeBudgetKey(scope: RunTimeBudgetScope): RunTimeBudgetKey {
  if (scope.mode !== "diff") return scope.mode;
  const stat = diffStat({ diff: scope.diff ?? "", ...(scope.changedFiles ? { changedFiles: scope.changedFiles } : {}) });
  return DIFF_KEY_FOR_TIER[diffTier(stat)];
}

function budgetFromEnv(key: RunTimeBudgetKey, raw: string | undefined): number {
  const name = RUN_TIME_BUDGET_ENV[key];
  const text = raw?.trim() ?? "";
  if (text === "") return RUN_TIME_BUDGET_MS[key];
  const ms = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return ms;
}

/**
 * The run budgets with the operator's overrides applied: a kind with no variable (or a blank one) keeps its
 * default, and any other value must be a positive whole number of milliseconds or this throws, naming the
 * variable. There is deliberately no way to remove a bound: a run that can never end is the fault this budget
 * exists to close, so an operator who wants more time sets a larger number.
 */
export function resolveRunTimeBudgets(env: Readonly<Record<string, string | undefined>>): RunTimeBudgets {
  const entries = RUN_TIME_BUDGET_KEYS.map((key) => [key, budgetFromEnv(key, env[RUN_TIME_BUDGET_ENV[key]])] as const);
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
  /** Whether that turn had begun. */
  stop: "before-turn" | "mid-turn";
}

/** The note persisted for a run whose time ran out: what the budget was, where it ended and that it says nothing about the app. */
export function renderRunDeadlineNote(input: RunDeadlineNoteInput): string {
  const where = input.stop === "mid-turn" ? `the ${input.role} turn in progress was stopped` : `the next ${input.role} turn was not started`;
  return `Run time budget of ${budgetText(input.budgetMs)} (${input.label}) exhausted: ${where}. The run ended without a verdict on the change; this is a limit on the run's time, not a finding about the app.`;
}
