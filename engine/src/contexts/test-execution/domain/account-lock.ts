/*
 * One holder at a time per test account. A run owns the sequential queue's single slot, so today nothing else wants the
 * account; the lock exists because a spec executed by `run_spec` logs in as the same account the run's own suite uses, and
 * the day two things run at once they must not interleave their writes on one account. It is separate from the queue on
 * purpose: the queue orders runs, this orders users of an account.
 */

export class AccountLock {
  private readonly tails = new Map<string, Promise<void>>();

  /* Runs `task` once every earlier holder of `account` is done, and releases the account however `task` ends. A waiter whose signal aborts leaves the queue without running. */
  async withLock<T>(account: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error(`waiting for the ${account} account was aborted`);
    const previous = this.tails.get(account) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(account, tail);
    let held = false;
    try {
      await this.turn(previous, account, signal);
      held = true;
      return await task();
    } finally {
      release();
      if (held) {
        if (this.tails.get(account) === tail) this.tails.delete(account);
      } else {
        /* A waiter that left never held the account, so the holders before it may still be running: its place in the chain stays (it resolves as soon as they are done) and goes once it has. */
        void tail.then(() => {
          if (this.tails.get(account) === tail) this.tails.delete(account);
        });
      }
    }
  }

  private turn(previous: Promise<void>, account: string, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return previous;
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new Error(`waiting for the ${account} account was aborted`));
      signal.addEventListener("abort", onAbort, { once: true });
      previous.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
}
