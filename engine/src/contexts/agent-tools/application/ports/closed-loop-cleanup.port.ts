/** What the loop asks of the run's cleanup: remove the data a namespace's calls created. */
export interface ClosedLoopCleanupPort {
  cleanup(specDir: string, opts: { namespace: string; signal?: AbortSignal }): Promise<void>;
}
