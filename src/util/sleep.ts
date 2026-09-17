/* Resolves after `ms` or immediately when `signal` aborts — waits must never delay cancellation by a full interval. */

export function sleep(ms: number, opts?: { signal?: AbortSignal }): Promise<void> {
  const signal = opts?.signal;
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
