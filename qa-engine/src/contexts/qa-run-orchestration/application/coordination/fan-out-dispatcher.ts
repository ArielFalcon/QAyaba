/*
 * Runs a plan's flows through a bounded pool. Each flow has its own stop signal and its own time, counted from the moment it starts
 * and not from the moment it was queued; what one flow does (runs out of time, throws, ignores its stop) is that flow's result and
 * never another's. A flow that is stopped is given a short grace to wind down before its place is taken, so a flow that never
 * answers cannot keep the pool from moving, and a flow that does answer does not run beside its successor longer than that.
 * The clock is injected: nothing here reads the time.
 */

export const FLOW_RESULT = {
  SETTLED: "settled",
  TIMED_OUT: "timed-out",
  ABORTED: "aborted",
  THREW: "threw",
} as const;

export type FlowResult<T> =
  | { id: string; status: typeof FLOW_RESULT.SETTLED; value: T }
  | { id: string; status: typeof FLOW_RESULT.TIMED_OUT }
  | { id: string; status: typeof FLOW_RESULT.ABORTED }
  | { id: string; status: typeof FLOW_RESULT.THREW; error: unknown };

/* Calls `fire` after `ms` and returns the call that cancels it. */
export interface TimerPort {
  setTimer(ms: number, fire: () => void): () => void;
}

/* The system clock. */
export const systemTimers: TimerPort = {
  setTimer: (ms, fire) => {
    const handle = setTimeout(fire, ms);
    return () => clearTimeout(handle);
  },
};

export interface FlowSlot {
  id: string;
  budgetMs: number;
}

export interface FanOutDispatcherDeps {
  timers: TimerPort;
  /* How long a flow that was stopped may take to return before its place is taken. */
  abortGraceMs?: number;
}

export interface FanOutOptions {
  maxParallel: number;
  /* The run's cancellation: it stops every running flow and starts none of the rest. */
  signal?: AbortSignal;
}

export const DEFAULT_ABORT_GRACE_MS = 10_000;

type Outcome<T> = { done: true; value: T } | { done: false; error: unknown };

export class FanOutDispatcher {
  constructor(private readonly deps: FanOutDispatcherDeps) {}

  async run<F extends FlowSlot, T>(
    flows: readonly F[],
    options: FanOutOptions,
    execute: (flow: F, signal: AbortSignal) => Promise<T>,
  ): Promise<FlowResult<T>[]> {
    const results: Array<FlowResult<T> | undefined> = flows.map(() => undefined);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < flows.length; index = next++) {
        results[index] = await this.runOne(flows[index]!, options.signal, execute);
      }
    };
    const pool = Math.max(1, Math.min(Math.floor(options.maxParallel) || 1, flows.length));
    await Promise.all(Array.from({ length: pool }, worker));
    return results.map((result, index) => result ?? { id: flows[index]!.id, status: FLOW_RESULT.ABORTED });
  }

  private async runOne<F extends FlowSlot, T>(
    flow: F,
    parent: AbortSignal | undefined,
    execute: (flow: F, signal: AbortSignal) => Promise<T>,
  ): Promise<FlowResult<T>> {
    if (parent?.aborted) return { id: flow.id, status: FLOW_RESULT.ABORTED };
    const child = new AbortController();
    const cascade = (): void => child.abort(parent?.reason);
    parent?.addEventListener("abort", cascade, { once: true });

    const execution: Promise<Outcome<T>> = (async () => execute(flow, child.signal))().then(
      (value) => ({ done: true as const, value }),
      (error: unknown) => ({ done: false as const, error }),
    );
    let cancelBudget = (): void => {};
    const budget = new Promise<"budget">((resolve) => { cancelBudget = this.deps.timers.setTimer(flow.budgetMs, () => resolve("budget")); });
    try {
      const first = await Promise.race([execution, budget]);
      if (first === "budget") {
        child.abort(new Error(`flow ${flow.id} ran out of its ${flow.budgetMs} ms`));
        await this.windDown(execution);
        return { id: flow.id, status: FLOW_RESULT.TIMED_OUT };
      }
      if (!first.done) return { id: flow.id, status: FLOW_RESULT.THREW, error: first.error };
      if (parent?.aborted) return { id: flow.id, status: FLOW_RESULT.ABORTED };
      return { id: flow.id, status: FLOW_RESULT.SETTLED, value: first.value };
    } finally {
      cancelBudget();
      parent?.removeEventListener("abort", cascade);
    }
  }

  /* Waits for a stopped flow to return, but never longer than the grace. */
  private async windDown(execution: Promise<unknown>): Promise<void> {
    let cancel = (): void => {};
    const grace = new Promise<void>((resolve) => { cancel = this.deps.timers.setTimer(this.deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, resolve); });
    await Promise.race([execution, grace]);
    cancel();
  }
}
