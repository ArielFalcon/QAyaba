import type { GeneratorDeliverable, ReviewJudgment } from "../../domain/manifest-repository.ts";

export interface VerdictParserPort {
  /* With the run's specDir, a bare spec file name the agent reported resolves to the one suite spec of that name (suite-relative); without it, names are kept as reported. */
  parseGenerator(text: string, specDir?: string): GeneratorDeliverable;
  parseReview(text: string): ReviewJudgment;
}
