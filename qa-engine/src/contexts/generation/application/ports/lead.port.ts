import type { PlanOutput } from "@kernel/plan-output.ts";
import type { GenerationEnrichment } from "../../domain/generation-enrichment.ts";

export interface LeadPort {
  /**
   * The one turn a run asks the lead for a plan instead of specs. `enrichment.planning` carries the limits the plan
   * will be held to and is required. Absent: this port cannot plan, and the coordinator refuses the run (`cannot-plan`).
   */
  plan?(specDir: string, signal: AbortSignal | undefined, diff: string | undefined, enrichment: GenerationEnrichment): Promise<PlanOutput>;
}
