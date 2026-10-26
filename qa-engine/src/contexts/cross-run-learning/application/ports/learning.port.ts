import type { RetrievedRule } from "@kernel/learned-rule.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { Sha } from "@kernel/sha.ts";
import type { RelevanceBias } from "../../domain/learning.ts";

export interface LearningPort {
  /** Off-path: a failure is logged and swallowed, never gates publish. */
  fold(outcome: RunOutcome): Promise<void>;
  /** relevance is optional enrichment — omitted (or every field absent) retrieves ungrounded, exactly as before this bias existed. */
  retrieve(sha: Sha, relevance?: RelevanceBias): Promise<RetrievedRule[]>;
}
