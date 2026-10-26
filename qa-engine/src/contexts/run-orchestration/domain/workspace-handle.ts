/*
 * The run's working copy as the flow sees it: where the specs are and which kind of suite it holds, nothing more. The mirror root,
 * the commit and the target flag stay with the adapter that issued the handle, so publication, confinement and gc can only act on
 * a working copy the run was given, never on a path a caller names.
 */
export type WorkspaceKind = "e2e" | "code";

export interface WorkspaceHandle {
  readonly specDir: string;
  readonly kind: WorkspaceKind;
}
