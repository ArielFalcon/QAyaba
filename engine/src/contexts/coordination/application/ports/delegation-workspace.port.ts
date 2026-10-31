import type { DelegationCollection, DelegationWorkspace, DelegationWorkspaceRequest } from "../../domain/delegation-workspace.ts";

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
