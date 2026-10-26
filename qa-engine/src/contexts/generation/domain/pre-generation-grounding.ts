import type { GroundingOmission, ArchitectureContext, HarnessFacts } from "@kernel/grounding.ts";

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
}
