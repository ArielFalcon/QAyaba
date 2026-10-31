import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";

/**
 * Compacts orphaned object packs on the mirror. Absent: no prune.
 * A thrown prune() MUST be caught by the caller, logged, and never alter the
 * verdict or block the run.
 */
export interface MirrorGcPort {
  prune(workspace: WorkspaceHandle): Promise<void>;
}
