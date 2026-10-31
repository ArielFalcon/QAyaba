/*
 * The right to act on DEV, held for the length of one action (a `run_spec` call, an authenticated browser action). It is the
 * account lock with one more rule: whoever holds the lease holds DEV alone, so actions never overlap, whatever the account is.
 * The egress proxy has no read-only mode, so no action can be admitted beside another.
 *
 * Order of taking: the account first, DEV second, and DEV is granted first come first served. Nobody holds DEV while waiting
 * for an account, so no wait is a cycle.
 */

import { AccountLock } from "./account-lock.ts";

/* One holder of DEV at a time, in the order they asked. */
class DevGate {
  private held = false;
  private readonly queue: Array<() => void> = [];

  async acquire(account: string, signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) throw new Error(`waiting for DEV on the ${account} account was aborted`);
    if (!this.held) {
      this.held = true;
    } else {
      await new Promise<void>((resolve, reject) => {
        const grant = (): void => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = (): void => {
          const at = this.queue.indexOf(grant);
          if (at < 0) return;
          this.queue.splice(at, 1);
          reject(new Error(`waiting for DEV on the ${account} account was aborted`));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.queue.push(grant);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.held = false;
    };
  }
}

export class DevLease extends AccountLock {
  private readonly gate = new DevGate();

  override withLock<T>(account: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return super.withLock(
      account,
      async () => {
        const release = await this.gate.acquire(account, signal);
        try {
          return await task();
        } finally {
          release();
        }
      },
      signal,
    );
  }
}
