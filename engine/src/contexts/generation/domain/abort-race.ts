/* Race a collaborator that has no native AbortSignal (buildContextPack / captureDom) against abort. On abort the returned promise rejects immediately with AbortError so the adapter unblocks; the underlying render keeps running to its own timeout in the background and its result is discarded. Killing the spawn tree is out of scope for these thin adapters. */

export class AbortRaceError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof AbortRaceError || (err instanceof Error && err.name === "AbortError");
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortRaceError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortRaceError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
