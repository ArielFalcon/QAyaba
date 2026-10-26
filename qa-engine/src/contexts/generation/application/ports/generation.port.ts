import type { PlanOutput } from "@kernel/plan-output.ts";
import type { GenerationEnrichment } from "../generation.ts";
import type { GenerationOutput } from "../../domain/generation.ts";

export interface GenerationPort {
  /**
   * `signal` interrupts in-flight generation on cancel. `diff` is the real
   * per-run commit diff (diff mode only); absent falls back to the adapter's
   * static per-run value. `enrichment` is independently absent-safe.
   */
  generate(specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationOutput>;
  /**
   * The one turn a coordinated run asks the lead for a plan instead of specs. `enrichment.planning` carries the limits the plan
   * will be held to and is required. Absent: this port cannot plan, and a coordinated run authors the change as one piece of work.
   */
  plan?(specDir: string, signal: AbortSignal | undefined, diff: string | undefined, enrichment: GenerationEnrichment): Promise<PlanOutput>;
  /** Ends the generator session the run kept for its regenerations. Called once when the run ends, however it ends. Absent: this port keeps no session. */
  release?(): Promise<void>;
}
