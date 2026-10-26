/**
 * Reviewer's live-DEV DOM snapshot, keyed on just-generated specs' routes.
 * Caller re-invokes per round so a regenerated set is re-captured. Absent:
 * reviewer defers on unverifiable UI facts. Adapter must never throw.
 */
export interface ReviewDomGroundingPort {
  capture(specDir: string, specs: readonly string[], signal?: AbortSignal): Promise<string | undefined>;
}
