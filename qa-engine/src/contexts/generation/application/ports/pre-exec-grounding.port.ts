/**
 * Post-generate capture of on-disk spec text plus live route trees.
 * Re-reads specs on every call so a re-check after regen sees rewritten specs.
 * RouteTree is duck-typed locally (no cross-context import). Absent: the
 * pre-exec gate is skipped and related gateSignals stay the number 0, not
 * undefined. Adapter must not throw.
 * The sources are read through the confined reader: a spec that is not a regular
 * file inside the spec directory reads as "", never as what a link it planted
 * points at. `specFiles` names each source, relative to the spec directory and
 * index-aligned with `specSources`.
 */
export interface PreExecGroundingPort {
  capture(specDir: string, signal?: AbortSignal): Promise<{
    specFiles: string[];
    specSources: string[];
    routes: {
      route: string;
      nodes: string[];
      status?: "captured" | "degraded";
      settled?: boolean;
      testIds?: Map<string, number>;
    }[];
  }>;
}
