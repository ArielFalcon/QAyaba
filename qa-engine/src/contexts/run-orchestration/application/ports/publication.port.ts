import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";

export interface PublicationPort {
  /**
   * Per-run values override composition-time ctx. Absent falls back to static
   * ctx. When present, a green-but-reviewer-rejected run routes to an Issue,
   * and an enforce-mode coverage failure holds the PR.
   */
  publish(decision: {
    verdict: RunVerdict;
    cases: readonly QaCase[];
    logs: string;
    reviewerApproved?: boolean;
    coverageBlocks?: boolean;
    e2eChanged?: boolean;
    /**
     * Cross-repo Issue routing. Absent falls back to ctx.repo. PR creation
     * always targets ctx.repo (the primary), regardless of this field.
     */
    issueRepo?: string;
    /**
     * FixLoop's last adjudicator verdict. Present only when FixLoop reached
     * adjudicate(); a clean first-try pass has none. Strings, not domain unions:
     * the adapter renders them as text and never branches on them.
     */
    adjudication?: { class: string; confidence: string; reason: string };
    /**
     * Threaded only for a reviewer-unavailable fail-closed exit — never for a
     * genuine rejection (corrections already signal that).
     */
    reviewerNote?: string;
    /**
     * The run's working copy, for the "pr" route's git-write: the adapter reads the mirror, the commit and the target from the
     * handle it issued, so no path comes from the caller. Absent on an actual "pr" route with a required vcsWrite collaborator is a
     * composition defect: the adapter throws rather than skip the write (fail-closed). A handle the adapter did not issue throws.
     */
    workspace?: WorkspaceHandle;
    /** Agent "what was tested" evidence. Absent omits the section; never throws. */
    tested?: { flow?: string; objective?: string }[];
    /** Continuation provenance. Absent: no continuation reference rendered. */
    parentRunId?: string;
  }): Promise<{
    outcome: string;
    /**
     * Tracked-file denylist reverts from the "pr" git-write, merged into
     * gateSignals.confinement. Absent on every route that never reaches "pr".
     */
    revertedDenylisted?: string[];
    /**
     * Subset of revertedDenylisted matching the secret tier. Counted toward
     * gateSignals.confinement.dangerous — not every revert is a secret leak.
     */
    revertedDangerous?: string[];
  }>;
}
