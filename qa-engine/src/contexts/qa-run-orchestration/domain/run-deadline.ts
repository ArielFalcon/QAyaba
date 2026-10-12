/*
 * The deadline of one run. Not armed until the run knows what kind of run it is (a diff run's budget
 * follows the size of its change, known only after classification); from then it counts down on the
 * clock it was given. Agent turns read it through the kernel's RunDeadlineView; the use case arms it.
 */
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import { runTimeBudgetKey, type RunTimeBudgets, type RunTimeBudgetScope } from "./run-time-budget.ts";

export interface RunDeadlineDeps {
  /** The clock, in milliseconds. Injected so a test never waits for real time. */
  now: () => number;
  /** The time each kind of run is allowed, as the composition root resolved it. */
  budgets: RunTimeBudgets;
}

export class RunDeadline implements RunDeadlineView {
  private armed: { label: string; budgetMs: number; deadlineAt: number } | undefined;

  constructor(private readonly deps: RunDeadlineDeps) {}

  /** Starts the countdown for this kind of run. Arming again restarts it for the new scope. */
  arm(scope: RunTimeBudgetScope): void {
    const label = runTimeBudgetKey(scope);
    const budgetMs = this.deps.budgets[label];
    this.armed = { label, budgetMs, deadlineAt: this.deps.now() + budgetMs };
  }

  remainingMs(): number | undefined {
    return this.armed ? this.armed.deadlineAt - this.deps.now() : undefined;
  }

  describe(): { label: string; budgetMs: number } | undefined {
    return this.armed ? { label: this.armed.label, budgetMs: this.armed.budgetMs } : undefined;
  }
}
