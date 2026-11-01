import type { GeneratorDeliverable, ReviewJudgment } from "../../domain/manifest-repository.ts";
import type { ReviewerVerdict } from "../../domain/verdict-validate.ts";

/** What a generator turn delivered: the submission its contract accepted, or the reason it delivered none, and the text it ended with. */
export interface GeneratorDelivery {
  answer?: Record<string, unknown>;
  noSubmission?: string;
  output: string;
}

export interface VerdictParserPort {
  /* With the run's specDir, a bare spec file name the agent reported resolves to the one suite spec of that name (suite-relative); without it, names are kept as reported. */
  readGenerator(delivery: GeneratorDelivery, specDir?: string): GeneratorDeliverable;
  /* The reviewer's accepted verdict, redacted and bounded for the record. */
  readReview(verdict: ReviewerVerdict): ReviewJudgment;
}
