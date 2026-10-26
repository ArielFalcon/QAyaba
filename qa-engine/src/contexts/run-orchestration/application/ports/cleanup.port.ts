/**
 * Orphan test-data cleanup for a PRIOR interrupted run. Fires only when
 * previousNamespace is set, e2e-only, before this run's generation. Failure is
 * best-effort: never alters this run's verdict. baseUrl/testIdAttribute live
 * on the adapter, not this signature.
 */
export interface CleanupPort {
  cleanup(specDir: string, opts: { namespace: string; signal?: AbortSignal }): Promise<void>;
}
