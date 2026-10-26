/* Removes the test data a namespace left on DEV. Best effort: never throws. */
export interface SpecCleanupPort {
  cleanup(namespace: string, signal?: AbortSignal): Promise<void>;
}
