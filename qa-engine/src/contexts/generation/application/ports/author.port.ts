import type { GenerationEnrichment } from "../../domain/generation-enrichment.ts";
import type { GenerationOutput } from "../../domain/generation.ts";

export interface AuthorPort {
  /**
   * One turn of an author sidekick over the whole of a run's authoring: a first pass the plan does not cover and every regeneration.
   * `signal` interrupts the turn on cancel. `diff` is the real per-run commit diff (diff mode only); absent falls back to the
   * adapter's static per-run value. `enrichment` is independently absent-safe. Each turn opens a session of its own.
   */
  author(specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationOutput>;
}
