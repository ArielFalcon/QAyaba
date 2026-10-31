/*
 * The run's working copy as the flow sees it: where the specs are, nothing more. The mirror root
 * and the commit stay with the adapter that issued the handle, so publication, confinement and gc can only act on
 * a working copy the run was given, never on a path a caller names.
 */
export interface WorkspaceHandle {
  readonly specDir: string;
}
