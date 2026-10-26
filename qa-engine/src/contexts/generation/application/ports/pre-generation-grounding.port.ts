import type { GroundingChange } from "../pre-generation-grounding.ts";
import type { GroundingResult } from "../../domain/pre-generation-grounding.ts";

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
