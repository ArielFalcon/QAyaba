/*
 * The right to act on DEV, held for the length of one action (a spec execution, an authenticated browser action). It is the
 * account lock with one more rule, the one CLAUDE.md states: actions on one account are serialized; actions run together only on
 * distinct accounts and only when they cannot write; an action that may write holds DEV alone.
 *
 * Whether an action can write is never taken from the action's own word. A caller says `mayWrite: false` only when the thing it
 * runs is held read-only by the orchestrator (the proxy rejecting a mutating request), and even then the lease believes it only
 * when it was built with `readOnlyEnforced`: the engine builds it so only once the proxy has such a mode. Until then every action
 * holds DEV alone, and the lease is as strict as the lock it extends.
 *
 * Order of taking: the account first, DEV second, and DEV is granted first come first served, so a writer that waits is not
 * overtaken by readers that arrive after it. Nobody holds DEV while waiting for an account, so no wait is a cycle.
 */

import { AccountLock } from "./account-lock.ts";

export interface DevAccess {
  /* True when the action may send a request that writes. A false is honoured only by a lease that enforces read-only. */
  mayWrite: boolean;
}

/* What an action that acts on DEV takes before it does. */
export interface DevLeasePort {
  withLease<T>(account: string, access: DevAccess, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface DevLeaseOptions {
  /* Whether read-only actions are really held read-only. Absent: they are not, and every action holds DEV alone. */
  readOnlyEnforced?: boolean;
}

type Mode = "shared" | "alone";

interface Waiter {
  mode: Mode;
  grant: () => void;
}

/* Many holders of the shared side or one of the alone side, in the order they asked. */
class DevGate {
  private sharedHolders = 0;
  private aloneHolder = false;
  private readonly queue: Waiter[] = [];

  async acquire(mode: Mode, account: string, signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) throw new Error(`waiting for DEV on the ${account} account was aborted`);
    const granted = new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { mode, grant: () => { signal?.removeEventListener("abort", onAbort); resolve(); } };
      const onAbort = (): void => {
        const at = this.queue.indexOf(waiter);
        if (at < 0) return;
        this.queue.splice(at, 1);
        reject(new Error(`waiting for DEV on the ${account} account was aborted`));
        this.pump();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
    this.pump();
    await granted;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === "alone") this.aloneHolder = false;
      else this.sharedHolders -= 1;
      this.pump();
    };
  }

  /* Grants from the head of the line while the head can be let in; a head that cannot be keeps everyone behind it waiting. */
  private pump(): void {
    for (let head = this.queue[0]; head !== undefined; head = this.queue[0]) {
      if (head.mode === "alone") {
        if (this.aloneHolder || this.sharedHolders > 0) return;
        this.aloneHolder = true;
      } else {
        if (this.aloneHolder) return;
        this.sharedHolders += 1;
      }
      this.queue.shift();
      head.grant();
    }
  }
}

export class DevLease extends AccountLock implements DevLeasePort {
  private readonly gate = new DevGate();
  private readonly readOnlyEnforced: boolean;

  constructor(options: DevLeaseOptions = {}) {
    super();
    this.readOnlyEnforced = options.readOnlyEnforced === true;
  }

  /* The lock every existing action takes: an action that may write, so DEV is held alone. */
  override withLock<T>(account: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withLease(account, { mayWrite: true }, task, signal);
  }

  async withLease<T>(account: string, access: DevAccess, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const mode: Mode = access.mayWrite || !this.readOnlyEnforced ? "alone" : "shared";
    return super.withLock(
      account,
      async () => {
        const release = await this.gate.acquire(mode, account, signal);
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
