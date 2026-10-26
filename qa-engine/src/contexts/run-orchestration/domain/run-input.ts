import type { Sha } from "@kernel/sha.ts";
import type { ChangeSet } from "@kernel/change-set.ts";
import type { TriggerSource, RunMode, TestTarget, RunPurpose } from "@kernel/run-mode.ts";

/** Single input → RunOutcome. Production implementation is RunPipelineAdapter. */
export interface RunInput {
  app: string;
  /** Every repo the run reads. `sha`, `baseSha` and `triggerRepo` below are the projection of its anchor entry (`anchorProjection`). */
  changeSet: ChangeSet;
  sha: Sha;
  source: TriggerSource;
  mode: RunMode;
  target: TestTarget;
  guidance?: string;
  runId: string;
  /**
   * Set when a SERVICE-repo webhook triggered this run. Browser coverage cannot
   * map that repo's changed lines, so change-coverage stays "unknown" (unknown
   * never blocks publish). Absent is an ordinary same-repo run.
   */
  triggerRepo?: string;
  /**
   * Prior interrupted run's test-data namespace. Cleanup runs only when this is
   * set (prior run was still running/enqueued, or ended infra-error).
   */
  previousNamespace?: string;
  /**
   * When set, classification spans baseSha..sha (a PR/push range). Absent is
   * single-commit classification (sha^..sha).
   */
  baseSha?: Sha;
  /**
   * Continuation provenance from the /continue API only. Absent is never
   * fabricated. Intra-run regenerations reuse this same input object.
   */
  parentRunId?: string;
  /** Why the run was started, when it is not a change to test (see RUN_PURPOSE). Recorded on the persisted note; never read by a verdict. */
  purpose?: RunPurpose;
  /** The run's own choice about the run_spec loop (an A/B arm), overriding the app's setting. Absent: the app's setting decides. */
  closedLoop?: boolean;
  /** The run's own choice about the authenticated agent browser (an A/B arm), overriding the app's setting. Absent: the app's setting decides. */
  agentBrowser?: boolean;
}
