/* Who hears what the host did to the process. HostHealth notifies every registered listener; the active run's root span registers itself for the length of the run (RunTrace), and the active agent-turn span can do the same. A set, not a single slot, so the run and a turn hear the same event. A listener that throws never silences the others and never reaches the notifier. */

export interface HostEventListener {
  /* The process was frozen for `ms` while wall time moved. `at` is wall-clock ms when it was noticed. */
  hostSuspended(ms: number, at: number): void;
  /* The event loop was blocked for about `ms`. */
  eventLoopBlocked(ms: number, at: number): void;
  /* The largest event-loop delay of the window that just closed, in ms (called for every sample, blocked or not). */
  eventLoopObserved(maxMs: number): void;
}

export class HostListeners {
  private readonly listeners = new Set<HostEventListener>();

  /* Returns the function that removes it; calling it twice is harmless. */
  add(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  size(): number {
    return this.listeners.size;
  }

  /* Calls `fn` on every listener, isolating each from the others' faults. */
  notify(fn: (listener: HostEventListener) => void): void {
    for (const listener of [...this.listeners]) {
      try {
        fn(listener);
      } catch (error) {
        console.error(`[host-health] a listener failed and was skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/* The process-wide set: HostHealth and RunTrace default to it. */
export const hostListeners = new HostListeners();
