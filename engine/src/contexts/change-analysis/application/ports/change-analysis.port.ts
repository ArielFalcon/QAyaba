import type { ChangeEntry } from "@kernel/change-set.ts";
import type { CommitIntent } from "@kernel/commit-intent.ts";

export interface ChangeAnalysisPort {
  /**
   * Only "diff" mode calls classify. Returns the real per-run diff so generation
   * is not fed a stale static value. `intent` and `contradiction` are optional:
   * contradiction is set only when the message claimed no behavior change but
   * the diff escalated the action — never fabricated. An entry with a `baseSha`
   * or a `commits` count classifies that range; an entry with neither classifies headSha^..headSha.
   */
  classify(entry: ChangeEntry): Promise<{ action: "skip" | "regression" | "generate"; reason: string; diff: string; intent?: CommitIntent; contradiction?: boolean }>;
}
