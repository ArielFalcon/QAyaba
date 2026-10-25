/* ChangeAnalysisPort → VcsReadPort + classifyRange. Returns the fetched diff (not a composition-time snapshot). Absent baseSha is single-commit; baseSha set is a range (max-severity action, head's own intent). */

import type { Sha } from "@kernel/sha.ts";
import type { ChangeAnalysisPort, CommitIntent } from "../../application/ports/index.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/ports/index.ts";
import { classifyRange } from "@contexts/change-analysis/domain/commit-classification.ts";

export class ChangeAnalysisPortAdapter implements ChangeAnalysisPort {
  constructor(private readonly vcs: VcsReadPort) {}

  async classify(sha: Sha, opts?: { baseSha?: Sha }): Promise<{ action: "skip" | "regression" | "generate"; reason: string; diff: string; intent: CommitIntent; contradiction: boolean }> {
    const baseSha = opts?.baseSha;
    /* Absent otherMessages → [] (single-commit classification). */
    const [message, diff, otherMessages] = await Promise.all([
      this.vcs.message(sha),
      this.vcs.diff(sha, baseSha ? { baseSha } : undefined),
      baseSha && this.vcs.otherMessages ? this.vcs.otherMessages(sha, { baseSha }) : Promise.resolve<string[]>([]),
    ]);
    /* Same fetched diff, intent, and contradiction — never re-derived. Range path uses the head commit's intent. */
    const classification = classifyRange(message, otherMessages, diff);
    return {
      action: classification.action,
      reason: classification.reason,
      diff,
      intent: {
        type: classification.type,
        breaking: classification.breaking,
        message: classification.message,
        body: classification.body,
        changedFiles: classification.changedFiles,
      },
      contradiction: classification.contradiction,
    };
  }
}
