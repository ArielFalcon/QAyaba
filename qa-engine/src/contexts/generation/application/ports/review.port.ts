import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewEnrichment } from "../../domain/review-enrichment.ts";
import type { ReviewStats } from "../../domain/review.ts";

export interface ReviewPort {
  /**
   * `diff` is the real per-run commit diff; absent falls back to the adapter's
   * static ctx.diff. `enrichment` is independently absent-safe.
   */
  review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): Promise<{
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
    /* The reviewer's own severity per correction, and the evidence it cites, in the same order. */
    severities?: ("blocking" | "advisory")[];
    citations?: ({ kind: "contract" | "execution" | "dom"; ref: string } | undefined)[];
    /**
     * True when no judgment was possible because the reviewer's runtime failed or returned nothing: an
     * integration fault, which is neither an approval nor a rejection. Absent on every review that
     * reached a reviewer's answer, including an unreadable one (a parse miss).
     */
    unavailable?: boolean;
    /** What the turn cost. Absent when the port never opened a reviewer session. */
    stats?: ReviewStats;
  }>;
}
