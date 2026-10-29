import type { ReviewPort } from "@contexts/generation/application/index.ts";

/*
 * The findings filter decides what a rejection stands on: a blocking finding counts only when it cites evidence the
 * run holds. A fake reviewer that rejects without citing anything is dropped as advisory, so a test that is about what
 * a standing rejection does wraps its reviewer here: every uncited rejection cites the execution of the first case
 * with a spec file the review was asked about. A review that already states its severities and citations (or approves) is returned as it is.
 */
export function citingRejections(review: ReviewPort["review"]): ReviewPort["review"] {
  return async (specDir, cases, diff, enrichment) => {
    const result = await review(specDir, cases, diff, enrichment);
    if (result.approved || result.citations !== undefined || result.corrections.length === 0) return result;
    const ref = cases.find((c) => c.file !== undefined)?.file ?? "a.spec.ts";
    return {
      ...result,
      severities: result.corrections.map(() => "blocking" as const),
      citations: result.corrections.map(() => ({ kind: "execution" as const, ref })),
    };
  };
}
