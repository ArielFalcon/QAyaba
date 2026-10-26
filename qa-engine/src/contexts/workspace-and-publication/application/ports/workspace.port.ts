import type { Sha } from "@kernel/sha.ts";
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";

export interface WorkspacePort {
  /** Checks out the commit and returns the run's handle to it; every later git-write seam takes that handle. */
  prepare(sha: Sha): Promise<WorkspaceHandle>;
  /**
   * The roots the confined readers need (the mirror root the spec directory is confined under, and the spec directory). Read-side
   * only: no write seam accepts these paths, a handle issued by this adapter is the only way to publish, confine or prune.
   * Throws for a handle this adapter did not issue.
   */
  readRoots(workspace: WorkspaceHandle): { mirrorDir: string; specDir: string };
}
