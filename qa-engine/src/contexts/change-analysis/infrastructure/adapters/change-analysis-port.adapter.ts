/* ChangeAnalysisPort → VcsReadPort + classifyRange. Returns the fetched diff (not a composition-time snapshot). Absent baseSha is single-commit; baseSha set is a range (max-severity action, head's own intent). */

import type { ChangeAnalysisPort } from "../../application/ports/change-analysis.port.ts";
import type { Sha } from "@kernel/sha.ts";
import type { ChangeEntry } from "@kernel/change-set.ts";
import type { CommitIntent } from "@kernel/commit-intent.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/index.ts";
import { classifyRange } from "@contexts/change-analysis/application/index.ts";

export class ChangeAnalysisPortAdapter implements ChangeAnalysisPort {
  constructor(private readonly vcs: VcsReadPort) {}

  private async ancestorOf(sha: Sha, n: number): Promise<Sha> {
    if (!this.vcs.ancestor) throw new Error(`the VCS read port cannot resolve ${sha.short}~${n}: a commit-count range needs ancestor()`);
    return this.vcs.ancestor(sha, n);
  }

  async classify(entry: ChangeEntry): Promise<{ action: "skip" | "regression" | "generate"; reason: string; diff: string; intent: CommitIntent; contradiction: boolean }> {
    const sha = entry.headSha;
    /* A commit count resolves to the base it spans, so the range path (other commits' messages) serves both options. */
    const baseSha = entry.baseSha ?? (entry.commits !== undefined ? await this.ancestorOf(sha, entry.commits) : undefined);
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
