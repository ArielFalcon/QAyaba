import type { ChangePageBasis, ChangePagesJoin } from "@kernel/change-pages.ts";
import type { ArchitectureContext, GroundingOmission, HarnessFacts } from "@kernel/grounding.ts";
import type { CrossRepoImpact, ServiceLink } from "@contexts/service-topology/application/index.ts";

export interface GroundingResult {
  /** Assembled context-pack text. Absent when the pack build failed or produced nothing. */
  contextPack?: string;
  /** The pack's delivered grounding ids and omissions, computed from the kept lines (packDeliveredItemIds). Threaded with the pack text so the prompt's delivered span is read from the assembly. */
  contextPackItemIds?: readonly string[];
  contextPackOmissions?: readonly GroundingOmission[];
  /**
   * On-disk spec paths enumerated before the first generate(). Absent/empty when
   * the e2e dir does not exist yet or enumeration failed (fail-open).
   */
  existingSpecFiles?: string[];
  /** ArchitectureContext from specDir/.qa/context.json. Absent when missing/invalid (fail-open). */
  contextMap?: ArchitectureContext;
  /** Facts about the suite's harness (the configured test-id attribute, what the fixtures file exports). Absent when nothing was configured or scannable (fail-open). */
  harnessFacts?: HarnessFacts;
  /** The added labels whose changed-value line in the pack said more nodes than unchanged lines of the file. Absent when none did, or when no pack carries such lines. */
  changedValuesWithMoreNodes?: string[];
  /** The pages the pack read with results (> 0) under the app's declared data state, by pathname. Absent when it read none. */
  packConfirmedDataRoutes?: { path: string; resultCount: number }[];
  /** The pages of the app's map the change is linked to, in rank order: the map's own links, then the pages the call graph proved. Absent when none is. */
  changeRoutes?: string[];
  /** Why each change page is one, parallel to `changeRoutes`. */
  changeRouteBasis?: ChangePageBasis[];
  /** What the change-page join over the call graph found (its proofs, hubs and disagreements). Absent when no index answered. */
  changePages?: ChangePagesJoin;
}

/** What the change-page join needs beyond the map: the change, and on a cross-repo run the stitcher's links as they are. */
export interface GroundingChange {
  sha: string;
  serviceLinks?: readonly ServiceLink[];
  crossRepoImpact?: CrossRepoImpact | null;
}

/**
 * Pre-generate first-write grounding (DOM/route/context pack), run once after
 * setup and before the initial generate(). Distinct from PreExecGroundingPort
 * (post-generate corrective gate) and ReviewDomGroundingPort (review-time
 * snapshot keyed on generated specs). Absent: generation falls back to live-MCP
 * exploration. Adapter must never throw — capture/build failure degrades to an
 * absent field (fail-open).
 */
export interface PreGenerationGroundingPort {
  /**
   * Optional `diff` (diff mode only) for deterministic [CHANGED] markers.
   * Absent is unchanged.
   */
  ground(specDir: string, signal?: AbortSignal, diff?: string, change?: GroundingChange): Promise<GroundingResult>;
}
