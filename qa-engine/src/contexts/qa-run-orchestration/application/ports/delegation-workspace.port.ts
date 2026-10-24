/*
 * The directory a sidekick works in. A delegation does not run in the run's working copy: it gets a copy of what it may read, of
 * its own, so that it can neither read what it should not nor write where a sibling or the suite is. What it wrote comes back by
 * one rule: the files its brief named as writable are copied into the working copy, read strictly, and everything else it
 * changed is listed as a proposal and never applied.
 */

export interface DelegationWorkspaceRequest {
  runId: string;
  delegationId: string;
  /* The run's working copy: where the read view is taken from and where the writable files go back to. */
  mirrorDir: string;
  /* The spec directory of the run, absolute and inside mirrorDir. */
  specDir: string;
  /* The spec directory as the repository sees it (`e2e`). */
  specRelDir: string;
  /* The repository-relative files the delegation may write: each is copied back, and nothing else is. */
  writablePaths: readonly string[];
}

export interface DelegationWorkspace {
  /* The directory the sidekick's session opens in. */
  dir: string;
  /* The spec directory inside it. */
  specDir: string;
  specRelDir: string;
  /* How many files the read view holds, and whether it was cut at its limits. */
  files: number;
  cut: boolean;
}

export const WORKSPACE_CHANGE = {
  ADDED: "added",
  MODIFIED: "modified",
  DELETED: "deleted",
} as const;
export type WorkspaceChangeKind = (typeof WORKSPACE_CHANGE)[keyof typeof WORKSPACE_CHANGE];

/* A change the delegation made to a file it was not given to write. It is information for the lead and is never applied. */
export interface WorkspaceChange {
  path: string;
  kind: WorkspaceChangeKind;
  bytes: number;
}

export interface RefusedCopy {
  path: string;
  reason: string;
}

export interface DelegationCollection {
  /* The writable files that were copied into the working copy, repository-relative. */
  copied: string[];
  /* The writable files that were there but could not be copied, and why. A writable file the delegation never made is neither. */
  refused: RefusedCopy[];
  /* What else changed in the workspace, capped, with the total beside it. */
  proposals: WorkspaceChange[];
  proposalsTotal: number;
}

export interface DelegationWorkspacePort {
  create(request: DelegationWorkspaceRequest): Promise<DelegationWorkspace>;
  /*
   * Copies one writable file to `probePath` in the working copy's probe directory (relative to the spec directory), so that the
   * orchestrator can execute it there while the sidekick is still authoring. The probe directory is swept by the run and nothing
   * under it is ever delivered. Absent in the workspace: false. Throws for a file that was not given to write and for a
   * destination outside the probe directory.
   */
  stage(workspace: DelegationWorkspace, request: DelegationWorkspaceRequest, path: string, probePath: string): Promise<boolean>;
  /* Takes the work back: every writable file into the working copy, the rest as proposals. */
  collect(workspace: DelegationWorkspace, request: DelegationWorkspaceRequest): Promise<DelegationCollection>;
  /*
   * Copies every writable file the working copy holds now into the workspace, read strictly (a link or a file outside the spec
   * directory is skipped), and takes those bytes as the workspace's own: only a change made after it goes back. For a correction
   * after the run changed a flow's spec since the sidekick wrote it. Returns the files refreshed.
   */
  refresh(workspace: DelegationWorkspace, request: DelegationWorkspaceRequest): Promise<string[]>;
  /* Removes the workspace. Never throws. */
  dispose(workspace: DelegationWorkspace): Promise<void>;
  /* Removes every workspace there is, those of earlier runs included (a crash or a restart leaves them). Returns how many. */
  sweepAll(): Promise<number>;
}
